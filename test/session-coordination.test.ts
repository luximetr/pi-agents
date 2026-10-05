import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionCoordination, type CoordinationOptions } from "../session-coordination.ts";

function fixture(t: { after: (callback: () => void) => void }) {
	const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pi-session-coordination-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const projectCwd = path.join(base, "project");
	mkdirSync(projectCwd);
	const options: CoordinationOptions = { projectCwd, rootSessionId: "root-session", directory: path.join(base, "coordination") };
	const store = SessionCoordination.open(options);
	return { base, options, store };
}
function task(store: SessionCoordination, id = "login") {
	return store.createTask({ id, title: `Fix ${id}`, objective: `Finish ${id} implementation, review, and tests`, nextAction: "Review implementation",
		items: [{ id: "implementation", text: "Implement login" }, { id: "review", text: "Review login", dependsOn: ["implementation"] }] });
}
const report = (runId: string, text = "Implementation ready for review.") => ({ runId, agent: "worker", task: "Implement login", text, executionStatus: "completed" });
function link(store: SessionCoordination, runId: string, taskId = "login", itemId?: string) {
	store.linkRun(runId, { taskId, itemId, agent: "worker", task: "Implement login" });
}

test("simultaneous result and user arrival preserves focus and multiple unfinished tasks", t => {
	const { store } = fixture(t);
	task(store);
	task(store, "settings");
	const focus = store.setFocus({ taskId: "login", text: "Reviewing the login fix", nextAction: "Finish login tests" });
	link(store, "run-login"); link(store, "run-settings", "settings");
	store.recordResult(report("run-settings"));
	const updateId = store.captureUserMessage("Also keep the existing login appearance.");
	store.recordResult(report("run-login"));
	assert.deepEqual(store.snapshot().focus, focus);
	assert.equal(store.snapshot().tasks.filter(task => task.status === "active").length, 2);
	assert.equal(store.snapshot().results.filter(result => result.handling === "new").length, 2);
	assert.equal(store.snapshot().userUpdates.find(update => update.id === updateId)?.status, "pending");
	assert.doesNotMatch(store.contextDigest(), /Main:|Next:|Reviewing the login fix/);
	assert.match(store.contextDigest(), /keep the existing login appearance/);
});

test("inspection and delivery never handle a result or complete the parent obligation", t => {
	const { store, options } = fixture(t);
	task(store); link(store, "run-1", "login", "implementation");
	store.recordResult(report("run-1"));
	const before = store.snapshot();
	store.snapshot(); store.pendingDigest(); store.contextDigest();
	assert.deepEqual(store.snapshot(), before);
	store.markDelivered(["run-1"]);
	const restored = SessionCoordination.open(options).snapshot();
	assert.equal(restored.results[0].delivered, true);
	assert.equal(restored.results[0].handling, "new");
	assert.equal(restored.tasks[0].status, "active");
	assert.equal(restored.tasks[0].items[0].status, "pending");
	assert.throws(() => store.updateItem("login", "implementation", { status: "completed" }), /unhandled result/);
	store.handleResult("run-1", "reviewed", "Reviewed diff; tests still pending");
	assert.match(store.pendingDigest(), /reviewed/);
	assert.throws(() => store.updateItem("login", "implementation", { status: "completed" }), /unhandled result/);
	store.handleResult("run-1", "incorporated", "Applied review and test findings");
	store.updateItem("login", "implementation", { status: "completed" });
	assert.throws(() => store.updateTask("login", { status: "completed" }), /unfinished checklist/);
	store.updateItem("login", "review", { status: "completed" });
	assert.equal(store.snapshot().tasks[0].status, "completed", "last verified checklist item closes the task automatically");
	assert.match(store.pendingDigest(), /no unhandled results/);
});

test("deferred and superseded work remain visible across reload without changing focus", t => {
	const { store, options } = fixture(t);
	task(store); link(store, "run-1");
	store.setFocus({ taskId: "login", text: "Finishing tests" });
	store.recordResult(report("run-1"));
	store.handleResult("run-1", "deferred", "Wait for the API decision");
	store.updateTask("login", { status: "superseded", amendment: "User chose a different login approach" });
	const reopened = SessionCoordination.open(options);
	assert.equal(reopened.snapshot().tasks[0].status, "superseded");
	assert.equal(reopened.snapshot().focus?.text, "Finishing tests");
	assert.match(reopened.contextDigest(), /1 superseded/);
	assert.match(reopened.pendingDigest(), /deferred.*completed/);
	assert.match(reopened.pendingDigest(), /Wait for the API decision/);
});

test("unresolved linked runs prevent completion and reload never turns them into live execution", t => {
	const { store, options } = fixture(t);
	store.createTask({ id: "task", title: "Run tests" });
	link(store, "run-1", "task");
	assert.throws(() => store.updateTask("task", { status: "completed" }), /unfinished run/);
	const reopened = SessionCoordination.open(options);
	assert.equal(reopened.snapshot().runs.length, 1);
	assert.equal(reopened.snapshot().results.length, 0);
	assert.equal(reopened.snapshot().tasks[0].status, "active");
	reopened.recordResult({ ...report("run-1"), executionStatus: "interrupted", text: "Process is no longer present; inspect saved history." });
	assert.match(reopened.pendingDigest(), /interrupted/);
	assert.throws(() => reopened.updateTask("task", { status: "completed" }), /unhandled result/);
	reopened.handleResult("run-1", "incorporated", "Recorded interruption and resumed required work elsewhere");
	reopened.updateTask("task", { status: "completed" });
});

test("linked unfinished execution also prevents completing a checklist item", t => {
	const { store } = fixture(t);
	task(store); link(store, "run-1", "login", "implementation");
	assert.throws(() => store.updateItem("login", "implementation", { status: "completed" }), /unfinished run/);
	assert.equal(store.snapshot().tasks[0].items[0].status, "pending");
});

test("user amendments are mapped explicitly and never replace other unfinished requests", t => {
	const { store, options } = fixture(t);
	task(store); task(store, "settings");
	store.setFocus({ taskId: "login", text: "Reviewing implementation" });
	const amendment = store.captureUserMessage("Do not change the login appearance.");
	const question = store.captureUserMessage("What is the current progress?");
	assert.throws(() => store.reconcileUserMessage(amendment, { amendment: "Keep login appearance" }), /requires a task/);
	assert.throws(() => store.reconcileUserMessage(amendment, { taskId: "missing" }), /unknown task/);
	store.reconcileUserMessage(amendment, { taskId: "login", amendment: "Keep login appearance", note: "Clarification of accepted login task" });
	store.reconcileUserMessage(amendment, { taskId: "login", amendment: "Keep login appearance" });
	store.reconcileUserMessage(question, { note: "Status question answered; existing obligations remain" });
	const restored = SessionCoordination.open(options).snapshot();
	assert.deepEqual(restored.tasks[0].amendments, ["Keep login appearance"]);
	assert.equal(restored.tasks[1].status, "active");
	assert.equal(restored.focus?.text, "Reviewing implementation");
	assert.equal(restored.userUpdates.filter(update => update.status === "pending").length, 0);
	assert.throws(() => store.reconcileUserMessage(amendment, { taskId: "settings" }), /already reconciled differently/);
	assert.throws(() => store.reconcileUserMessage(amendment, { taskId: "login", amendment: "Change login appearance" }), /already reconciled differently/);
});

test("multiple store instances preserve both writers and return detached snapshots", t => {
	const { store, options } = fixture(t);
	const other = SessionCoordination.open(options);
	task(store);
	task(other, "settings");
	const external = store.snapshot();
	external.tasks[0].title = "Corrupted outside store";
	external.tasks[0].items.length = 0;
	assert.equal(other.snapshot().tasks[0].title, "Fix login");
	store.updateTask("settings", { amendment: "Keep settings migrations compatible" });
	other.updateTask("login", { nextAction: "Run tests" });
	assert.deepEqual(store.snapshot(), other.snapshot());
	assert.equal(store.snapshot().tasks[0].items.length, 2);
	assert.deepEqual(other.snapshot().tasks[1].amendments, ["Keep settings migrations compatible"]);
});

test("invalid IDs, statuses, dependencies, cycles, and associations reject atomically", t => {
	const { store } = fixture(t);
	task(store);
	const before = store.snapshot();
	assert.throws(() => store.createTask({ id: "login", title: "Duplicate" }), /invalid task/);
	assert.throws(() => store.createTask({ id: "bad\nidentifier", title: "Invalid" }), /invalid task/);
	assert.throws(() => store.updateTask("login", { status: "unknown" as any }), /invalid task/);
	assert.throws(() => store.addItem("login", { id: "new", text: "Missing dependency", dependsOn: ["absent"] }), /unknown dependency/);
	assert.throws(() => store.updateItem("login", "implementation", { dependsOn: ["review"] }), /cyclic/);
	assert.throws(() => store.updateItem("login", "review", { status: "completed" }), /unfinished dependency/);
	assert.throws(() => store.setFocus({ taskId: "missing", text: "Invalid focus" }), /unknown task/);
	assert.throws(() => store.recordResult({ ...report("invalid"), taskId: "missing" }), /unknown task/);
	assert.throws(() => store.recordResult({ ...report("invalid"), itemId: "implementation" }), /requires a task/);
	assert.throws(() => store.recordResult({ ...report("invalid"), executionStatus: "running" }), /invalid result/);
	assert.deepEqual(store.snapshot(), before);
	link(store, "run-1");
	assert.throws(() => store.recordResult({ ...report("run-1"), taskId: "other" }), /association mismatch/);
	assert.throws(() => store.recordResult({ ...report("run-1"), agent: "someone-else" }), /association mismatch/);
	assert.throws(() => store.markDelivered(["absent"]), /unknown result/);
	assert.equal(store.snapshot().results.length, 0);
});

test("explicit result handling is idempotent across duplicate completion delivery", t => {
	const { store } = fixture(t);
	task(store); link(store, "run-1");
	store.recordResult(report("run-1"));
	store.markDelivered(["run-1"]);
	store.handleResult("run-1", "deferred", "Waiting on clarification");
	const before = store.snapshot().results[0];
	store.recordResult(report("run-1"));
	store.markDelivered(["run-1"]);
	assert.deepEqual(store.snapshot().results[0], before);
	assert.throws(() => store.recordResult(report("run-1", "Different output")), /conflicting result/);
	assert.throws(() => store.linkRun("run-1", { taskId: "login", itemId: "review", agent: "worker", task: "Implement login" }), /already linked/);
	assert.deepEqual(store.snapshot().results[0], before);
});

test("compact digests restore checklist steps and amendments without legacy focus fields", t => {
	const { store, options } = fixture(t);
	task(store);
	store.updateTask("login", { amendment: "Keep public API compatibility" });
	store.setFocus({ taskId: "login", text: "Review implementation", nextAction: "Review results then finish login tests" });
	for (let index = 0; index < 16; index++) {
		link(store, `run-${index}`);
		store.recordResult(report(`run-${index}`, "Large report content. ".repeat(1000)));
	}
	const digest = SessionCoordination.open(options).contextDigest({ maxResults: 2 });
	assert.ok(digest.length <= 6000);
	assert.doesNotMatch(digest, /Main:|Next:|Resume:|Review results then finish login tests/);
	assert.match(digest, /Keep public API compatibility/);
	assert.match(digest, /implementation \[pending/);
	assert.match(digest, /\+14 more saved results/);
	assert.doesNotMatch(digest, /Large report content\. Large report content\. Large report content\. Large report content\. Large report content\. Large report content\. Large report content\. Large report content\. Large report content\. Large report content\./);
	assert.ok(store.pendingDigest({ maxChars: 100 }).length <= 100);
	assert.ok(store.contextDigest({ maxChars: 20 }).length <= 20);
	assert.throws(() => store.contextDigest({ maxChars: -1 }), /invalid digest limit/);
	assert.equal(store.snapshot().results[0].text.length, "Large report content. ".repeat(1000).length);
});

test("in-loop restoration with deliveredOnly reveals counts but defers arriving report content", t => {
	const { store } = fixture(t);
	task(store); link(store, "first"); link(store, "second");
	store.setFocus({ taskId: "login", text: "Reviewing login" });
	store.recordResult({ ...report("first", "Visible after safe delivery"), title: "Delivered report" });
	store.markDelivered(["first"]);
	store.recordResult({ ...report("second", "Do not interrupt current task with this report"), title: "Undelivered report" });
	const digest = store.contextDigest({ deliveredOnly: true });
	assert.match(digest, /Visible after safe delivery/);
	assert.match(digest, /1 reports waiting for a safe delivery boundary/);
	assert.doesNotMatch(digest, /Undelivered report|Do not interrupt/);
	assert.match(store.contextDigest(), /Do not interrupt/);
	assert.match(store.pendingDigest({ deliveredOnly: true }), /safe delivery boundary/);
	assert.equal(store.snapshot().results[1].handling, "new");
	assert.equal(store.snapshot().results[1].delivered, false);
});

test("in-loop restoration withholds queued user text until admitted at the next user boundary", t => {
	const { store, options } = fixture(t);
	task(store);
	store.setFocus({ taskId: "login", text: "Reviewing login" });
	const admitted = store.captureUserMessage("Keep public login API compatibility.");
	const admittedIds = [admitted] as const;
	const queued = store.captureUserMessage("Queued follow-up: switch next to the settings task.");
	const digest = store.contextDigest({ deliveredOnly: true, admittedUserUpdateIds: admittedIds });
	assert.match(digest, /Keep public login API compatibility/);
	assert.match(digest, /User updates awaiting reconciliation: 2/);
	assert.match(digest, /1 user inputs waiting for the next user boundary/);
	assert.doesNotMatch(digest, /Queued follow-up|switch next to the settings task/);
	assert.ok(!digest.includes(queued));
	assert.equal(store.snapshot().focus?.text, "Reviewing login");
	assert.equal(store.snapshot().userUpdates[1].status, "pending");
	assert.match(SessionCoordination.open(options).contextDigest(), /Queued follow-up: switch next to the settings task/);
	assert.match(store.contextDigest({ admittedUserUpdateIds: [admitted, queued] }), /Queued follow-up/);
	const noneAdmitted = store.contextDigest({ admittedUserUpdateIds: [] });
	assert.match(noneAdmitted, /2 user inputs waiting for the next user boundary/);
	assert.doesNotMatch(noneAdmitted, /Keep public login API compatibility|Queued follow-up/);
	assert.throws(() => store.contextDigest({ admittedUserUpdateIds: ["bad\nID"] }), /invalid admitted user update IDs/);
});

test("canonical project, root session, and participant identities isolate persisted state", t => {
	const { store, options, base } = fixture(t);
	task(store);
	const alias = path.join(base, "project-alias");
	symlinkSync(options.projectCwd, alias);
	assert.equal(SessionCoordination.open({ ...options, projectCwd: alias }).snapshot().tasks.length, 1);
	assert.equal(SessionCoordination.open({ ...options, rootSessionId: "another-session" }).snapshot().tasks.length, 0);
	assert.equal(SessionCoordination.open({ ...options, participantId: "worker" }).snapshot().tasks.length, 0);
	const otherProject = path.join(base, "another-project"); mkdirSync(otherProject);
	assert.equal(SessionCoordination.open({ ...options, projectCwd: otherProject }).snapshot().tasks.length, 0);
	assert.throws(() => SessionCoordination.open({ ...options, rootSessionId: "" }), /stable root session/);
});

test("persistence is private, complete, and refuses corruption instead of resetting obligations", t => {
	const { store, options } = fixture(t);
	task(store); link(store, "run-1"); store.recordResult(report("run-1"));
	assert.equal(lstatSync(store.directory).mode & 0o777, 0o700);
	assert.equal(lstatSync(store.file).mode & 0o777, 0o600);
	assert.deepEqual(readdirSync(store.directory), ["coordination.json"]);
	const saved = readFileSync(store.file, "utf8");
	const envelope = JSON.parse(saved); envelope.payload = envelope.payload.replace("Fix login", "Changed externally");
	writeFileSync(store.file, JSON.stringify(envelope), { mode: 0o600 });
	assert.throws(() => SessionCoordination.open(options), /integrity/);
	assert.throws(() => store.snapshot(), /integrity/);
	writeFileSync(store.file, saved, { mode: 0o600 });
	const wrongScope = JSON.parse(saved); const payload = JSON.parse(wrongScope.payload); payload.scope.rootSessionId = "wrong";
	wrongScope.payload = JSON.stringify(payload); wrongScope.sha256 = createHash("sha256").update(wrongScope.payload).digest("hex");
	writeFileSync(store.file, JSON.stringify(wrongScope), { mode: 0o600 });
	assert.throws(() => SessionCoordination.open(options), /scope mismatch/);
	writeFileSync(store.file, saved, { mode: 0o600 });
	assert.equal(SessionCoordination.open(options).snapshot().tasks.length, 1);
	chmodSync(store.file, 0o644);
	assert.throws(() => SessionCoordination.open(options), /owner-only permissions/);
});

test("busy and crash-left locks fail closed without erasing or duplicating tasks", t => {
	const { store, options } = fixture(t);
	task(store);
	const lock = path.join(store.directory, ".lock");
	mkdirSync(lock, { mode: 0o700 });
	assert.throws(() => store.updateTask("login", { amendment: "Should not be saved" }), /store is busy/);
	assert.throws(() => SessionCoordination.open(options), /store is busy/);
	assert.deepEqual(store.snapshot().tasks[0].amendments, []);
	rmSync(lock, { recursive: true });
	assert.equal(SessionCoordination.open(options).snapshot().tasks.length, 1);
});

test("unassigned reports can be linked explicitly without changing existing handling", t => {
	const { store } = fixture(t);
	task(store);
	store.recordResult(report("unassigned"));
	store.handleResult("unassigned", "reviewed");
	link(store, "unassigned", "login", "implementation");
	const result = store.snapshot().results[0];
	assert.equal(result.taskId, "login");
	assert.equal(result.itemId, "implementation");
	assert.equal(result.handling, "reviewed");
	assert.equal(store.snapshot().focus, undefined);
});


test("automatic task completion waits for task-level reports and adding work reopens it", t => {
	const { store, options } = fixture(t);
	task(store);
	link(store, "report");
	store.updateItem("login", "implementation", { status: "completed" });
	store.updateItem("login", "review", { status: "completed" });
	assert.equal(store.snapshot().tasks[0].status, "active", "missing linked report blocks automatic closure");
	store.recordResult(report("report"));
	store.handleResult("report", "reviewed");
	assert.equal(store.snapshot().tasks[0].status, "active");
	store.handleResult("report", "incorporated");
	assert.equal(SessionCoordination.open(options).snapshot().tasks[0].status, "completed");
	store.addItem("login", { id: "regression", text: "Verify another browser" });
	assert.equal(store.snapshot().tasks[0].status, "active");
	store.updateItem("login", "regression", { status: "completed" });
	assert.equal(store.snapshot().tasks[0].status, "completed");
	store.updateItem("login", "regression", { status: "in_progress" });
	assert.equal(store.snapshot().tasks[0].status, "active");
	store.updateTask("login", { status: "blocked" });
	store.updateItem("login", "regression", { status: "completed" });
	assert.equal(store.snapshot().tasks[0].status, "blocked", "an explicit block is not silently cleared");
});
