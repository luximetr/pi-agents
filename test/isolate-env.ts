// Tests run inside pi subagents too. Inherited PI_AGENTS_* variables (observer
// socket, run ID, root session, depth) would attach test fixtures to the live
// parent session. Import this first in every test file.
for (const key of Object.keys(process.env)) if (key.startsWith("PI_AGENTS_")) delete process.env[key];
