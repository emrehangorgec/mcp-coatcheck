// End to end: real proxy process wrapping examples/slow-server.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const TASKS_EXT = "io.modelcontextprotocol/tasks";
const CLIENT_CAPS = "io.modelcontextprotocol/clientCapabilities";

function startProxy(extra = []) {
  const proc = spawn(
    process.execPath,
    ["dist/cli.js", "--after", "300ms", ...extra, "--", process.execPath, "examples/slow-server.mjs"],
    { cwd: root, stdio: ["pipe", "pipe", "inherit"] },
  );
  const waiting = new Map();
  const stray = []; // anything the client did not ask for
  let nextId = 1;
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    const resolve = waiting.get(msg.id);
    if (resolve) {
      waiting.delete(msg.id);
      resolve(msg);
    } else {
      stray.push(msg);
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve) => waiting.set(id, resolve));
  };
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
  return { request, notify, send, waiting, stray, close: () => proc.kill() };
}

const text = (result) => result.content.map((c) => c.text).join("");
const jobIdFrom = (result) => /job ([0-9a-f-]{36})/.exec(text(result))[1];

test("advertises tasks and marks tools as task capable", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const init = await c.request("initialize", { protocolVersion: "2025-11-25", capabilities: {} });
  assert.deepEqual(init.result.capabilities.tasks, { cancel: {}, requests: { tools: { call: {} } } });

  const list = await c.request("tools/list", {});
  const names = list.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["echo", "run_tests", "explode", "coatcheck_status", "coatcheck_result", "coatcheck_cancel"]);
  assert.equal(list.result.tools[1].execution.taskSupport, "optional");
});

test("coatcheck_result never blocks longer than --after", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const res = await c.request("tools/call", { name: "run_tests", arguments: { seconds: 30 } });
  const started = Date.now();
  const again = await c.request("tools/call", { name: "coatcheck_result", arguments: { job_id: jobIdFrom(res.result) } });
  assert.match(text(again.result), /still running/);
  assert.ok(Date.now() - started < 1500, "returned well before the job finished");
});

test("--only limits which tools become tasks", async (t) => {
  const c = startProxy(["--only", "run_tests", "--no-fallback-tools"]);
  t.after(c.close);
  const list = await c.request("tools/list", {});
  const support = Object.fromEntries(list.result.tools.map((tool) => [tool.name, tool.execution?.taskSupport]));
  assert.deepEqual(support, { echo: undefined, run_tests: "optional", explode: undefined });
});

test("fallback: quick calls pass straight through", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const res = await c.request("tools/call", { name: "echo", arguments: { text: "hi" } });
  assert.equal(text(res.result), "hi");
});

test("fallback: slow calls return a job id, then the real result", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const res = await c.request("tools/call", { name: "run_tests", arguments: { seconds: 1 } });
  assert.match(text(res.result), /still running in the background/);
  const jobId = jobIdFrom(res.result);

  const status = await c.request("tools/call", { name: "coatcheck_status", arguments: { job_id: jobId } });
  assert.match(text(status.result), /is working/);

  // coatcheck_result never blocks longer than --after (300ms here), so it may need a few calls.
  let done;
  for (let i = 0; i < 10; i++) {
    done = await c.request("tools/call", { name: "coatcheck_result", arguments: { job_id: jobId } });
    if (!/still running/.test(text(done.result))) break;
  }
  assert.equal(text(done.result), "142 passed, 0 failed in 1s");
});

test("fallback: cancel stops the job", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const res = await c.request("tools/call", { name: "run_tests", arguments: { seconds: 30 } });
  const jobId = jobIdFrom(res.result);
  const cancel = await c.request("tools/call", { name: "coatcheck_cancel", arguments: { job_id: jobId } });
  assert.match(text(cancel.result), /cancelled/);
  const after = await c.request("tools/call", { name: "coatcheck_result", arguments: { job_id: jobId } });
  assert.match(text(after.result), /was cancelled/);
});

test("a late answer to a cancelled job never reaches the client", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const res = await c.request("tools/call", { name: "run_tests", arguments: { seconds: 1, ignore_cancel: true } });
  const jobId = jobIdFrom(res.result);
  await c.request("tools/call", { name: "coatcheck_cancel", arguments: { job_id: jobId } });
  await new Promise((r) => setTimeout(r, 1200)); // the server answers anyway
  const echo = await c.request("tools/call", { name: "echo", arguments: { text: "still fine" } });
  assert.equal(text(echo.result), "still fine");
  assert.deepEqual(c.stray, []);
});

test("cancelling a reused request id does not touch an earlier background job", async (t) => {
  const c = startProxy();
  t.after(c.close);
  // Request id 99 goes to the background and gets answered with a job id.
  const first = await new Promise((resolve) => {
    c.waiting.set(99, resolve);
    c.send({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "run_tests", arguments: { seconds: 2 } } });
  });
  const jobId = jobIdFrom(first.result);
  // The client reuses id 99 for something else and cancels that.
  c.notify("notifications/cancelled", { requestId: 99, reason: "user pressed esc" });
  const status = await c.request("tools/call", { name: "coatcheck_status", arguments: { job_id: jobId } });
  assert.match(text(status.result), /is working/);
});

test("2025-11-25: task augmented call, tasks/get, tasks/result", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const created = await c.request("tools/call", { name: "run_tests", arguments: { seconds: 1 }, task: { ttl: 60000 } });
  const task = created.result.task;
  assert.equal(task.status, "working");
  assert.equal(task.ttl, 60000);
  assert.ok(task.pollInterval > 0);

  const got = await c.request("tasks/get", { taskId: task.taskId });
  assert.equal(got.result.status, "working");

  const result = await c.request("tasks/result", { taskId: task.taskId });
  assert.equal(text(result.result), "142 passed, 0 failed in 1s");
  assert.equal(result.result._meta["io.modelcontextprotocol/related-task"].taskId, task.taskId);

  const final = await c.request("tasks/get", { taskId: task.taskId });
  assert.equal(final.result.status, "completed");
});

test("2025-11-25: isError result marks the task failed", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const created = await c.request("tools/call", { name: "explode", arguments: {}, task: {} });
  const result = await c.request("tasks/result", { taskId: created.result.task.taskId });
  assert.equal(result.result.isError, true);
  const got = await c.request("tasks/get", { taskId: created.result.task.taskId });
  assert.equal(got.result.status, "failed");
});

test("2025-11-25: cancel, then cancelling again is rejected", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const created = await c.request("tools/call", { name: "run_tests", arguments: { seconds: 30 }, task: {} });
  const id = created.result.task.taskId;
  const cancelled = await c.request("tasks/cancel", { taskId: id });
  assert.equal(cancelled.result.status, "cancelled");
  const again = await c.request("tasks/cancel", { taskId: id });
  assert.equal(again.error.code, -32602);
});

test("unknown task ids and tasks/list are rejected", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const missing = await c.request("tasks/get", { taskId: "nope" });
  assert.equal(missing.error.code, -32602);
  const list = await c.request("tasks/list", {});
  assert.equal(list.error.code, -32601);
});

test("2026-07-28: slow call becomes a task, quick call stays plain", async (t) => {
  const c = startProxy();
  t.after(c.close);
  const meta = { [CLIENT_CAPS]: { extensions: { [TASKS_EXT]: {} } } };

  const quick = await c.request("tools/call", { name: "echo", arguments: { text: "hi" }, _meta: meta });
  assert.equal(text(quick.result), "hi");

  const created = await c.request("tools/call", { name: "run_tests", arguments: { seconds: 1 }, _meta: meta });
  assert.equal(created.result.resultType, "task");
  assert.equal(created.result.status, "working");
  assert.ok(created.result.ttlMs > 0);

  let detailed;
  for (let i = 0; i < 30; i++) {
    detailed = (await c.request("tasks/get", { taskId: created.result.taskId })).result;
    if (detailed.status !== "working") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(detailed.resultType, "complete");
  assert.equal(detailed.status, "completed");
  assert.equal(text(detailed.result), "142 passed, 0 failed in 1s");
});

test("2026-07-28: isError results stay completed", async (t) => {
  const c = startProxy(["--after", "50ms"]);
  t.after(c.close);
  const meta = { [CLIENT_CAPS]: { extensions: { [TASKS_EXT]: {} } } };
  const created = await c.request("tools/call", { name: "explode", arguments: {}, _meta: meta });
  assert.equal(created.result.resultType, "task");
  await new Promise((r) => setTimeout(r, 400));
  const detailed = (await c.request("tasks/get", { taskId: created.result.taskId })).result;
  assert.equal(detailed.status, "completed");
  assert.equal(detailed.result.isError, true);
});
