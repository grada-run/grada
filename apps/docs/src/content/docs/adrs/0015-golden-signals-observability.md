---
title: "Golden Signals from Standard CloudWatch Metrics"
description: "Surface live ALB, ECS, and RDS telemetry in status using standard AWS metrics only — no custom metrics, no extra cost."
---

* **Status:** Accepted
* **Date:** 2026-10-04 (Retroactive)

## Context and Problem Statement

`status` originally reported desired-vs-running counts plus alarm states — enough to answer "is it up" but not "is it healthy". Users investigating latency, saturation, or error spikes still had to open the CloudWatch console. Meanwhile CloudWatch custom metrics bill per metric per month, so any telemetry that *publishes* new metrics would add a recurring charge to every project.

We needed live service telemetry in the terminal at strictly $0 extra AWS cost.

## Decision Drivers

* **Zero cost:** No custom metrics, no new infrastructure, no anomalous-spend surprise on any project.
* **No console:** Latency, traffic, errors, and saturation visible from `status` and `status --watch`.
* **Graceful degradation:** A telemetry failure must never fail the health check — signals degrade to `null` sections, not errors.
* **No local state:** Dimension discovery must query AWS live, never trust a local Terraform state file.

## Considered Options

1. **Publish custom metrics.** (Rejected: per-metric monthly charges on every project, plus new IAM and publish plumbing for data AWS already collects.)
2. **No live signals.** (Rejected: keeps `status` a coarse up/down check and preserves the console round-trip this work exists to remove.)
3. **Fetch standard AWS metrics.** Read the metrics AWS already emits — ALB request count, 5xx count, and p95 latency; ECS CPU and memory utilization; RDS connections (or Aurora ACUs) — over a short recent window, and render them as dashboard sections.

## Decision Outcome

**Chosen Option:** Fetch standard metrics via `fetchGoldenSignals` (`src/utils/golden-signals.js`). ALB dimensions resolve live through an `DescribeLoadBalancers` call (`@aws-sdk/client-elastic-load-balancing-v2`) so the exact `app/<name>/<id>` string never depends on local state; database signals branch on the discovered engine (Aurora cluster ACUs vs. instance CPU/connections). Any fetch failure degrades that section to `null` while the health verdict proceeds. Lambda targets report `signals: null` (no ALB or ECS to read; function-call metrics are future work), and `--watch` loops skip auto-diagnose to avoid terminal spam and API throttling.

### Positive Consequences

* Real latency/error/saturation signal in the terminal with zero new AWS resources and zero new charges.
* The `--json` payload carries the same signals, so the MCP `stack_status` tool and scripts inherit them for free.
* Degradation is total-proof: missing permissions or missing metrics yield empty sections, never a failed health check.

### Negative Consequences

* Standard metrics lag real time by a minute or more — signals describe the recent past, not this second.
* Lambda and static projects get reduced or no signals until function- and distribution-level metrics are added.
* Each status run costs several CloudWatch `GetMetricData`-class reads; `--watch` multiplies that (still inside the free tier at dashboard cadence, but not free of API calls).
