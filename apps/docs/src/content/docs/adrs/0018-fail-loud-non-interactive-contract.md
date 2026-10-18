---
title: "Fail-Loud Non-Interactive Contract"
description: "Every CLI prompt refuses with a named error and a re-run flag when automation cannot answer it, instead of silently skipping."
---

* **Status:** Accepted
* **Date:** 2026-10-18

## Context and Problem Statement

Clack prompts with closed stdin neither resolve nor throw — the process silently exits 0 or stalls. Our prompt gates grew up ad hoc: `apply`/`destroy`/`gc` gated on `shouldAutoApprove` (explicit flags only, no TTY/CI awareness), `secrets` checked CI-but-not-TTY, `sync-ai` checked nothing and "succeeded" writing zero files. Any automation that forgot `--headless` hit silent skips instead of loud refusals — including the `apply` preview gate silently skipping a deploy.

A TTY-aware helper (`resolveHeadless`: explicit flags + CI + stdin/stdout TTY) already existed and two commands used it, but adoption was spotty and each command invented its own refusal shape.

## Decision Drivers

* **No silent skips:** a non-interactive run must fail with a named error, never exit 0 having done nothing.
* **Actionable errors:** the refusal must name the exact re-run flag, not just the missing input.
* **Explicit intent wins:** approval flags (`--yes`, `--auto-approve`, `--headless`) always bypass the gate — automation that states its intent keeps working.
* **Telemetry continuity:** new codes ride existing per-command events (`error_code` + `reason: non-interactive`) so dashboards need no new event plumbing.

## Considered Options

1. **Auto-approve when headless.** (Rejected: silently approves destruction — a bare `destroy` in CI must never proceed.)
2. **Per-command ad-hoc headless branches (status quo).** (Rejected: proven inconsistent — every new prompt re-decides, and the default outcome is a silent skip.)
3. **Shared gate + named codes.** One helper (`refuseIfNonInteractive`) placed after arg validation, before the first prompt; each command gets a named `*_NON_INTERACTIVE` code whose hint names the remedy flag.

## Decision Outcome

**Chosen Option:** The shared gate. When the caller is headless-inferred (explicit `--headless`, `CI=true`, or no TTY) without an approval flag, the command fails via `failCommand` (exit 1, message + hint) instead of reaching the prompt. Eleven commands adopted the helper (`add`, `alerts`, `apply`, `destroy`, `domain remove`, `eject`, `gc`, `rollback`, `secrets push`/`pull`, `sleep`); two are bespoke because no approval flag can answer their questions — `init` refuses inferred-headless wizard runs (`INIT_NON_INTERACTIVE`, pointing at `--headless --framework`), and `sync-ai` refuses all headless runs (assistant selection is prompt-only). Pre-existing `resolveHeadless` loud-refusal branches (`db import`/`restore`/`migrate`, sleeping-environment and ejected-tree guards) were kept as-is.

The full gate catalog lives in the [Headless Mode guide](/grada/guides/headless/), and each gated command page carries a one-line Automation note naming its code.

### Positive Consequences

* Pipelines fail fast with the remedy in the message (`--yes`, `--auto-approve`, `--model`/`--domain`, `--email`/`--webhook`, explicit revision) instead of hanging or no-op succeeding.
* One helper constrains all future prompts: the convention is "gate after validation, before the first prompt," proven by unit tests per command plus an inferred-headless guard suite.
* No telemetry changes: new codes ride existing events, verified per command.

### Negative Consequences

* Inferred-headless can surprise: a bare command in CI that once scaffolded now exits 1 (e.g. `alerts` without destination flags needs explicit `--headless` for the manual-subscribe path) — the intended trade, but a behavior change.
* The gate is convention, not compiler-enforced: each new prompt must remember to call the helper (review checklist item, not architecture).
* Two vocabularies to explain: approval flags (explicit intent, bypass) vs headless inference (environment detection, refuses) — contributors must learn which failure mode they are looking at.
