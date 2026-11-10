---
title: "GitHub OIDC Authentication, No Stored AWS Keys"
description: "Authenticate CI/CD with short-lived OIDC tokens instead of long-lived AWS keys."
---

* **Status:** Accepted (amended v0.48.0: single admin role split into deploy + preview least-privilege roles; amended v0.49.1: self-protecting guardrails + dual-branch deploy trust; amended v0.49.2: permissions boundary on created roles — see below)
* **Date:** 2026-09-24 (Retroactive)

## Amendment (v0.49.2): Permissions Boundary on Created Roles

The ARN-scoped role-mutation deny stopped the preview role from touching the CI roles — but it could still mint a *new* admin role (attacker trust, admin policy) that the deny-list never names. The fix is a permissions boundary: `CreateRole` without it is denied, the boundary cannot be swapped, removed, or neutered, and every template-managed role carries it (preview workspaces read the default workspace's copy). The boundary is a deny-list mirror of the guardrails (default-allow) so a missing entry weakens security instead of breaking prod tasks; name-scoping was rejected because attackers mint matching names and `CreateRole` takes no resource constraint. Existing trees pick it up by re-running setup.

## Amendment (v0.49.1): Self-Protecting Guardrails + Dual-Branch Trust

Two hardening fixes. First, the preview role's `IAMFullAccess` let PR-run Terraform delete its own guardrails (or the deploy role, or widen trust) in one call — the preview guardrails now deny role/policy/trust mutation on both CI role ARNs, and the coverage gaps are closed (worker service, RDS snapshot deletion, prod secrets and log groups). The deploy role keeps full IAM power: it runs on the trusted branch and needs it for the re-init trust migration. Second, deploy trust now binds the deploy branch *and* the repo default branch (auto-detected from `origin/HEAD` at scaffold), because scheduled drift runs on the default branch and was denied whenever the two differed. Existing trees pick both up by re-running setup.

## Amendment (v0.48.0): Least-Privilege Role Split

The original decision created one `<project>-github-actions-role` with `AdministratorAccess`. That role is now split: a deploy role (mainline deploys + drift checks, branch-bound trust) and a preview role (PR-triggered preview/teardown/plan workflows, pull-request-bound trust), both on `PowerUserAccess` + `IAMFullAccess` with explicit deny guardrails (audit/billing planes and state-bucket deletion for deploy; production data destruction, EC2 compute, and IAM backdoors for preview). Existing trees migrate by re-running setup, which regenerates `terraform/oidc.tf` and the workflow role ARNs; the old admin role is destroyed on the next apply. The zero-secret federation mechanism itself is unchanged.

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

**Chosen Option:** GitHub OIDC federation by default. Generation creates the provider (unless one exists) and a `<project>-github-actions-role`; the workflow assumes it every run.

### Positive Consequences
* No AWS keys exist anywhere in CI: nothing to rotate, nothing durable to leak.
* The daily drift-detection workflow reuses the same mechanism with no extra setup.

### Negative Consequences
* First `apply` must create the OIDC provider, adding one IAM dependency to the happy path.
* Accounts with restrictive IAM policies may need an admin to approve provider creation.
