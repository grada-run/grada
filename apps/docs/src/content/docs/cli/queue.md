---
title: queue
description: Move dead-letter queue messages back to the primary queue after fixing the consumer.
---

Recover from poison messages without touching the AWS console: `queue redrive` moves DLQ messages back to the primary queue once the consumer is fixed.

## Commands

```bash
npx grada-run queue redrive                  # Move DLQ messages back (asks first)
npx grada-run queue redrive --yes            # Skip the prompt (scripts, CI)
npx grada-run queue redrive --workspace pr-7 # Redrive a preview environment's queues
```

The command resolves the queue pair from your tree (`<app>-queue` / `<app>-dlq`, hashed names included), reports an empty DLQ as success without calling AWS further, and refuses without `--yes` when there is no terminal to ask. The move itself runs as an SQS message-move task; the printed task handle tracks it.

## Flags

| Flag | Description |
| ---- | ----------- |
| `--project-name <name>` | Explicit project name override (defaults to `app_name` in `terraform/main.tf`, then the current directory name). |
| `--workspace <name>` | Redrive a preview environment's queues instead of the default workspace. |
| `--region <region>` | Explicit AWS region override. |
| `--yes` | Skip the confirmation prompt. Intended for scripts and CI. |

Redrive only after fixing the consumer — moving poison messages back into a still-broken consumer just refills the DLQ and refires the alarm. See [Redriving the DLQ](/grada/guides/alert-notifications/#redriving-the-dlq) for the full runbook.
