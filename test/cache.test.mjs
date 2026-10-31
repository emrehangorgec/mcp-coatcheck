import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCache } from "../dist/cache.js";
import { JobStore } from "../dist/jobs.js";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "coatcheck-cache-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = new DiskCache(root, ["server", "--arg"], "/workspace");
  const directory = join(root, readdirSync(root)[0]);
  return { root, cache, directory, store: new JobStore(1000, cache) };
}

test("fallback retention starts at completion, Tasks retention starts at creation", (t) => {
  const { store } = fixture(t);
  const fallback = store.create("slow", "fallback", "first");
  const task = store.create("slow", "2025-11-25", "second");
  for (const job of [fallback, task]) {
    job.createdAt = new Date(Date.now() - 2000);
    store.settle(job, "completed", { result: { content: [] } });
  }
  assert.equal(store.get(fallback.id)?.status, "completed");
  assert.equal(store.get(task.id), undefined);
});

test("expired disk results are removed and cannot be restored", (t) => {
  const { store, cache, directory } = fixture(t);
  const job = store.create("echo", "fallback", "one");
  store.settle(job, "completed", { result: { content: [] } });
  job.lastUpdatedAt = new Date(Date.now() - 2000);
  cache.save(job);
  cache.sweep();
  assert.deepEqual(readdirSync(directory), []);
  assert.equal(new JobStore(1000, cache).get(job.id), undefined);
});

test("cache isolates working directories and command arguments", (t) => {
  const { root, store } = fixture(t);
  const job = store.create("echo", "fallback", "one");
  store.settle(job, "completed", { result: { content: [] } });
  assert.equal(new DiskCache(root, ["server", "--other"], "/workspace").load(job.id), undefined);
  assert.equal(new DiskCache(root, ["server", "--arg"], "/elsewhere").load(job.id), undefined);
  assert.equal(new DiskCache(root, ["server", "--arg"], "/workspace").load(job.id)?.status, "completed");
});

test("malformed records and path traversal never become tickets", (t) => {
  const { store, cache, directory } = fixture(t);
  const job = store.create("echo", "fallback", "one");
  const path = join(directory, `${job.id}.json`);
  const valid = JSON.parse(readFileSync(path, "utf8"));
  for (const content of ["{", JSON.stringify({ ...valid, job: { ...valid.job, createdAt: "invalid" } }), JSON.stringify({ ...valid, job: { ...valid.job, ttlMs: "forever" } })]) {
    writeFileSync(path, content);
    assert.equal(cache.load(job.id), undefined);
    cache.sweep();
  }
  assert.equal(cache.load("../../outside"), undefined);
});

test("atomic writes leave only the final record and use private POSIX modes", (t) => {
  const { store, directory } = fixture(t);
  const job = store.create("echo", "fallback", "one");
  store.settle(job, "completed", { result: { content: [{ type: "text", text: "saved" }] } });
  assert.deepEqual(readdirSync(directory), [`${job.id}.json`]);
  const path = join(directory, `${job.id}.json`);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).job.result.content[0].text, "saved");
  if (process.platform !== "win32") {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});
