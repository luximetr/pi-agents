import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { DiscoveredAgent, McpServerConfig } from "./agents.ts";

/** Only environment references in HTTP headers are credentials managed by Studio. */
export function credentialVariables(config: McpServerConfig | undefined): string[] {
	if (!config?.url) return [];
	return [...new Set(Object.values(config.headers ?? {}).flatMap(value =>
		[...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match => match[1]!)))];
}

/** Preserve unrelated entries; replace every duplicate so the last value cannot override us. */
export function updateCredential(content: string, key: string, value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !value || /[\x00-\x1f\x7f]/.test(value)) {
		throw new Error("Enter a non-empty, single-line credential without control characters.");
	}
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const entry = `${key}="${value}"`;
	const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
	let found = false;
	const lines = content.split(/\r?\n/).map(line => {
		if (!pattern.test(line)) return line;
		found = true;
		return entry;
	});
	const result = lines.join(eol);
	return found ? result : result + (result && !result.endsWith(eol) ? eol : "") + entry + eol;
}

export function saveCredential(dir: string, key: string, value: string): string {
	const file = path.join(dir, ".env");
	// Validate before any filesystem changes.
	updateCredential("", key, value);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const name of [".env", ".gitignore"]) {
		try {
			if (!fs.lstatSync(path.join(dir, name)).isFile()) throw new Error("Credential files must be regular files, not symlinks.");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	let inGit = false;
	try { execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { stdio: "pipe" }); inGit = true; } catch {}
	if (inGit) {
		const tracked = execFileSync("git", ["-C", dir, "ls-files", "--", ".env"], { encoding: "utf8" });
		if (tracked.trim()) throw new Error("The .env file is tracked by Git. Untrack it before saving credentials.");
	}
	const ignoreFile = path.join(dir, ".gitignore");
	const ignore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, "utf8") : "";
	if (ignore.trimEnd().split(/\r?\n/).at(-1) !== "/.env") fs.appendFileSync(ignoreFile, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}/.env\n`);
	const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
	const next = updateCredential(content, key, value);
	if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
	fs.writeFileSync(file, next, { mode: 0o600 });
	return file;
}

/** Never render the Input itself: even paste and undo buffers remain masked. */
export async function promptCredential(ctx: ExtensionContext, title: string): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("Masked credential entry requires TUI mode. Configure the agent directory’s .env manually.", "warning");
		return undefined;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
		const input = new Input();
		input.onSubmit = value => done(value || undefined);
		input.onEscape = () => done(undefined);
		return {
			render: (width: number) => [
				truncateToWidth(theme.fg("accent", title), width),
				truncateToWidth(`> ${"*".repeat(Math.min(input.getValue().length, Math.max(0, width - 3)))}`, width),
				truncateToWidth("Enter: save · Esc: cancel · empty: unchanged", width),
			],
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("c"))) done(undefined);
				else input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export async function configureCredentials(ctx: ExtensionContext, servers: Record<string, McpServerConfig>, agent: DiscoveredAgent, trusted: boolean): Promise<boolean | void> {
	if (agent.source === "project" && !trusted) {
		ctx.ui.notify("Trust this project before saving agent credentials.", "warning");
		return;
	}
	const names = Object.keys(servers).filter(name => credentialVariables(servers[name]).length).sort();
	if (!names.length) { ctx.ui.notify("No HTTP header environment references to configure.", "info"); return; }
	const name = await ctx.ui.select("Configure MCP credentials", names);
	if (!name) return;
	const variables = credentialVariables(servers[name]);
	const key = variables.length === 1 ? variables[0] : await ctx.ui.select("Credential variable", variables);
	if (!key) return;
	const dir = agent.dir;
	if (!await ctx.ui.confirm(`Save ${key} for ${agent.name}?`, `Stores plaintext in ${path.join(dir, ".env")}, separate from agent drafts. Existing value will be replaced. Shell values may take precedence.`)) return;
	const value = await promptCredential(ctx, `${name} · ${key} (token only, no Bearer prefix)`);
	if (value === undefined) return;
	try {
		const file = saveCredential(dir, key, value);
		ctx.ui.notify(`Credential saved to ${file}.`, "info");
		return true;
	} catch (error) {
		// Do not include filesystem/input error details that could contain a secret.
		ctx.ui.notify(error instanceof Error && ["Enter a non-empty", "The .env file is tracked", "Credential files must"].some(prefix => error.message.startsWith(prefix)) ? error.message : "Could not save credential. Check directory permissions and Git configuration.", "error");
	}
}
