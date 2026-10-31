import { JobStore, TERMINAL, type Job, type JobEra } from "./jobs.js";
import type { DiskCache } from "./cache.js";

const TASKS_EXT = "io.modelcontextprotocol/tasks";
const CLIENT_CAPS_META = "io.modelcontextprotocol/clientCapabilities";
const RELATED_TASK_META = "io.modelcontextprotocol/related-task";
const IMMEDIATE_RESPONSE_META = "io.modelcontextprotocol/model-immediate-response";

const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export const FALLBACK_TOOLS = ["coatcheck_status", "coatcheck_result", "coatcheck_cancel"] as const;
const UPSTREAM_ID_PREFIX = "coatcheck-";

export interface ProxyOptions {
  /** How long a call may run before it is handed back as a task or a job id. */
  softTimeoutMs: number;
  ttlMs: number;
  pollIntervalMs: number;
  /** When set, only these tools are ever turned into tasks. */
  only?: Set<string>;
  fallbackTools: boolean;
  cache?: DiskCache;
}

type Send = (msg: any) => void;

/**
 * Sits between an MCP client and an MCP server that has no task support.
 * Every message it does not understand is forwarded untouched, so it works
 * with both the 2025-11-25 and the 2026-07-28 wire formats.
 */
export class CoatcheckProxy {
  private jobs: JobStore;
  private nextUpstreamId = 1;
  /** Client request ids whose responses we patch, mapped to their method. */
  private patchable = new Map<string, string>();
  /** Client request ids of intercepted calls, mapped to the id we used upstream. */
  private clientToUpstream = new Map<string, string>();
  /** True once the wrapped server turns out to support tasks itself. */
  private native = false;
  /** True once a 2026-07-28 `server/discover` handshake went through. */
  private modernEra = false;

  constructor(
    private opts: ProxyOptions,
    private toClient: Send,
    private toServer: Send,
  ) {
    this.jobs = new JobStore(opts.ttlMs, opts.cache);
  }

  fromClient(msg: any): void {
    const isRequest = typeof msg?.method === "string" && msg.id !== undefined;
    if (!isRequest || this.native) {
      if (msg?.method === "notifications/cancelled" && !this.native) this.translateCancel(msg);
      this.toServer(msg);
      return;
    }
    switch (msg.method) {
      case "initialize":
      case "server/discover":
      case "tools/list":
        this.patchable.set(key(msg.id), msg.method);
        this.toServer(msg);
        return;
      case "tools/call":
        void this.handleCall(msg);
        return;
      case "tasks/get":
      case "tasks/result":
      case "tasks/cancel":
      case "tasks/update":
      case "tasks/list":
        void this.handleTaskMethod(msg);
        return;
      default:
        this.toServer(msg);
    }
  }

  fromServer(msg: any): void {
    const isResponse = msg?.id !== undefined && msg.method === undefined;
    if (!isResponse) {
      this.toClient(msg);
      return;
    }
    if (typeof msg.id === "string" && msg.id.startsWith(UPSTREAM_ID_PREFIX)) {
      // Answers to our own calls never reach the client, even when they arrive
      // after the job was cancelled or expired.
      const job = this.jobs.byUpstreamId(msg.id);
      if (job) this.settleFromResponse(job, msg);
      return;
    }
    const method = this.patchable.get(key(msg.id));
    if (method) {
      this.patchable.delete(key(msg.id));
      if (msg.result) this.patchResult(method, msg.result);
    }
    this.toClient(msg);
  }

  // Handshake patching

  private patchResult(method: string, result: any): void {
    if (method === "initialize") {
      if (result.capabilities?.tasks?.requests?.tools?.call) {
        this.native = true;
        return;
      }
      result.capabilities ??= {};
      result.capabilities.tasks = { cancel: {}, requests: { tools: { call: {} } } };
    } else if (method === "server/discover") {
      this.modernEra = true;
      const extensions = (result.capabilities ??= {}).extensions ?? {};
      if (extensions[TASKS_EXT]) {
        this.native = true;
        return;
      }
      result.capabilities.extensions = { ...extensions, [TASKS_EXT]: {} };
    } else if (method === "tools/list" && !this.native) {
      for (const tool of result.tools ?? []) {
        if (this.eligible(tool.name) && !tool.execution?.taskSupport) {
          tool.execution = { ...tool.execution, taskSupport: "optional" };
        }
      }
      if (this.opts.fallbackTools && !result.nextCursor) {
        result.tools = [...(result.tools ?? []), ...fallbackToolDefinitions(Math.round(this.opts.softTimeoutMs / 1000))];
      }
    }
  }

  // tools/call

  private async handleCall(msg: any): Promise<void> {
    const params = msg.params ?? {};
    const name: string = params.name;
    if ((FALLBACK_TOOLS as readonly string[]).includes(name) && this.opts.fallbackTools) {
      this.reply(msg.id, this.complete(await this.handleFallbackTool(name, params.arguments ?? {})));
      return;
    }
    if (!this.eligible(name)) {
      this.toServer(msg);
      return;
    }

    let era: JobEra = "fallback";
    if (params.task) era = "2025-11-25";
    else if (params._meta?.[CLIENT_CAPS_META]?.extensions?.[TASKS_EXT]) era = "2026-07-28";

    const upstreamId = `${UPSTREAM_ID_PREFIX}${this.nextUpstreamId++}`;
    const job = this.jobs.create(name, era, upstreamId, params.task?.ttl);
    this.toServer({ jsonrpc: "2.0", id: upstreamId, method: "tools/call", params: stripTaskParams(params) });

    if (era === "2025-11-25") {
      this.reply(msg.id, {
        task: task2025(job, this.opts.pollIntervalMs),
        _meta: { [IMMEDIATE_RESPONSE_META]: stillRunningText(job) },
      });
      return;
    }

    // Quick calls come back as plain results, so nothing changes for them.
    // While we wait, a notifications/cancelled for this request must reach the job.
    this.clientToUpstream.set(key(msg.id), upstreamId);
    await this.jobs.wait(job, this.opts.softTimeoutMs);
    // Once answered, the client may reuse this id for another request.
    this.clientToUpstream.delete(key(msg.id));
    if (job.status === "cancelled") return; // the client cancelled it and expects no answer
    if (job.status === "completed" || job.status === "failed") {
      if (job.error) this.toClient({ jsonrpc: "2.0", id: msg.id, error: job.error });
      else this.reply(msg.id, job.result);
      return;
    }
    if (era === "2026-07-28") {
      this.reply(msg.id, { resultType: "task", ...task2026(job, this.opts.pollIntervalMs) });
    } else {
      this.reply(msg.id, this.complete(textResult(stillRunningText(job))));
    }
  }

  private settleFromResponse(job: Job, msg: any): void {
    if (msg.error) {
      this.jobs.settle(job, "failed", { error: msg.error, statusMessage: msg.error.message });
    } else if (msg.result?.isError && job.era === "2025-11-25") {
      // 2025-11-25 counts tool errors as failed, 2026-07-28 counts them as completed.
      this.jobs.settle(job, "failed", { result: msg.result, statusMessage: "Tool returned isError" });
    } else {
      this.jobs.settle(job, "completed", { result: msg.result });
    }
  }

  private translateCancel(msg: any): void {
    const upstreamId = this.clientToUpstream.get(key(msg.params?.requestId));
    if (upstreamId === undefined) return;
    msg.params = { ...msg.params, requestId: upstreamId };
    const job = this.jobs.byUpstreamId(upstreamId);
    if (job) this.jobs.settle(job, "cancelled", { statusMessage: "Cancelled by client" });
  }

  // tasks/* methods

  private async handleTaskMethod(msg: any): Promise<void> {
    if (msg.method === "tasks/list") {
      // Without auth we cannot tell clients apart, so listing would leak other callers' tasks.
      this.replyError(msg.id, METHOD_NOT_FOUND, "tasks/list is not supported");
      return;
    }
    const job = this.jobs.get(msg.params?.taskId);
    if (!job) {
      this.replyError(msg.id, INVALID_PARAMS, "Task not found or expired");
      return;
    }
    const poll = this.opts.pollIntervalMs;

    switch (msg.method) {
      case "tasks/get":
        this.reply(msg.id, job.era === "2026-07-28" ? detailedTask2026(job, poll) : task2025(job, poll));
        return;

      case "tasks/result": {
        await this.jobs.wait(job, job.ttlMs);
        if (!TERMINAL.has(job.status)) {
          this.replyError(msg.id, INTERNAL_ERROR, "Task did not finish before it expired");
        } else if (job.status === "cancelled") {
          this.replyError(msg.id, INTERNAL_ERROR, "Task was cancelled");
        } else if (job.error) {
          this.toClient({ jsonrpc: "2.0", id: msg.id, error: job.error });
        } else {
          const result = job.result ?? {};
          this.reply(msg.id, { ...result, _meta: { ...result._meta, [RELATED_TASK_META]: { taskId: job.id } } });
        }
        return;
      }

      case "tasks/cancel":
        if (TERMINAL.has(job.status)) {
          this.replyError(msg.id, INVALID_PARAMS, `Cannot cancel task: already in terminal status '${job.status}'`);
          return;
        }
        this.cancelUpstream(job);
        this.reply(msg.id, job.era === "2026-07-28" ? { resultType: "complete" } : task2025(job, poll));
        return;

      case "tasks/update":
        // We never ask for input, so there is nothing to apply.
        this.reply(msg.id, { resultType: "complete" });
        return;
    }
  }

  private cancelUpstream(job: Job): void {
    this.toServer({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: job.upstreamId, reason: "Cancelled through mcp-coatcheck" },
    });
    this.jobs.settle(job, "cancelled", { statusMessage: "The task was cancelled by request." });
  }

  // Fallback tools for clients without task support

  private async handleFallbackTool(name: string, args: any): Promise<any> {
    const job = this.jobs.get(String(args.job_id ?? ""));
    if (!job) return textResult(`No job with id "${args.job_id}". It may have expired.`, true);

    if (name === "coatcheck_status") {
      const seconds = Math.round((Date.now() - job.createdAt.getTime()) / 1000);
      return textResult(`Job ${job.id} (${job.tool}) is ${job.status} after ${seconds}s.`);
    }
    if (name === "coatcheck_cancel") {
      if (TERMINAL.has(job.status)) return textResult(`Job ${job.id} already ${job.status}.`);
      this.cancelUpstream(job);
      return textResult(`Job ${job.id} cancelled.`);
    }

    // Never block longer than --after, so this call stays under the client's own timeout.
    await this.jobs.wait(job, this.opts.softTimeoutMs);
    if (job.status === "working") return textResult(stillRunningText(job));
    if (job.status === "cancelled") return textResult(`Job ${job.id} was cancelled.`);
    if (job.error) return textResult(`${job.tool} failed: ${job.error.message ?? JSON.stringify(job.error)}`, true);
    return job.result;
  }

  // Helpers

  private eligible(tool: string): boolean {
    return !this.opts.only || this.opts.only.has(tool);
  }

  /** Locally made results carry `resultType` on the 2026-07-28 wire. */
  private complete(result: any): any {
    return this.modernEra && result && !result.resultType ? { resultType: "complete", ...result } : result;
  }

  private reply(id: any, result: any): void {
    this.toClient({ jsonrpc: "2.0", id, result });
  }

  private replyError(id: any, code: number, message: string): void {
    this.toClient({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

function key(id: unknown): string {
  return JSON.stringify(id);
}

function stripTaskParams(params: any): any {
  const { task: _task, ...rest } = params;
  const caps = rest._meta?.[CLIENT_CAPS_META];
  if (caps?.extensions?.[TASKS_EXT]) {
    // Keep the wrapped server from answering with a task of its own.
    const { [TASKS_EXT]: _ext, ...extensions } = caps.extensions;
    rest._meta = { ...rest._meta, [CLIENT_CAPS_META]: { ...caps, extensions } };
  }
  return rest;
}

function baseTask(job: Job) {
  return {
    taskId: job.id,
    status: job.status,
    ...(job.statusMessage ? { statusMessage: job.statusMessage } : {}),
    createdAt: job.createdAt.toISOString(),
    lastUpdatedAt: job.lastUpdatedAt.toISOString(),
  };
}

function task2025(job: Job, pollIntervalMs: number) {
  return { ...baseTask(job), ttl: job.ttlMs, pollInterval: pollIntervalMs };
}

function task2026(job: Job, pollIntervalMs: number) {
  return { ...baseTask(job), ttlMs: job.ttlMs, pollIntervalMs };
}

function detailedTask2026(job: Job, pollIntervalMs: number) {
  const task: any = { resultType: "complete", ...task2026(job, pollIntervalMs) };
  if (job.status === "completed") task.result = job.result;
  if (job.status === "failed") task.error = job.error;
  return task;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function stillRunningText(job: Job): string {
  return (
    `"${job.tool}" is still running in the background (job ${job.id}). ` +
    `Carry on with other work, then call coatcheck_result with {"job_id": "${job.id}"} to collect it, ` +
    `or coatcheck_cancel to stop it. If it is still running then, just call coatcheck_result again.`
  );
}

function fallbackToolDefinitions(maxWaitS: number) {
  const jobId = { job_id: { type: "string", description: "Job id returned when the call moved to the background." } };
  return [
    {
      name: "coatcheck_status",
      description: "Check on a tool call that is still running in the background.",
      inputSchema: { type: "object", properties: jobId, required: ["job_id"] },
    },
    {
      name: "coatcheck_result",
      description: `Collect the result of a background tool call. Waits up to ${maxWaitS}s for it to finish.`,
      inputSchema: { type: "object", properties: jobId, required: ["job_id"] },
    },
    {
      name: "coatcheck_cancel",
      description: "Stop a tool call that is running in the background.",
      inputSchema: { type: "object", properties: jobId, required: ["job_id"] },
    },
  ];
}
