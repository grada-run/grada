---
title: "Multiple Compute Targets: ECS, Lambda, and Static"
description: "Support ECS Fargate, scale-to-zero Lambda, and zero-compute static targets behind one CLI and one detection scheme."
---

* **Status:** Accepted
* **Date:** 2026-10-04 (Retroactive)
* **Supersedes:** [ADR-0005](/grada/adrs/0005-ecs-fargate-alb-runtime-target/) (single runtime target)

## Context and Problem Statement

ADR-0005 picked ECS Fargate + ALB as the single runtime so every Dockerfile, Terraform module, and diagnostic runbook had exactly one production shape to target. That uniformity held until two workload shapes proved badly served by it: sporadic or bursty traffic paying the ~$31/mo idle floor for containers that sit warm doing nothing, and static sites burning Fargate minimums to serve files an Nginx container never needed to exist for.

We needed cheaper idle states without giving up the one-command story — and without forking the codebase into per-framework infrastructure branches.

## Decision Drivers

* **Cost spectrum:** Cover `$31/mo always-on` down to `$0/mo idle` with no application code changes between targets.
* **Orthogonality:** The target choice must stay independent of framework presets — one detection pipeline, one `Dockerfile` family, one CI shape per target.
* **Day-2 continuity:** Every command must either adapt to the target or fail with a clear, target-aware error — never a cryptic AWS lookup failure.
* **Single detection scheme:** The target must be inferable from the generated `terraform/main.tf` alone, so Day-2 commands need no extra state.

## Considered Options

1. **Single target plus sizing only.** (Rejected: smaller tasks lower the floor a little but can never reach $0 idle, and static-in-Nginx keeps paying for compute that serves files.)
2. **A second container runtime (e.g. App Runner).** (Rejected: same cost floor as Fargate, a new operational surface to learn, and still no scale-to-zero.)
3. **Lambda via Web Adapter plus S3 static.** The same container image runs on Lambda through the AWS Lambda Web Adapter extension (standard `app.listen(PORT)` servers handle API Gateway events with zero app changes); static drops compute entirely (private S3 bucket + CloudFront with Origin Access Control, no VPC, no Dockerfile, no secrets vault).

## Decision Outcome

**Chosen Option:** Three compute targets selected by `--target` (`ecs` default with a `fargate` synonym, `lambda`, `static`), prompted interactively when the flag is absent. Target detection reads `terraform/main.tf` (`readTerraformComputeTarget` / `detectComputeTargetFromMainTf`); the generator renders per-target file sets from one dispatch table (`targetFileSets` in `src/utils/generator.js` — adding a target means adding one entry, never another ternary).

Guardrails keep invalid combinations out at scaffold time: `--target static` with a non-static framework is a hard validation error (`STATIC_TARGET_FRAMEWORK_MISMATCH`); Lambda skips ECS-only scaffolding (worker service, ALB listener rules, pre-deploy migration gate); static additionally skips the VPC, secrets vault, Dockerfile, and PR preview workflows, warning when detected inputs (worker, database) are dropped.

### Positive Consequences

* Idle cost becomes a choice, not a floor: `$0/mo` Lambda and static targets for sporadic and file-serving workloads, Fargate for steady traffic.
* Framework support still reduces to Dockerfile + port + bind address; targets reuse the same ECR, IAM, secrets (Lambda), and CloudFront layers.
* Day-2 commands resolve the target from IaC, preserving the stateless-CLI philosophy of [ADR-0004](/grada/adrs/0004-iac-driven-diagnostic-context/).

### Negative Consequences

* A Day-2 behavior matrix to maintain forever: `exec`, `rollback`, and `alerts` are ECS-only; `status`, `diagnose`, `logs`, `sleep`, and `db` adapt or degrade per target; `add` scaffolds infra on static but skips runtime env injection.
* Lambda VPC networking has no NAT gateway, so VPC-attached functions cannot reach the public internet — a documented tradeoff, not a bug.
* Static cannot use `domain add` yet (it patches `terraform/cloudfront.tf`, which static never generates) and prints no `site_url` from `apply` until the outputs reader learns it.
