---
title: sync-ai
description: Regenerate AI assistant rules for an existing project.
---

Give your AI coding assistants up-to-date grada context after project settings change, so they generate correct Terraform and deployment instructions instead of hallucinating them.

## What it does

- Prompts you to choose which AI assistants to configure, then writes the matching rule files with your project's region (from `region` in `terraform/main.tf`), container port (from `containerPort`), and detected compute target (`ecs`, `lambda`, or `static`) so the architecture notes describe your actual topology.
- Every generated file carries three proactive guardrails: run `terraform validate` after any `.tf` edit, prompt `grada secrets audit` (then `secrets push`) when `.env` keys change, and remind the user to run `grada apply` when a `package.json` build script or framework output directory changes.
- Writes a full rule file for Cursor (`.cursor/rules/grada.mdc`), Roo (`.roo/rules/grada.md`), and Continue (`.prompts/grada.prompt`); injects a managed block into the existing config for Trae (`.trae/rules/project_rules.md`), Windsurf (`.windsurfrules`), Copilot (`.github/copilot-instructions.md`), Claude (`CLAUDE.md`), Goose (`.goosehints`), and Aider (`.aider.conf.yml`).
- Exits without writing anything when no assistants are selected.
- Emits a `sync_ai_executed` telemetry event listing the selected assistants.

## Usage

```bash
npx grada-run sync-ai
```

## Flags

This command accepts no CLI flags. Assistant selection is interactive.

## See also

- [npx grada-run](/grada/cli/init/)
