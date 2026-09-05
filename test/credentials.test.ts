import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { credentialVariables, updateCredential, saveCredential, promptCredential } from "../credentials.ts";
import { parseEnvFile, BUILTIN_MCP_SERVERS } from "../agents.ts";

assert.deepEqual(credentialVariables(BUILTIN_MCP_SERVERS.dochub), ["DOCHUB_TOKEN"]);
assert.deepEqual(credentialVariables(BUILTIN_MCP_SERVERS.designhub), ["DESIGNHUB_TOKEN"]);
assert.deepEqual(credentialVariables({ command: "node" }), []);
const updated = updateCredential('# comment\r\nOTHER=keep\r\nexport TOKEN=old\r\nTOKEN=duplicate\r\n', "TOKEN", 'a"b#c=\\$');
assert.equal(parseEnvFile(updated).TOKEN, 'a"b#c=\\$');
assert.ok(updated.startsWith('# comment\r\nOTHER=keep\r\n'));
assert.equal(parseEnvFile(updateCredential("OTHER=keep", "TOKEN", "test")).OTHER, "keep");
for (const value of ["", "a\nb", "a\rb", "\0"]) assert.throws(() => updateCredential("", "TOKEN", value));
assert.throws(() => updateCredential("", "BAD=KEY", "test"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-credentials-"));
try {
	execFileSync("git", ["init", dir], { stdio: "pipe" });
	const file = saveCredential(dir, "TOKEN", "first");
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(execFileSync("git", ["-C", dir, "check-ignore", ".env"], { encoding: "utf8" }).trim(), ".env");
	fs.appendFileSync(file, "OTHER=keep\n");
	saveCredential(dir, "TOKEN", "second");
	assert.deepEqual(parseEnvFile(fs.readFileSync(file, "utf8")), { TOKEN: "second", OTHER: "keep" });
	execFileSync("git", ["-C", dir, "add", "-f", ".env"]);
	assert.throws(() => saveCredential(dir, "TOKEN", "third"), /tracked/);
	execFileSync("git", ["-C", dir, "rm", "--cached", ".env"], { stdio: "pipe" });
	fs.unlinkSync(file);
	fs.writeFileSync(path.join(dir, "target"), "untouched");
	fs.symlinkSync(path.join(dir, "target"), file);
	assert.throws(() => saveCredential(dir, "TOKEN", "third"), /regular files/);
	assert.equal(fs.readFileSync(path.join(dir, "target"), "utf8"), "untouched");
} finally { fs.rmSync(dir, { recursive: true, force: true }); }

async function inputTest(data: string[], expected: string | undefined) {
	let result: string | undefined;
	await promptCredential({ mode: "tui", ui: { custom: async (factory: any) => {
		const component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, {}, (value: string | undefined) => { result = value; });
		for (const chunk of data) {
			component.handleInput(chunk);
			for (const width of [1, 10, 80]) {
				const lines = component.render(width);
				assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
				assert.ok(!lines.join("\n").includes("secret-token"));
			}
		}
		return result;
	} } } as any, "Token");
	assert.equal(result, expected);
}
await inputTest(["\x1b[200~secret-token\x1b[201~", "\r"], "secret-token");
await inputTest(["secret-token", "\x1b"], undefined);
await inputTest(["\r"], undefined);
console.log("credentials tests passed");
