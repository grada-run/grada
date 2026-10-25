---
title: eject
description: Decouple your project from grada into vanilla Terraform.
---

Take permanent, sole ownership of your infrastructure files when you no longer want the CLI managing them, while keeping everything running in AWS.

## What it does

- Asks for explicit confirmation (defaulting to "No"); declining cancels with no changes. **This cannot be undone.**
- Strips grada metadata from your files and deletes local backup files, leaving your infrastructure fully operational as raw, standalone Terraform — finish with `terraform apply` inside `terraform/`.
- Refuses to eject an asleep stack blindly (the handed-over Terraform would disagree with live state) — wake first when offered.
- Writes a committed `STATE_BUCKET_CLEANUP.md` runbook with the manual state-bucket teardown commands (eject never deletes the bucket itself).
- Later `add` runs warn and match the vanilla tree, and re-running `init` asks before re-applying managed metadata.

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

## Automation & edge cases

- Headless runs refuse asleep stacks with `EJECT_WHILE_ASLEEP` unless `--force` is passed, migrating the ledger to a committed `SLEEPING.md` handoff (recorded desired counts, database state, wake-without-grada commands). Non-interactive runs without `--yes` fail with `EJECT_NON_INTERACTIVE`. Full catalog: [Headless Mode](/grada/guides/headless/).
- Removed metadata: the `# grada generated infrastructure` header and `ManagedBy`/`GradaProject` tag block from `terraform/main.tf`, the `# grada backups` block from `.gitignore`, and every Grada backup (`*.bak.<timestamp>` shape only — your own lookalike files survive; skipping `node_modules` and `.git`). Tag blocks you extended stay untouched.
- Ejection is recorded in gitignored `.grada/ejected.json` plus a committed `.grada-ejected` sentinel, so fresh clones refuse to silently re-manage the tree.
- Adopted trees keep their OIDC adoption: when `terraform/grada.auto.tfvars` exists, eject appends a `!terraform/grada.auto.tfvars` negation after the scaffolded `*.auto.tfvars` ignore, so fresh clones apply without the provider collision (other auto.tfvars files stay ignored).

## See also

- [apply](/grada/cli/apply/)
- [destroy](/grada/cli/destroy/)
