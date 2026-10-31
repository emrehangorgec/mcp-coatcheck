#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CoatcheckProxy, type ProxyOptions } from "./proxy.js";
import { DiskCache, defaultCacheDir } from "./cache.js";

const USAGE = `Usage: mcp-coatcheck [options] -- <server command> [args...]

Wraps an MCP server so slow tool calls run as MCP Tasks, with a
job id fallback for clients that don't support tasks yet.

Options:
  --after <duration>    Longest any single call may block before it is
                        handed back as a task or job id (default 20s).
                        Keep it below your client's tool timeout.
  --ttl <duration>      Keep finished results this long (default 1h)
                        MCP Tasks expire this long after creation.
  --cache-dir <path>    Store tickets under this cache root
  --no-cache            Keep tickets in memory only
  --poll <duration>     Suggested polling interval (default 2s)
  --only <a,b,...>      Only these tools may become tasks
  --no-fallback-tools   Don't add coatcheck_status/result/cancel tools
  -h, --help            Show this help

Durations: 500ms, 8s, 2m, 1h (a bare number means seconds).

Example:
  mcp-coatcheck --after 5s -- npx -y @playwright/mcp`;

function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
  if (!match) throw new Error(`Invalid duration: ${text}`);
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"]!;
  return Math.round(Number(match[1]) * scale);
}

function parseArgs(argv: string[]): { opts: ProxyOptions; command: string[]; cacheDir?: string } {
  let cacheDir: string | undefined = defaultCacheDir();
  const opts: ProxyOptions = {
    softTimeoutMs: 20_000,
    ttlMs: 3_600_000,
    pollIntervalMs: 2000,
    fallbackTools: true,
  };
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);

  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    const value = () => {
      const v = own[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "-h" || arg === "--help") {
      console.error(USAGE);
      process.exit(0);
    } else if (arg === "--after") opts.softTimeoutMs = parseDuration(value());
    else if (arg === "--ttl") opts.ttlMs = parseDuration(value());
    else if (arg === "--poll") opts.pollIntervalMs = parseDuration(value());
    else if (arg === "--cache-dir") cacheDir = value();
    else if (arg === "--no-cache") cacheDir = undefined;
    else if (arg === "--only") opts.only = new Set(value().split(",").map((s) => s.trim()).filter(Boolean));
    else if (arg === "--no-fallback-tools") opts.fallbackTools = false;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (command.length === 0) throw new Error("Missing server command after --");
  return { opts, command, cacheDir };
}

function main(): void {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`mcp-coatcheck: ${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { opts, command, cacheDir } = parsed;
  if (cacheDir !== undefined) {
    try {
      opts.cache = new DiskCache(cacheDir, command, process.cwd());
    } catch (err) {
      console.error(`mcp-coatcheck: cannot open result cache: ${(err as Error).message}. Use --cache-dir or --no-cache.`);
      process.exit(1);
    }
    setInterval(() => opts.cache?.sweep(), 60_000).unref();
  }

  const child = spawnServer(command);

  const write = (stream: NodeJS.WritableStream) => (msg: any) => stream.write(JSON.stringify(msg) + "\n");
  const proxy = new CoatcheckProxy(opts, write(process.stdout), write(child.stdin));

  pipeLines(process.stdin, (msg) => proxy.fromClient(msg), (line) => child.stdin.write(line + "\n"));
  pipeLines(child.stdout, (msg) => proxy.fromServer(msg), (line) => process.stdout.write(line + "\n"));

  process.stdin.on("end", () => child.stdin.end());
  // A write racing the server's exit fails with EPIPE; the exit handler below takes over.
  child.stdin.on("error", () => {});
  // The client went away: nobody is left to answer, so shut down with the server.
  process.stdout.on("error", () => {
    child.kill();
    process.exit(0);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      child.kill(signal);
      process.exit(0);
    });
  }
  child.on("error", (err) => {
    console.error(`mcp-coatcheck: could not start ${command[0]}: ${err.message}`);
    process.exit(1);
  });
  // Let the last answers reach the client before exiting with the server.
  child.on("exit", (code, signal) => process.stdout.write("", () => process.exit(code ?? (signal ? 1 : 0))));
}

function spawnServer(command: string[]) {
  const stdio: ["pipe", "pipe", "inherit"] = ["pipe", "pipe", "inherit"];
  if (process.platform !== "win32") return spawn(command[0], command.slice(1), { stdio });
  // npx and friends are .cmd shims on Windows, so they need cmd.exe. Quote
  // each part ourselves so paths like C:\Program Files\... survive.
  const quote = (part: string) => (/[\s"&|<>^()]/.test(part) ? `"${part.replace(/"/g, '""')}"` : part);
  return spawn(command.map(quote).join(" "), { stdio, shell: true });
}

/** Reads newline delimited JSON. Lines that don't parse are passed through as is. */
function pipeLines(input: NodeJS.ReadableStream, onMessage: (msg: any) => void, onRaw: (line: string) => void): void {
  createInterface({ input, crlfDelay: Infinity }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      onRaw(line);
      return;
    }
    onMessage(msg);
  });
}

main();
