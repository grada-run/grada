---
title: "Native MCP Server for AI Agents"
description: "The CLI embeds a Model Context Protocol server so editors operate Grada stacks without leaving the agent loop."
---

* **Status:** Accepted
* **Date:** 2026-10-03 (Retroactive)

## Context and Problem Statement

Users increasingly drive infrastructure through AI coding agents (Cursor, Claude, Windsurf, Zed, VS Code, Gemini CLI). Shelling out to `grada` from an agent works but loses structure: prompts hang, stdout mixes logs with results, and every editor needs bespoke wiring. We wanted agents to inspect stacks, provision add-ons, and check health/logs/secrets as first-class tools — with zero hosted infrastructure on our side.

## Decision Drivers

* **Zero hosting:** Grada provisions no central service; the agent must spawn everything locally.
* **Isolation:** The MCP layer must wrap existing programmatic entrypoints without refactoring command logic.
* **Editor breadth:** One install command should wire every major editor; unknown clients fall back to a documented manual snippet.

## Considered Options

1. **Separate daemon process.** (Rejected: a second binary to version, distribute, and keep in sync with the CLI.)
2. **Hosted bridge service.** (Rejected: violates the zero-hosting constraint and adds an auth/scale story.)
3. **Embedded server (`grada mcp`).** Five tools (`analyze_stack`, `add_primitive`, `stack_status`, `fetch_logs`, `audit_secrets`) over STDIO by default, wrapping the same functions the CLI calls; wrapped commands that print to stdout or call `process.exit` are captured into structured error results so one bad call never corrupts the JSON-RPC stream. `mcp --install` writes the server entry into all six editors' configs, and `--transport http` serves the same tools over Streamable HTTP for users who self-host the bridge behind their own tunnel.

## Decision Outcome

**Chosen Option:** Embedded STDIO server with a self-hosted HTTP bridge option.

### Positive Consequences
* Agents inherit every CLI capability (including `--json` payloads like Golden Signals) with no per-feature MCP work.
* No Grada-operated infrastructure: users self-host the HTTP transport behind their own tunnel, and the CLI warns whenever HTTP binds a non-loopback address (the transport has no authentication).

### Negative Consequences
* STDIO ties the server lifetime to the editor session — no background alerting or scheduled agent runs.
* The unauthenticated HTTP transport is a footgun if exposed raw; safety rests on the localhost default plus the bind warning.
