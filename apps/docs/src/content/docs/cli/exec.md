---
title: exec
description: Open an interactive shell inside your running ECS container.
---

Drop into a secure shell inside your live Fargate container to inspect files, check environment variables, or debug a running app — without opening the AWS console.

## What it does

- Finds a running container for the current project automatically and opens an interactive shell (`/bin/sh` by default) via ECS Exec.
- Checks the AWS CLI and Session Manager plugin first, printing install instructions for anything missing instead of failing cryptically.
- When no containers are running, explains what to do (`status`, `apply`) and exits 1.
- Lambda and static projects have no shell to attach to — the command says so up front and points you to `logs` instead.

## Usage

```bash
npx grada-run exec
npx grada-run exec --command /bin/bash
npx grada-run exec --service myapp-service --container myapp-container
```

Type `exit` to leave the shell.

## Flags

| Flag | Description |
| ---- | ----------- |
| `[service]` | Service to connect to. Defaults to the project service. |
| `--service <name>` | Explicit service name override. |
| `--cluster <name>` | Explicit cluster name override. |
| `--container <name>` | Explicit container name override. |
| `--command <cmd>` | Shell to open (default `/bin/sh`). |
| `--region <region>` | Explicit AWS region override. |

## Automation & edge cases

- Inputs resolve automatically: cluster, service, and container from the project name (overridable via `ECS_CLUSTER` / `ECS_SERVICE` / `ECS_CONTAINER`), region (`--region` → `AWS_REGION` → `terraform/main.tf` → `us-east-2`).
- On expired credentials you get the `aws sso login` / `aws configure` pointer and exit 1 instead of an error dump.

## Prerequisites

- Run `npx grada-run apply` first: ECS Exec access (`enable_execute_command` plus the container's session permissions) is provisioned with your infrastructure. If the connection is refused on an older deployment, re-run `apply` to enable it.
- Install the AWS CLI and the Session Manager plugin (`brew install session-manager-plugin` on Mac; the command prints the right instructions for your OS when it's missing). On expired credentials, refresh with `aws sso login` or `aws configure`. See the [AWS credentials guide](/grada/guides/aws-credentials/).

## See also

- [status](/grada/cli/status/)
- [logs](/grada/cli/logs/)
- [diagnose](/grada/cli/diagnose/)
