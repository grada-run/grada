---
title: "ECS Fargate and ALB as the Single Runtime Target"
description: "Run every supported framework on ECS Fargate behind an application load balancer."
---

* **Status:** Superseded by [ADR-0014](/grada/adrs/0014-multiple-compute-targets/) — Lambda and static targets added; ECS Fargate + ALB remains the default.
* **Date:** 2026-09-24 (Retroactive)

## Context and Problem Statement

`grada` promises that any supported framework deploys with one command. Every framework-specific Dockerfile, health-check rule, Terraform module (`templates/terraform/`), and diagnostic runbook only works if there is exactly one production runtime to target.

We needed to pick a single AWS compute and ingress combination that covers long-running web servers, workers, and static sites without per-framework infrastructure branches.

## Decision Drivers

* **Uniformity:** One set of Terraform modules, one container contract, one diagnostic story for all frameworks.
* **No-ops fit:** Users choosing this tool do not run an infra team; the runtime must be serverless and scale to zero operational burden.
* **Health-checkability:** The load balancer must probe container health so failed deploys surface as ALB signals, not silent black holes.

## Considered Options

1. **AWS Lambda / App Runner per framework.** (Rejected: request/response and timeout limits exclude long-running servers and workers; would force framework-specific branches.)
2. **EC2 / self-managed clusters.** (Rejected: reintroduces the server management the tool exists to remove.)
3. **ECS Fargate + Application Load Balancer.** Containers stay portable across frameworks; ALB gives path-based health checks, listener rules (translated from `vercel.json`), and zero-downtime rolling deploys.

## Decision Outcome

**Chosen Option:** ECS Fargate + ALB for all dynamic workloads. Every generated project provisions the same cluster/service/ALB shape; only the image contents and container port vary per framework.

### Positive Consequences
* Framework support reduces to Dockerfile + port + bind-address requirements (`src/utils/detector.js`, `src/utils/warnings.js`).
* `diagnose` can assume ALB health-check semantics for every project.
* Static sites reuse the same pipeline with an Nginx image instead of a framework server.

### Negative Consequences
* Cold-start-sensitive or GPU workloads are out of scope; the tool cannot serve them without a second runtime target.
* Users pay Fargate minimums even for idle preview environments.
