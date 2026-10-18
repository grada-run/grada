---
title: Troubleshooting a Live Service
description: The status → diagnose → logs → exec debug loop for finding why your service errors, without opening the AWS console.
---

When something is wrong with the running service, work this loop in order — each step narrows the search for the next. Everything here is read-only until the fix step.

## 1. status: is it the service?

```bash
npx grada-run status
npx grada-run status --watch   # repaint every 10s during a deploy or incident
```

The dashboard shows desired vs running tasks, alarm states, and live Golden Signals (traffic, errors, latency, CPU/memory, database load). If replicas are at zero on a service that should be running, check whether the environment is [asleep](/grada/cli/sleep/) (`wake` restores it) before assuming a crash.

## 2. diagnose: why did it stop?

```bash
npx grada-run diagnose
npx grada-run wtf   # same command, shorter to type mid-incident
```

`diagnose` finds the most recently stopped task and reports the stopped reason, the failing container, its exit code, and how long ago — plus the crashed task's own log lines first, then the last hour of group-wide events. If a newer revision or a running task already superseded the crash, it says so in one line instead of alarming you about stale history. On Lambda projects it checks function state and tails recent log events; on static projects there is nothing to inspect, so `status` is the tool.

## 3. logs: what did it say?

```bash
npx grada-run logs --tail 100 --error   # error lines only
npx grada-run logs -f --since 5m        # follow live, last 5 minutes
```

Use `logs` when `diagnose` points at the app rather than the platform: full-text search across the log group, error filtering, and follow mode for watching a fix land. If the log group itself is missing, the CLI prints the matching `aws logs describe-log-groups` lookup instead of an error dump.

## 4. exec: look inside the running container

```bash
npx grada-run exec                                   # shell in the newest running task
npx grada-run exec --command "./scripts/check.sh"    # one-shot, exits with the command's code
```

`exec` drops you into a shell in the newest actually-`RUNNING` task (still-provisioning tasks are skipped). One-shot `--command` runs gate correctly in scripts: the CLI exits with the session's own exit code, so `exec --command "./migrate.sh" && deploy` only deploys on success.

## 5. Fix and verify

- **Bad deploy?** Your service ships with a deployment circuit breaker — failed deploys roll back automatically. To return to an earlier revision yourself, [`rollback`](/grada/cli/rollback/) (pass a revision, or pick from the interactive list).
- **Config or infra change?** Edit, then [`apply`](/grada/cli/apply/) — interrupted runs and target switches are surfaced before anything provisions.
- **Woke to crash loops?** `wake` fails fast with the named cause (`ECS_WAKE_CRASH_LOOP`, `ECS_WAKE_PULL_FAILURE`) instead of waiting out the timeout — the restore already applied, so inspect with `status` and fix the task before retrying.
- **Expired credentials?** Every command above points at `aws sso login` / `aws configure` and the [AWS credentials guide](/grada/guides/aws-credentials/) instead of dumping SDK errors.
- **Something else changed out-of-band?** [`drift`](/grada/cli/drift/) diffs live AWS state against Terraform locally; the scheduled workflow posts larger findings to a GitHub Issue.

If the tooling itself is suspect (missing Terraform, broken AWS CLI, stuck state lock), [`doctor`](/grada/cli/doctor/) runs the pre-flight checks — `--deep` adds state-lock holder details.

## See also

- [status](/grada/cli/status/), [diagnose](/grada/cli/diagnose/), [logs](/grada/cli/logs/), [exec](/grada/cli/exec/)
- [rollback](/grada/cli/rollback/) for deployment recovery
- [ADR-0004: IaC-Driven Diagnostic Context](/grada/adrs/0004-iac-driven-diagnostic-context/)
