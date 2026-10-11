---
title: eject
description: Decouple your project from grada into vanilla Terraform.
---

Take permanent, sole ownership of your infrastructure files when you no longer want the CLI managing them, while keeping everything running in AWS.

## What it does

- Asks for explicit confirmation (defaulting to "No"); declining cancels with no changes. With `--yes` (or the global `--headless` flag), ejection proceeds without prompting.
- Refuses to eject an asleep stack blindly: ejecting while ECS is at 0 and RDS is stopped would hand over Terraform that disagrees with live state, so a raw `terraform apply` would half-wake it (tasks up, database still down). Interactively you are offered to wake first; headless runs refuse with an `EJECT_WHILE_ASLEEP` error unless `--force` is passed, in which case the sleep ledger migrates into a committed `SLEEPING.md` handoff doc (recorded desired counts, database state, and wake-without-grada commands).
- Strips grada metadata from your local files: removes the `# grada generated infrastructure` header and the `default_tags { tags = { ManagedBy = "grada", GradaProject = "<project>" } }` block from `terraform/main.tf`, and removes the `# grada backups` block from `.gitignore`. Tag blocks you extended with your own tags are left untouched.
- Recursively deletes every `*.bak.*` backup file in the project (skipping `node_modules` and `.git`).
- Writes a committed `STATE_BUCKET_CLEANUP.md` runbook with the exact manual commands to empty and delete the state bucket (eject never deletes the bucket itself — the state is your only map of live infra), plus secrets-rotation notes and start commands for any stopped databases.
- Leaves your infrastructure fully operational as raw, standalone Terraform. As a final step, run `terraform apply` inside `terraform/` so AWS syncs state and removes the live `ManagedBy` tags.
- Records the ejection in gitignored local state (`.grada/ejected.json`) plus a committed `.grada-ejected` sentinel, so later `add` runs warn and render new files without managed headers to match the vanilla tree, re-running `init` asks for explicit confirmation (or `--force`) before re-applying managed metadata — and fresh clones refuse to silently re-manage the tree.
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
| `--force` | Eject even while the stack is asleep (the sleep ledger migrates to `SLEEPING.md`); also re-manages ejected trees. |
| `--headless` | Global automation flag; implies `--yes` for this command. |

## See also

- [apply](/grada/cli/apply/)
- [destroy](/grada/cli/destroy/)
