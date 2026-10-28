#!/usr/bin/env node
// A tiny MCP server with one quick tool and one slow tool, and no task support.
// Used for the demo and the tests:
//   npx mcp-coatcheck --after 3s -- node examples/slow-server.mjs
import { createInterface } from "node:readline";

const pending = new Map();
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
process.stdout.on("error", () => process.exit(0)); // the client is gone

const tools = [
  {
    name: "echo",
    description: "Returns the text right away.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "run_tests",
    description: "Pretends to run a slow test suite.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number", description: "How long the run takes." },
        ignore_cancel: { type: "boolean", description: "Keep running and answer even if cancelled." },
      },
    },
  },
  {
    name: "explode",
    description: "Always fails after a moment.",
    inputSchema: { type: "object", properties: {} },
  },
];

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.method === "notifications/cancelled") {
    clearTimeout(pending.get(JSON.stringify(msg.params.requestId)));
    return;
  }
  if (msg.id === undefined) return;

  switch (msg.method) {
    case "initialize":
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "slow-server", version: "0.0.1" },
        },
      });
    case "tools/list":
      return send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params;
      if (name === "echo") {
        return send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: args.text }] } });
      }
      if (name === "run_tests") {
        const ms = (args.seconds ?? 20) * 1000;
        const timer = setTimeout(() => {
          pending.delete(JSON.stringify(msg.id));
          send({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: `142 passed, 0 failed in ${ms / 1000}s` }] },
          });
        }, ms);
        if (!args.ignore_cancel) pending.set(JSON.stringify(msg.id), timer);
        return;
      }
      if (name === "explode") {
        return setTimeout(
          () => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "boom" }], isError: true } }),
          200,
        );
      }
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    }
    default:
      return send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  }
});
