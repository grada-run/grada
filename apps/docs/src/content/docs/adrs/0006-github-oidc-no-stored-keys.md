---
title: "GitHub OIDC Authentication, No Stored AWS Keys"
description: "Authenticate CI/CD with short-lived OIDC tokens instead of long-lived AWS keys."
---

* **Status:** Accepted (current state as of v0.49.5 below; per-version history at the end)
* **Date:** 2026-09-24 (Retroactive)

## Current State (as of v0.49.5)

CI authenticates via GitHub OIDC with no stored keys. Two least-privilege roles replace the original single admin role: a **deploy role** (mainline deploys + drift checks; trust bound to the deploy branch and the repo default branch, repo-scoped at scaffold) and a **preview role** (PR-triggered preview/teardown/plan workflows; trust bound to pull request events). Both start from `PowerUserAccess` + `IAMFullAccess` — no `AdministratorAccess` anywhere — with explicit deny guardrails on top. The deploy role cannot touch the audit/billing planes or delete the state bucket. The preview role cannot destroy production data (state, databases, snapshots, queues, tables, caches, images, services, secrets, log groups), mint EC2 compute, open IAM backdoors (no user or access-key creation), mutate the CI roles themselves (role/policy/trust changes on either CI role are denied, so PR-run Terraform cannot remove its own guardrails), or reach production compute (no task execution, task-definition registration, exec shells, service creation, `PassRole` on the app roles, or policy/trust/deletion writes on the task, execution, and scheduler roles). Guardrail resources name production only — exact ARNs or production-prefix-anchored wildcards (preview names carry `-pr-<n>-` where production carries the hex suffix, so anchored patterns never match preview resources); app-role ARNs are string-built so static trees validate, and describes stay allowed so `plan` keeps refreshing.

Every role preview credentials create must carry the **permissions boundary** (`CreateRole` without it is denied; the boundary cannot be swapped, removed, or neutered; every template-managed role carries it, and preview workspaces read the default workspace's copy). The boundary is a deny-list mirror of the guardrails (default-allow, so a missing entry weakens security instead of breaking prod tasks). Its IAM veto is an explicit list of role, policy, trust, boundary, and user-lifecycle writes — reads and cosmetic writes stay allowed — with `PassRole` carved out and re-gated by trio: passable only to the ECS tasks service, only for task roles, and production task roles passable only by the production scheduler role (no flat PassRole twin: an unconditional one vetoed the scheduler's own passing). Both task-execution twins exempt the scheduler principal by condition, so EventBridge triggers keep firing. Twin pairs share one resource list each, with a parity test failing the build on one-sided edits. Existing trees pick up changes by re-running setup, which regenerates `terraform/oidc.tf`.

## History

* v0.48.0: split the single admin role into deploy + preview least-privilege roles.
* v0.49.1: self-protecting guardrails (CI-role mutation deny, coverage gaps) + dual-branch deploy trust.
* v0.49.2: permissions boundary capping every preview-created role.
* v0.49.3: preview task-role confinement + boundary PassRole carve-out trio.
* v0.49.4: explicit IAM-write veto (replacing the over-broad clause) + anchored-wildcard resources for the policy size quota.
* v0.49.5: scheduler survives the boundary (flat PassRole twin removed, RunTask twins exempt the scheduler) + aurora setup-ci gate ids.

## Context and Problem Statement

The generated workflow (`templates/github/deploy.yml`) must authenticate to AWS on every run to sync Terraform and deploy containers. The conventional approach — storing `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` as GitHub secrets — creates rotation burden and a leak surface: any secret exfiltrated from CI grants durable AWS access.

We needed an authentication mechanism with no long-lived credential to store, rotate, or leak.

## Decision Drivers

* **Zero-secret CI:** Nothing credential-shaped should live in the repository or GitHub secret store.
* **Least privilege:** Each run should receive credentials scoped to that run only.
* **First-deploy fit:** Setup must work on a fresh AWS account without pre-provisioned IAM users.

## Considered Options

1. **Long-lived IAM user keys in GitHub Secrets.** (Rejected: rotation burden, durable blast radius on leak, contradicts the zero-secret philosophy.)
2. **GitHub OIDC federation.** The workflow declares `id-token: write`, and Terraform (`templates/terraform/oidc.tf`) registers GitHub as an OIDC identity provider with a per-project role. Each run mints a short-lived token; there is nothing to rotate.
3. **User-supplied role assumption.** (Rejected as default: pushes IAM setup onto the first-deploy path; kept possible via `create_oidc_provider = false` for accounts that already federate GitHub.)

## Decision Outcome

**Chosen Option:** GitHub OIDC federation by default. Generation creates the provider (unless one exists) and the deploy + preview roles (see Current State); each workflow assumes its role every run.

### Positive Consequences
* No AWS keys exist anywhere in CI: nothing to rotate, nothing durable to leak.
* The daily drift-detection workflow reuses the same mechanism with no extra setup.

### Negative Consequences
* First `apply` must create the OIDC provider, adding one IAM dependency to the happy path.
* Accounts with restrictive IAM policies may need an admin to approve provider creation.
