---
title: eject
description: Decouple your project from grada into vanilla Terraform.
---

Take permanent, sole ownership of your infrastructure files when you no longer want the CLI managing them, while keeping everything running in AWS.

## What it does

- Asks for explicit confirmation (defaulting to "No"); declining cancels with no changes. With `--yes` (or the global `--headless` flag), ejection proceeds without prompting.
- Strips grada metadata from your local files: removes the `# grada generated infrastructure` header and the `default_tags { tags = { ManagedBy = "grada" } }` block from `terraform/main.tf`, and removes the `# grada backups` block from `.gitignore`.
- Recursively deletes every `*.bak.*` backup file in the project (skipping `node_modules` and `.git`).
- Leaves your infrastructure fully operational as raw, standalone Terraform. As a final step, run `terraform apply` inside `terraform/` so AWS syncs state and removes the live `ManagedBy` tags.
- Records the ejection in gitignored local state (`.grada/ejected.json`), so later `add` runs warn and render new files without managed headers to match the vanilla tree, and re-running `init` asks for explicit confirmation (or `--force`) before re-applying managed metadata.
- Emits a `project_ejected` telemetry event. This cannot be undone.

## Usage

```bash
npx grada-run eject
npx grada-run eject --yes
```

## Flags

| Flag | Description |
| ---- | ----------- |
| `--yes` | Skip the confirmation prompt for non-interactive runs. |
| `--headless` | Global automation flag; implies `--yes` for this command. |

## See also

- [apply](/grada/cli/apply/)
- [destroy](/grada/cli/destroy/)
