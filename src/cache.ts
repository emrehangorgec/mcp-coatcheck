import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Job } from "./jobs.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function defaultCacheDir(): string {
  const base = process.platform === "win32"
    ? process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    : process.platform === "darwin" ? join(homedir(), "Library", "Caches")
    : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(base, "mcp-coatcheck");
}

/** Retention is measured from completion for fallback tickets, from creation for MCP Tasks. */
export function expiresAt(job: Job): number {
  const start = job.era === "fallback" && job.status !== "working" ? job.lastUpdatedAt : job.createdAt;
  return start.getTime() + job.ttlMs;
}

/** Each process owns its records. Other live processes' in-flight calls are never adopted. */
export class DiskCache {
  private directory: string;
  private warned = false;

  constructor(root: string, command: string[], cwd: string) {
    const namespace = createHash("sha256").update(JSON.stringify([cwd, command])).digest("hex");
    this.directory = join(root, namespace);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.sweep();
  }

  save(job: Job): void {
    const path = join(this.directory, `${job.id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const { waiters: _waiters, ...record } = job;
      writeFileSync(temporary, JSON.stringify({ version: 1, pid: process.pid, job: record }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } catch (error) {
      this.warn(error);
    } finally {
      try { unlinkSync(temporary); } catch { /* No temporary file remains after a successful rename. */ }
    }
  }

  load(id: string): Job | undefined {
    if (!UUID.test(id)) return;
    try {
      const record = JSON.parse(readFileSync(join(this.directory, `${id}.json`), "utf8"));
      const data = record.job;
      if (record.version !== 1 || !data || data.id !== id || typeof data.tool !== "string"
        || !["fallback", "2025-11-25", "2026-07-28"].includes(data.era)
        || !["working", "completed", "failed", "cancelled"].includes(data.status)
        || !Number.isFinite(data.ttlMs) || data.ttlMs < 0
        || !Number.isSafeInteger(record.pid) || record.pid <= 0) return;
      const job: Job = { ...data, createdAt: new Date(data.createdAt), lastUpdatedAt: new Date(data.lastUpdatedAt), waiters: [] };
      if (!Number.isFinite(job.createdAt.getTime()) || !Number.isFinite(job.lastUpdatedAt.getTime())) return;
      if (job.status === "working") {
        try { process.kill(record.pid, 0); return; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return;
        }
      }
      if (Date.now() >= expiresAt(job)) {
        this.remove(id);
        return;
      }
      if (job.status === "working") {
        job.status = "failed";
        job.statusMessage = "The proxy stopped before this call finished. The call was not retried.";
        job.error = { code: -32603, message: job.statusMessage };
        // Keep the original timestamp: looking up an interrupted ticket must not extend retention.
        this.save(job);
      }
      return job;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) this.warn(error);
      return;
    }
  }

  remove(id: string): void {
    if (!UUID.test(id)) return;
    try { unlinkSync(join(this.directory, `${id}.json`)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.warn(error);
    }
  }

  sweep(): void {
    try {
      for (const file of readdirSync(this.directory)) {
        if (file.endsWith(".json")) this.load(file.slice(0, -5));
      }
    } catch (error) { this.warn(error); }
  }

  private warn(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.error(`mcp-coatcheck: result cache unavailable; tickets may not survive a restart: ${(error as Error).message}`);
  }
}
