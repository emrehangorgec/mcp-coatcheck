import { randomUUID } from "node:crypto";
import { expiresAt, type DiskCache } from "./cache.js";

export type JobStatus = "working" | "completed" | "failed" | "cancelled";

/** Which wire shape the client used when the job was created. */
export type JobEra = "2025-11-25" | "2026-07-28" | "fallback";

export interface Job {
  id: string;
  tool: string;
  era: JobEra;
  status: JobStatus;
  statusMessage?: string;
  createdAt: Date;
  lastUpdatedAt: Date;
  ttlMs: number;
  /** JSON-RPC id used toward the wrapped server. */
  upstreamId: string;
  /** CallToolResult, set when the wrapped server answered with a result. */
  result?: any;
  /** JSON-RPC error object, set when the wrapped server answered with an error. */
  error?: any;
  waiters: Array<() => void>;
}

export const TERMINAL: ReadonlySet<JobStatus> = new Set(["completed", "failed", "cancelled"]);

export class JobStore {
  private jobs = new Map<string, Job>();
  private byUpstream = new Map<string, Job>();

  constructor(private defaultTtlMs: number, private cache?: DiskCache) {}

  create(tool: string, era: JobEra, upstreamId: string, ttlMs?: number): Job {
    const now = new Date();
    const job: Job = {
      id: randomUUID(),
      tool,
      era,
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      // A client may ask for a shorter lifetime, never a longer one or none at all.
      ttlMs: typeof ttlMs === "number" && ttlMs > 0 ? Math.min(ttlMs, this.defaultTtlMs) : this.defaultTtlMs,
      upstreamId,
      waiters: [],
    };
    this.jobs.set(job.id, job);
    this.byUpstream.set(upstreamId, job);
    this.cache?.save(job);
    return job;
  }

  get(id: string): Job | undefined {
    this.sweep();
    const current = this.jobs.get(id);
    if (current) return current;
    const restored = this.cache?.load(id);
    if (restored) this.jobs.set(id, restored);
    return restored;
  }

  byUpstreamId(upstreamId: string): Job | undefined {
    return this.byUpstream.get(upstreamId);
  }

  /** Settles a job once. Later settles are ignored, so a cancelled job stays cancelled. */
  settle(job: Job, status: JobStatus, patch: { result?: any; error?: any; statusMessage?: string } = {}): void {
    this.byUpstream.delete(job.upstreamId);
    if (TERMINAL.has(job.status)) return;
    job.status = status;
    job.result = patch.result;
    job.error = patch.error;
    job.statusMessage = patch.statusMessage;
    job.lastUpdatedAt = new Date();
    this.cache?.save(job);
    for (const wake of job.waiters.splice(0)) wake();
  }

  /** Resolves when the job is terminal or after timeoutMs, whichever comes first. */
  wait(job: Job, timeoutMs: number): Promise<void> {
    if (TERMINAL.has(job.status) || timeoutMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        const index = job.waiters.indexOf(done);
        if (index !== -1) job.waiters.splice(index, 1);
        resolve();
      }
      job.waiters.push(done);
    });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.era === "fallback" && job.status === "working") continue;
      if (now >= expiresAt(job)) {
        this.jobs.delete(id);
        this.byUpstream.delete(job.upstreamId);
        this.cache?.remove(id);
      }
    }
  }
}
