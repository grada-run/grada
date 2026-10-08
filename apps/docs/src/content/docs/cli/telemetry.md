---
title: telemetry
description: Persistently disable, enable, or inspect anonymous usage telemetry on this machine.
---

Control whether `grada` collects anonymous, hashed usage data (framework presets used, deployment success rates). No codebase files, AWS credentials, or personal data are ever collected.

## What it does

- `telemetry off` persists an opt-out on this machine, covering every run including editor MCP servers. `telemetry on` re-enables collection.
- `telemetry status` prints whether telemetry is enabled and why — persistent preference, `DO_NOT_TRACK`, or test-runner detection.
- Precedence per run: `--no-telemetry` flag, then `DO_NOT_TRACK=1`, then the persistent preference. Enabling while `DO_NOT_TRACK` is set saves the preference but warns that telemetry stays off in that environment.
- This command never emits telemetry itself — not even on failure paths.

## Usage

```bash
grada telemetry off
grada telemetry on
grada telemetry status
npx grada-run --no-telemetry     # single-run opt-out
DO_NOT_TRACK=1 grada status     # environment opt-out
```

## See also

- [mcp](/grada/cli/mcp/)
