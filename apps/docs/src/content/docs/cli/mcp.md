---
title: mcp
description: Serve the native MCP server so AI agents can inspect and operate your infrastructure.
---

Let AI coding assistants inspect and operate your infrastructure directly — stack analysis, add-on provisioning, live status, logs, and secrets drift — over the [Model Context Protocol](https://modelcontextprotocol.io). No hosting needed: your agent spawns the server locally on demand.

## What it does

- Serves 5 tools over STDIO (the default): `analyze_stack` (framework/compute detection), `add_primitive` (headless `grada add`), `stack_status` (live ECS/Lambda health), `fetch_logs` (CloudWatch logs), and `audit_secrets` (local vs AWS secrets drift, key names only).
- Keeps the JSON-RPC stream pure: command output is captured during tool calls and internal `process.exit` failures are converted into structured error results, so the server survives errors instead of crashing.
- Serves the same tools over stateless Streamable HTTP (`--transport http`) on `/mcp` for your own tunnels and container hosts. The HTTP transport is user-hosted only (Grada runs no central instance) and has no authentication: bind it to localhost or expose it only behind a trusted tunnel you control.
- Installs the server entry into your editor's MCP config with `--install <editor>` (`windsurf`, `zed`, `cursor`, `vscode`, `claude-desktop`, `gemini-cli`), preserving existing keys and servers.
- Emits an `mcp_install` telemetry event on installs; tool calls emit the wrapped command's own telemetry with the real command name.

## Usage

```bash
npx grada-run mcp                                    # STDIO server (default)
npx grada-run mcp --transport http --port 3000       # HTTP bridge on localhost:3000/mcp
npx grada-run mcp --install cursor                   # one-command editor setup
```

Manual config for any other MCP client (Claude Code plugins, Cline, Continue):

```json
{
    "mcpServers": {
        "grada": { "command": "npx", "args": ["grada-run", "mcp"] }
    }
}
```

## Flags

- `--install <editor>`: write the server entry to the editor's MCP config instead of starting a server. Supported editors: `windsurf` (`~/.codeium/windsurf/mcp_config.json`), `zed` (`~/.config/zed/settings.json`), `cursor` (`~/.cursor/mcp.json`), `vscode` (user `mcp.json`, default profile), `claude-desktop` (OS app-data config), `gemini-cli` (`~/.muse/settings.json`).
- `--transport <stdio|http>`: transport to serve (default: `stdio`).
- `--port <n>`: HTTP port, 1–65535 (default: `3000`). HTTP only.
- `--host <addr>`: HTTP bind address (default: `127.0.0.1`). HTTP only; binding a non-loopback address prints a no-auth warning.

## See also

- [sync-ai](/grada/cli/sync-ai/)
- [status](/grada/cli/status/)
- [logs](/grada/cli/logs/)
