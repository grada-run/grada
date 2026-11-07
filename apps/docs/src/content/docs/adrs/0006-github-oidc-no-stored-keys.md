---
title: "GitHub OIDC Authentication, No Stored AWS Keys"
description: "Authenticate CI/CD with short-lived OIDC tokens instead of long-lived AWS keys."
---

* **Status:** Accepted (amended v0.48.0: single admin role split into deploy + preview least-privilege roles — see below)
* **Date:** 2026-09-24 (Retroactive)

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
