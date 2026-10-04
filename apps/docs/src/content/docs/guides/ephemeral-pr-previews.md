---
title: "Ephemeral PR Previews"
description: "Spin up isolated temporary AWS environments for every pull request."
sidebar:
  order: 8
---

When enabled, `grada` automatically configures your GitHub Actions pipeline to spin up isolated, temporary AWS environments every time a developer opens a Pull Request.

A bot will comment on the PR with a live URL (e.g., `http://pr-123-your-app...`), allowing your team to test features, UI changes, and API updates before merging to `main`. When the PR is closed or merged, the environment is automatically destroyed.

### 🏗️ How it Works

Under the hood, `grada` utilizes **Terraform Workspaces**. 

When a PR is opened, Terraform creates a new workspace (e.g., `pr-12`). It provisions a completely isolated Application Load Balancer and ECS Fargate Task using the exact same infrastructure definitions as your production environment, ensuring 100% parity. On `--target lambda` projects the same workspace model provisions an isolated function and API Gateway per PR instead, deploys the PR-tagged image to it, and comments the preview API Gateway URL — same open-and-teardown lifecycle, no ALB per PR. Static targets (`--target static`) skip preview workflows entirely — there is no compute to preview against.

To save time and simplify architecture, PR environments **share** your production AWS Secrets Manager vault and ECR Image Repository.

### ⚖️ The Rule of Thumb: Should I enable this?

**✅ Enable PR Previews if:**
* You are working on a team of 2+ developers and require visual QA or UX sign-off before merging code.
* You are building a frontend application or full-stack monolith where seeing the live UI is critical.

**❌ Do NOT enable PR Previews if:**
* You are a solo developer (you can just test locally).
* You have a massive volume of PRs (e.g., automated Dependabot updates). Spinning up an AWS Load Balancer takes ~3 minutes, which will slow down rapid automated merges.

### 💰 AWS Cost Implications

Because PR previews provision a real Application Load Balancer (ALB) and ECS Fargate compute tasks, **they are not free.**

* **Compute:** You are charged standard AWS Fargate rates per minute while the PR environment is running.
* **Load Balancing:** AWS charges ~$16/month per active Load Balancer. If a PR is open for 2 days, you pay the prorated ALB cost for those 48 hours (~$1.00).
* **Addons:** Because [`grada add`](/grada/cli/add/) resources use `${local.app_name}`, each open PR preview workspace provisions its own isolated S3 bucket and/or DynamoDB table — accruing usage-based storage, request, and PITR charges until the PR closes and the workspace is destroyed. If you use `db:redis`, each open PR also runs its own isolated Valkey node at ~$9.49/mo (~$0.013/hr) until the PR closes, while `queue:sqs`, `ai:bedrock`, and `cron` add no fixed per-PR cost (each open PR runs its own copy of the schedule, billed only for Fargate seconds per invocation). Secrets Manager secrets are shared via `data` source at no extra per-PR secret cost. SES (`email:ses`) is the exception: the domain identity, DKIM, MAIL FROM, and DNS records are account-wide singletons scoped to the production workspace, so previews neither duplicate them nor delete them on teardown — preview containers simply inherit sending permission through their own task role.
* **Custom domains:** [`domain add`](/grada/cli/domain/) resources (ACM certificate, validation, and alias records) are likewise scoped to the production workspace. PR previews serve over their own isolated `*.cloudfront.net` URL and never claim your production alias, so closing a PR cannot disturb production DNS or TLS.

To keep costs low, ensure your team closes or merges Pull Requests promptly so the `teardown.yml` workflow can destroy the resources and stop the billing clock!