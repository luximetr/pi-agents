import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { RunningSubagentHandle, SubagentSnapshot, SubagentStopReason } from "./subagents.ts";

export const OBSERVER_ENV = "PI_AGENTS_OBSERVER_SOCKET";
export const RUN_ID_ENV = "PI_AGENTS_RUN_ID";
const MAX_FRAME = 2_000_000;
const MAX_RETAINED_TRANSCRIPTS = 100;

export function isActiveRun(snapshot: SubagentSnapshot): boolean {
	return snapshot.status === "running" || snapshot.status === "stopping";
}

type Control = { type: "stop"; id: string; reason: SubagentStopReason } | { type: "steer"; id: string; message: string };

function send(socket: Socket | undefined, message: unknown): boolean {
	if (!socket || socket.destroyed || !socket.writable || socket.writableLength > MAX_FRAME * 2) return false;
	try {
		socket.write(`${JSON.stringify(message)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Strict LF framing; setEncoding preserves split UTF-8 code points. */
function receive(socket: Socket, onMessage: (message: any) => void) {
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("error", () => { /* close handles owner loss; never crash the host TUI */ });
	socket.on("data", chunk => {
		buffer += chunk;
		let newline: number;
		while ((newline = buffer.indexOf("\n")) !== -1) {
			if (newline > MAX_FRAME) { socket.destroy(); return; }
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			try { onMessage(JSON.parse(line)); } catch { socket.destroy(); return; }
		}
		if (buffer.length > MAX_FRAME) socket.destroy();
	});
}

/**
 * One private, session-scoped broker at the root. Each parent owns its child RPC
 * pipe; descendants publish snapshots and receive controls over this side channel.
 * No transcripts, credentials or model context are written to disk.
 */
export class SubagentObserver {
	private snapshots = new Map<string, SubagentSnapshot>();
	private local = new Map<string, RunningSubagentHandle>();
	private owners = new Map<string, Socket>();
	private peers = new Set<Socket>();
	private cancelled = new Map<string, SubagentStopReason>();
	private dirty = new Set<string>();
	private client?: Socket;
	private server?: Server;
	private directory?: string;
	private endpoint?: string;
	private starting?: Promise<string>;
	private timer?: NodeJS.Timeout;
	private closing = false;
	private changed = false;

	constructor(private inheritedEndpoint?: string, private onChange?: () => void) {}

	/** Lazy: never create background resources in the extension factory. */
	start(): Promise<string> {
		if (this.closing) return Promise.reject(new Error("Agent Explorer is shutting down"));
		return this.starting ??= this.connect();
	}

	private async connect(): Promise<string> {
		if (this.inheritedEndpoint) {
			this.endpoint = this.inheritedEndpoint;
			const socket = this.client = createConnection(this.endpoint);
			receive(socket, command => {
				if (!command || typeof command.id !== "string") return;
				const handle = this.local.get(command.id);
				if (command.type === "stop" && ["user", "parent", "session", "timeout"].includes(command.reason)) handle?.stop(command.reason);
				if (command.type === "steer" && typeof command.message === "string") handle?.steer(command.message);
			});
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => { socket.destroy(); reject(new Error("Agent Explorer connection timed out")); }, 2000);
				socket.once("connect", () => { clearTimeout(timer); resolve(); });
				socket.once("error", error => { clearTimeout(timer); reject(error); });
			});
			socket.unref();
		} else {
			this.directory = await mkdtemp(path.join(os.tmpdir(), "pi-runs-"));
			await chmod(this.directory, 0o700);
			this.endpoint = path.join(this.directory, "observer.sock");
			this.server = createServer(socket => {
				this.peers.add(socket);
				socket.unref();
				receive(socket, message => {
					const snapshot = message?.snapshot as SubagentSnapshot | undefined;
					if (message?.type !== "snapshot" || !snapshot || typeof snapshot.id !== "string" || typeof snapshot.agent !== "string"
						|| !["running", "stopping", "finished", "failed"].includes(snapshot.status) || !Array.isArray(snapshot.recentEvents)) return;
					// A run cannot be claimed by another connection or replace a local run.
					if (this.local.has(snapshot.id) || (this.owners.has(snapshot.id) && this.owners.get(snapshot.id) !== socket)) return;
					this.owners.set(snapshot.id, socket);
					this.accept(snapshot);
					const reason = this.cancelReason(snapshot.id);
					if (reason && isActiveRun(snapshot)) send(socket, { type: "stop", id: snapshot.id, reason });
				});
				socket.on("close", () => {
					this.peers.delete(socket);
					for (const [id, owner] of this.owners) {
						if (owner !== socket) continue;
						this.owners.delete(id);
						const snapshot = this.snapshots.get(id)!;
						if (isActiveRun(snapshot)) this.accept({ ...snapshot, status: "failed", endedAt: Date.now(), phase: "owner disconnected; final state unavailable" });
					}
				});
			});
			try {
				await new Promise<void>((resolve, reject) => {
					this.server!.once("error", reject);
					this.server!.listen(this.endpoint!, resolve);
				});
			} catch (error) {
				await rm(this.directory, { recursive: true, force: true });
				throw error;
			}
			this.server.unref();
		}
		this.timer = setInterval(() => this.flush(), 250);
		this.timer.unref();
		return this.endpoint!;
	}

	private accept(snapshot: SubagentSnapshot) {
		const previous = this.snapshots.get(snapshot.id);
		if (!previous || previous.status !== snapshot.status) this.changed = true;
		this.snapshots.set(snapshot.id, snapshot);
		// Deadlines/parent aborts originate in the runner, not necessarily the UI.
		if (snapshot.stopReason && !this.cancelled.has(snapshot.id)) this.stopTree(snapshot.id, snapshot.stopReason);
		// Retain the entire tree, but bound heavy historical transcripts globally.
		const completed = [...this.snapshots.values()].filter(run => !isActiveRun(run) && run.transcript?.length)
			.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
		for (const run of completed.slice(0, Math.max(0, completed.length - MAX_RETAINED_TRANSCRIPTS))) {
			this.snapshots.set(run.id, { ...run, transcript: [], transcriptTruncated: true, partialText: "", recentEvents: [] });
		}
	}

	attach(handle: RunningSubagentHandle) { this.local.set(handle.id, handle); }

	/** Called at most a few times per second by the runner, plus final state. */
	publish(snapshot: SubagentSnapshot) {
		this.accept(snapshot);
		if (this.client) {
			this.dirty.add(snapshot.id);
			if (!isActiveRun(snapshot)) this.flush();
		}
		if (!isActiveRun(snapshot)) this.local.delete(snapshot.id);
	}

	private flush() {
		for (const id of this.dirty) {
			if (send(this.client, { type: "snapshot", snapshot: this.snapshots.get(id) })) this.dirty.delete(id);
		}
		if (this.changed) { this.changed = false; this.onChange?.(); }
	}

	private cancelReason(id: string): SubagentStopReason | undefined {
		const seen = new Set<string>();
		while (id && !seen.has(id)) {
			seen.add(id);
			const reason = this.cancelled.get(id);
			if (reason) return reason;
			id = this.snapshots.get(id)?.parentRunId ?? "";
		}
		return this.closing ? "session" : undefined;
	}

	private control(command: Control): boolean {
		const snapshot = this.snapshots.get(command.id);
		if (!snapshot || !isActiveRun(snapshot)) return false;
		const local = this.local.get(command.id);
		if (local) {
			if (command.type === "steer") return local.steer(command.message);
			local.stop(command.reason);
			return true;
		}
		return send(this.owners.get(command.id), command);
	}

	stopTree(id: string, reason: SubagentStopReason = "user") {
		this.cancelled.set(id, reason);
		// Descendants first, before a parent can close their observation connection.
		for (const run of [...this.snapshots.values()].reverse()) {
			let ancestor: SubagentSnapshot | undefined = run;
			const seen = new Set<string>();
			while (ancestor && !seen.has(ancestor.id)) {
				if (ancestor.id === id) {
					this.control({ type: "stop", id: run.id, reason: run.id === id ? reason : "parent" });
					break;
				}
				seen.add(ancestor.id);
				ancestor = this.snapshots.get(ancestor.parentRunId ?? "");
			}
		}
	}

	handles(): RunningSubagentHandle[] {
		return [...this.snapshots.values()].map(snapshot => ({
			id: snapshot.id,
			snapshot: () => this.snapshots.get(snapshot.id) ?? snapshot,
			stop: reason => this.stopTree(snapshot.id, reason),
			steer: message => this.control({ type: "steer", id: snapshot.id, message }),
		}));
	}

	/** Stop owners before removing the socket; bounded even if a process is wedged. */
	async shutdown(gracefulStopSeconds = 5) {
		if (this.closing) return;
		this.closing = true;
		if (this.starting) await this.starting.catch(() => {});
		// Deepest/newest runs tend to be inserted last. Stop them before the
		// owning parent process can exit and sever their control path.
		for (const run of [...this.snapshots.values()].reverse()) this.control({ type: "stop", id: run.id, reason: "session" });
		const deadline = Date.now() + gracefulStopSeconds * 2000 + 500;
		while ([...this.snapshots.values()].some(isActiveRun) && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 25));
		}
		this.flush();
		if (this.timer) clearInterval(this.timer);
		if (this.client) {
			// end() flushes the final snapshots before signalling owner disconnect.
			const client = this.client;
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => { client.destroy(); resolve(); }, 250);
				client.end(() => { clearTimeout(timer); client.destroy(); resolve(); });
			});
		}
		for (const peer of this.peers) peer.destroy();
		if (this.server?.listening) await new Promise<void>(resolve => this.server!.close(() => resolve()));
		if (this.directory) await rm(this.directory, { recursive: true, force: true });
	}
}

export function newRunId(): string { return randomUUID(); }
