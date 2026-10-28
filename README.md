<div align="center">

# 🎫 mcp-coatcheck

**MCP Tasks for any MCP server.**<br>
Hand over a slow tool call, get a ticket, pick up the result later.

[![license: MIT](https://img.shields.io/badge/license-MIT-4ade80?style=flat-square)](LICENSE)
[![dependencies: 0](https://img.shields.io/badge/dependencies-0-7aa2f7?style=flat-square)](package.json)
[![MCP 2025-11-25](https://img.shields.io/badge/MCP-2025--11--25-c4a7ff?style=flat-square)](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-c4a7ff?style=flat-square)](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks)

<img src="https://raw.githubusercontent.com/emrehangorgec/mcp-coatcheck/main/demo/demo.gif" alt="Side by side: without coatcheck the 40 second tool call hits a 15 second timeout; with coatcheck it moves to the background and the result is collected" width="900">

<sub>Two real Claude Code runs with a 15s MCP tool timeout, replayed at 3× speed. <a href="https://github.com/emrehangorgec/mcp-coatcheck/raw/main/demo/demo.mp4">MP4</a> · <a href="#how-the-demo-was-made">how it was made</a></sub>

</div>

## The problem

Your agent calls a tool that takes a few minutes: a test suite, a build, a crawl, an eval. One of two things happens:

* **The call times out.** Most MCP clients cap how long a single tool call may run, and the work is lost.
* **The chat freezes** until the tool returns.

[MCP Tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks) fix this. The server hands back a task id right away and the client collects the result later. But almost no server implements Tasks yet, and most clients don't speak them either.

## The fix

A tiny proxy for any stdio MCP server. No server changes needed.

<p align="center"><img src="https://raw.githubusercontent.com/emrehangorgec/mcp-coatcheck/main/demo/flow.svg" alt="Agent talks to mcp-coatcheck, which talks to your unchanged MCP server" width="760"></p>

Every call goes through. If it finishes within `--after`, the agent gets the normal result and nothing changes. If it doesn't, coatcheck hands the agent a ticket and keeps the call running:

| The client speaks | The agent gets | Then |
|---|---|---|
| Tasks, 2025-11-25 | a real task, right away | `tasks/get`, `tasks/result`, `tasks/cancel` |
| Tasks, 2026-07-28 | `resultType: "task"` after `--after` | `tasks/get`, `tasks/cancel` |
| No Tasks at all | a job id and instructions, after `--after` | `coatcheck_result`, `coatcheck_status`, `coatcheck_cancel` tools |

No call ever blocks longer than `--after`, including `coatcheck_result`. Set it below your client's tool timeout and timeouts are gone.

## Quick start

Put `npx mcp-coatcheck --` in front of the command you already use.

**Claude Code**

```bash
claude mcp add my-server -- npx -y mcp-coatcheck -- npx -y some-slow-mcp-server
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.my-server]
command = "npx"
args = ["-y", "mcp-coatcheck", "--", "npx", "-y", "some-slow-mcp-server"]
```

**Cursor, Gemini CLI, VS Code, anything with a JSON config**

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "mcp-coatcheck", "--", "npx", "-y", "some-slow-mcp-server"]
    }
  }
}
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `--after <duration>` | `20s` | Longest any single call may block. Keep it below your client's tool timeout. |
| `--ttl <duration>` | `1h` | How long finished results are kept |
| `--poll <duration>` | `2s` | Polling interval suggested to Tasks clients |
| `--only <a,b>` | all tools | Only these tools may move to the background |
| `--no-fallback-tools` | | Don't add the `coatcheck_*` tools |

Durations look like `500ms`, `20s`, `2m`, `1h`.

## What has been tested

| Client | Mode | Result |
|---|---|---|
| Claude Code 2.1.312 (`claude -p`) | job id fallback | ✅ 40s call under a 15s tool timeout: plain server times out, coatcheck returns the result |
| [mcpc](https://github.com/apify/mcpc) 0.7.0 | Tasks 2025-11-25 | ✅ `--detach`, `tasks-get`, `tasks-result`, `tasks-cancel`, failed tasks. Without coatcheck mcpc refuses: *"This server does not support task-augmented tool calls"* |
| mcpc + [`@modelcontextprotocol/server-everything`](https://www.npmjs.com/package/@modelcontextprotocol/server-everything) | Tasks 2025-11-25 | ✅ its `trigger-long-running-operation` tool runs as a task, quick tools pass straight through |
| 2026-07-28 Tasks | | ✅ covered by the test suite. Not yet tried with a real client |
| Codex, Cursor, Gemini CLI | job id fallback | not yet tried. Reports welcome |

`npm test` starts the real proxy around [`examples/slow-server.mjs`](examples/slow-server.mjs) and runs 14 end to end checks across all three modes, including cancellation races and late answers.

## Good to know

* If the wrapped server already supports Tasks, coatcheck notices during the handshake and gets out of the way.
* Results live in memory. Restarting the proxy loses running jobs.
* `tasks/list` is not offered: the proxy cannot tell callers apart, so listing would show one caller another's tasks. Task ids are random UUIDs.
* stdio only for now. Streamable HTTP is next.
* If the wrapped server asks the user something (elicitation) while a call runs in the background, the request is forwarded but not tied to the task yet.

## Try it locally

```bash
git clone https://github.com/emrehangorgec/mcp-coatcheck
cd mcp-coatcheck
npm install
npm test
node dist/cli.js --after 3s -- node examples/slow-server.mjs
```

`examples/slow-server.mjs` is a tiny MCP server with a quick `echo` tool and a `run_tests` tool that takes 20 seconds by default.

## How the demo was made

The GIF replays two real `claude -p` runs with `MCP_TOOL_TIMEOUT=15000` against `examples/slow-server.mjs`, one plain and one behind `mcp-coatcheck --after 10s`. Tool calls, results and agent messages are copied from the `stream-json` output. [`demo/demo.html`](demo/demo.html) draws them on a timeline. Open it in a browser to watch it live.

## License

MIT
