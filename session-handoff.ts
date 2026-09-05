import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentOverride } from "./agents.ts";

export interface SessionHandoff {
	name: string | null;
	model?: { provider: string; id: string };
	thinkingLevel?: ReturnType<ExtensionAPI["getThinkingLevel"]>;
	drafts: Record<string, AgentOverride>;
}

// Pi replaces extension instances on /new. Keep only a one-shot, same-process
// handoff, not a disk preference or environment variable inherited by children.
const key = Symbol.for("pi-agents.new-session-handoffs");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, SessionHandoff> };
const handoffs = shared[key] ??= new Map<string, SessionHandoff>();
const sessionKey = (cwd: string, file?: string) => JSON.stringify([cwd, file ?? null]);

export function storeSessionHandoff(cwd: string, file: string | undefined, state: SessionHandoff): void {
	handoffs.set(sessionKey(cwd, file), structuredClone(state));
}

export function takeSessionHandoff(cwd: string, file: string | undefined): SessionHandoff | undefined {
	const key = sessionKey(cwd, file);
	const state = handoffs.get(key);
	handoffs.delete(key);
	return state;
}
