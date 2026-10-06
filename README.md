<p align="center">
  <img src="assets/logo.svg" width="128" alt="Grada logo">
</p>

# grada ☁️🚀

> The zero-lock-in cloud generator. Eject your containerized web app from expensive PaaS platforms to production-ready, highly available AWS infrastructure in 60 seconds.

[![NPM Version](https://img.shields.io/npm/v/grada-run.svg?color=blue&logo=npm)](https://www.npmjs.com/package/grada-run)
[![Node.js Support](https://img.shields.io/node/v/grada-run.svg?color=brightgreen)](https://www.npmjs.com/package/grada-run)
[![Security: Trivy](https://img.shields.io/badge/Security-Trivy_Scanned-blue.svg?logo=docker)](https://trivy.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

Managed platforms like Vercel, Heroku, or Render offer rapid initial deployments, but costs escalate quickly with seat pricing, compute caps, and bandwidth markups.

Migrating directly to AWS provides greater cost efficiency and infrastructure control. However, architecting raw Terraform for ECS clusters, Application Load Balancers, CloudFront distributions, and keyless CI/CD pipelines typically requires writing hundreds of lines of complex boilerplate infrastructure code.

## The Solution

**`grada`** is an interactive CLI that streamlines the process. It analyzes your project requirements and generates **clean, readable, and completely ejectable Terraform and GitHub Actions workflows** directly inside your repository.

You retain complete ownership of your infrastructure code without relying on black-box platforms.

---

## ✨ Features

**🚀 Zero-Config Deployments**
* **Framework Agnostic:** Tailored container presets for 10 supported frameworks — Node.js/Express, NestJS, Next.js, Nuxt 3, SvelteKit, Python/FastAPI, Django, Rails, Go, and Static Sites (React, Vue, Astro).
* **Smart Discovery:** Automatically detects build output directories and generates highly optimized, multi-stage Dockerfiles.
* **Migration Engines:** Natively parses Heroku `Procfile` configurations, `vercel.json` routing rules, and `docker-compose.yml` sidecar architectures to automatically translate them into AWS topologies across all three compute targets (Fargate + ALB, Lambda + API Gateway, or zero-compute S3 + CloudFront).
* **Database Scaffolding:** Automatically provisions fully isolated, zero-trust AWS databases for backend monoliths — RDS PostgreSQL 16, RDS MySQL 8.0, or Aurora PostgreSQL Serverless v2 with 0–2 ACU scale-to-zero (`--db-engine`, or pick interactively with per-engine cost hints).
* **Dependency-Aware Init:** Scans your manifests for database, worker, migration, and addon signals before prompting — pre-selecting the database question, pre-filling the worker command, pre-checking detected addons with evidence, and offering the migration gate — or compose the stack explicitly with `--with` in headless mode.

**🛡️ DevSecOps & Security**
* **Automated Trivy Scanning:** Integrated IaC and container vulnerability scanning on every GitHub Actions run.
* **Continuous IaC Validation:** Matrix pipeline scaffolds all 10 supported frameworks headlessly and gates every commit on `terraform validate`, `tflint`, and blocking Trivy config scans — HIGH/CRITICAL misconfigurations fail the build (container image scans stay advisory), reproducible locally with `npm run test:iac`.
* **Hardened Containers:** Multi-stage Alpine builds that drop root privileges (including `nginx-unprivileged` for static sites) and strip package managers from the final image. Distroless runners were evaluated and rejected to preserve shell access via ECS Exec (see ADR-0012).
* **Zero-Secret CI/CD:** Utilizes AWS IAM OpenID Connect (OIDC) for automated deployments—no long-lived AWS keys in GitHub.
* **Built-in Secrets Manager:** Push local `.env` variables into encrypted AWS Secrets Manager vaults, pull them back onto a new machine, and audit local-vs-remote drift — with one-prompt rolling ECS restarts for value-only rotations.

**☁️ AWS Native Architecture**
* **Production Defaults:** Provisions an Amazon ECS Fargate cluster fronted by an Application Load Balancer across multiple availability zones.
* **Serverless Target:** Prefer scale-to-zero? `--target lambda` (or the interactive prompt) generates a Lambda + API Gateway HTTP API v2 topology running the same container via the Lambda Web Adapter — $0/mo idle compute, with day-2 commands adapted and a Fargate-vs-Lambda tradeoff guide in the docs.
* **Zero-Compute Static Target:** `--target static` hosts static-site frameworks (Vite, Astro, SPA exports) and detected static exports (Next.js `output: 'export'`, SvelteKit `adapter-static`) on a private S3 bucket behind CloudFront with Origin Access Control — no VPC, no containers, no Dockerfile, $0.00/mo idle baseline. Anything else is rejected with a validation error, and the pipeline builds, syncs, and invalidates on every push.
* **Global Edge Acceleration:** Integrated AWS CloudFront CDN distribution with SSL termination and edge caching.
* **Modular Day-2 Addons:** Attach private S3 storage (`add storage:s3`), serverless DynamoDB (`add db:dynamodb`), Valkey caching (`add db:redis`), SQS queues (`add queue:sqs`), Bedrock AI access (`add ai:bedrock`), or SES transactional email (`add email:ses`) anytime after init — no Terraform hand-writing, with container env wiring included — plus scheduled cron jobs (`add cron`) that run one-off Fargate tasks on an EventBridge schedule.
* **Cost & Observability:** Keeps AWS spend visible with fixed-baseline cost previews before every provision, explicit 14-day CloudWatch log retention, and auto-generated 5XX error alerting. `status` renders live Golden Signals (`--watch` repaints), `alerts` scaffolds SNS email notifications, pause idle environments with one command (`sleep`/`wake`) and see the exact hourly savings, and catch out-of-band console changes with scheduled IaC drift detection (`drift`).

**🛠️ Developer Experience**
* **Zero Vendor Lock-In:** Generates standard, readable Terraform (`.tf`) files. You own the infrastructure.
* **Native S3 State Locking:** Automatically creates an encrypted S3 state bucket utilizing modern Terraform concurrency locking.
* **Safe Iteration:** Idempotent CLI safely backs up existing configurations to `.bak` files to guarantee zero data loss.
* **Ephemeral PR Previews (Opt-In):** Automatically spins up completely isolated AWS environments for every Pull Request and posts the live preview URL to GitHub, accelerating team code reviews.
* **🤖 IDE AI Integration:** Automatically generates contextual, target-aware rules for Cursor, Windsurf, Copilot, and Claude to prevent Terraform hallucinations — now with proactive guardrails (automatic `terraform validate`, secrets audit reminders, and apply nudges when build output changes).

**🔭 Day-2 Operations**
* **Observe & Troubleshoot:** Stream CloudWatch logs (`logs --tail --error -f`), check service health (`status`, with auto-`diagnose` on degradation), and open a shell in a running container (`exec`) — without leaving the terminal.
* **Database Lifecycle:** Tunnel into your private database (`db connect`, with `mysql://` URIs and Aurora cluster discovery), run migrations inside the VPC (`db migrate`, auto-detected, or wired into CI with `--setup-ci`), enable `pgvector` for AI embeddings (`db enable-vector`), stream in existing data (`db import --file/--from`, over a temporary SSM tunnel), and snapshot and restore it (`db backup`, `db restore`, cluster-aware for Aurora).
* **Cost Control & Safety:** Pause idle environments (`sleep [env]`/`wake [env]`, with exact savings and an RDS auto-restart guard), catch out-of-band console changes (`drift`, or daily in CI with `drift --setup`), clean up orphaned resources (`gc`, dry-run first with explicit confirmation), and roll back to a previous deployment (`rollback [revision]`, with live progress).

---

## 📚 Documentation & Guides
Transitioning from PaaS to AWS involves a few architectural shifts. Start with our **[live documentation site](https://grada-run.github.io/grada)** for full CLI references, guides, and migration walkthroughs. We've also written concise guides to help you understand how `grada` handles the heavy lifting:
* [Migration Overview (provider-to-target matrix)](./apps/docs/src/content/docs/migrations/index.md)
* [Migrating from Heroku to AWS (Procfile Support)](./apps/docs/src/content/docs/migrations/heroku-procfile-to-aws.md)
* [Managing Secrets & Environment Variables](./apps/docs/src/content/docs/guides/secrets-management.md)
* [Zero-Trust Database Connections](./apps/docs/src/content/docs/guides/database-connections.md)
* [Migrating Next.js from Vercel](./apps/docs/src/content/docs/migrations/nextjs-vercel-to-aws.md)
* [Ephemeral PR Previews & AWS Costs](./apps/docs/src/content/docs/guides/ephemeral-pr-previews.md)

---

## 🚀 Quick Start

Run the CLI directly in your project root:

```bash
npx grada-run
```

The interactive wizard will analyze your codebase, detect your framework, estimate your AWS costs, and generate your Terraform and GitHub Actions configurations.

---

## 🧰 CLI Command Reference

`grada` manages the entire lifecycle of your infrastructure. Each command links to its full reference — flags, examples, and environment overrides.

| Command | What it does |
| ------- | ------------ |
| [`apply`](./apps/docs/src/content/docs/cli/apply.md) | Provisions your AWS infrastructure and prints the live URLs (`--dry-run` previews topology and cost). |
| [`secrets push` / `pull` / `audit`](./apps/docs/src/content/docs/cli/secrets.md) | Encrypts `.env` files into Secrets Manager, syncs them back, and diffs drift. |
| [`doctor`](./apps/docs/src/content/docs/cli/doctor.md) | Verifies Docker, Terraform, the AWS CLI, and git are installed — and that AWS credentials are active. |
| [`diagnose`](./apps/docs/src/content/docs/cli/diagnose.md) (`wtf`) | Explains a failing ECS deployment from the stopped task and its logs. |
| [`logs`](./apps/docs/src/content/docs/cli/logs.md) | Streams CloudWatch logs (`--tail`, `-f`, `--error`, `--since`). |
| [`status`](./apps/docs/src/content/docs/cli/status.md) | Health dashboard with live Golden Signals, auto-`diagnose` on degradation, `--json` for scripts, and `--watch` for live repaint. |
| [`rollback`](./apps/docs/src/content/docs/cli/rollback.md) | Returns the live service to a previous task revision, with live progress (ECS only). |
| [`exec`](./apps/docs/src/content/docs/cli/exec.md) | Opens a shell in a running container via Session Manager (ECS only). |
| [`db connect`](./apps/docs/src/content/docs/cli/db.md) | Opens a `localhost` tunnel to your private database (PostgreSQL, MySQL, or Aurora). |
| [`db migrate`](./apps/docs/src/content/docs/cli/db.md) | Runs migrations inside the VPC (auto-detected) or installs the CI pre-deploy gate. |
| [`db enable-vector`](./apps/docs/src/content/docs/cli/db.md) | Enables `pgvector` for AI embeddings with a one-off VPC task. |
| [`db import`](./apps/docs/src/content/docs/cli/db.md) | Streams a local dump or remote database into your private instance over an SSM tunnel. |
| [`db backup` / `db restore`](./apps/docs/src/content/docs/cli/db.md) | Snapshot checkpoints and Terraform-pinned restores (cluster-aware for Aurora). |
| [`gc`](./apps/docs/src/content/docs/cli/gc.md) | Deletes orphaned ECR images, log groups, and EIPs — dry-run first, explicit confirmation only. |
| [`sleep` / `wake`](./apps/docs/src/content/docs/cli/sleep.md) | Pauses an environment to $0 compute and restores exact replica counts (`--skip-db`, `--no-wait`). |
| [`drift`](./apps/docs/src/content/docs/cli/drift.md) | Flags out-of-band AWS changes locally or daily in CI (`--setup`). |
| [`alerts`](./apps/docs/src/content/docs/cli/alerts.md) | Scaffolds an SNS topic + 5xx alarm for email notifications (ECS only). |
| [`add`](./apps/docs/src/content/docs/cli/add.md) | Attaches S3, DynamoDB, Redis, SQS, Bedrock, SES, or scheduled cron jobs without writing Terraform. |
| [`domain`](./apps/docs/src/content/docs/cli/domain.md) | Attaches a custom domain with automated ACM TLS (Route 53 or external DNS). |
| [`destroy`](./apps/docs/src/content/docs/cli/destroy.md) | Tears down AWS resources to stop billing (state bucket optionally retained). |
| [`eject`](./apps/docs/src/content/docs/cli/eject.md) | Strips `grada` metadata, leaving pure Terraform and Actions files. |
| [`--headless`](./apps/docs/src/content/docs/guides/headless.md) | Fully programmatic runs for CI/CD (`--target`, `--with`, `--db-engine`, `--setup-ci-migrate`, `--setup-ci-drift`). |
| [`sync-ai`](./apps/docs/src/content/docs/cli/sync-ai.md) | Generates IDE assistant rules for your stack (Cursor, Copilot, Windsurf, Claude). |
| [`mcp`](./apps/docs/src/content/docs/cli/mcp.md) | Serves the MCP server for AI agents (STDIO/HTTP) or installs editor config (`--install`). |

---

## 📁 Generated File Structure

Running the CLI seamlessly integrates a modular, DevSecOps-hardened architecture into your repository:

```text
your-project/
├── Dockerfile                  # Multi-stage container preset
├── .dockerignore               # Prevents secret leaks into container builds
├── .gitignore                  # Automatically updated to ignore tfstate and .bak files
├── .github/
│   └── workflows/
│       ├── deploy.yml          # Keyless OIDC CI/CD deployment pipeline
│       └── drift.yml           # Scheduled IaC drift detection (opt-in via `--setup-ci-drift` or `drift --setup`)
└── terraform/
    ├── main.tf                 # ECR repository + compute (ECS Cluster/Fargate Task, Lambda + API Gateway with `--target lambda`, or S3 + CloudFront with `--target static`)
    ├── network.tf              # VPC, Public Subnets, ALB, and Security Groups
    ├── cloudfront.tf           # CloudFront CDN edge distribution
    ├── domain.tf               # Custom domain + ACM certificate (via `domain add`, when configured)
    ├── oidc.tf                 # GitHub Actions keyless IAM OIDC Provider & Roles
    ├── secrets.tf              # AWS Secrets Manager integration
    ├── backend.tf              # S3 Remote State backend with native locking
    ├── database.tf             # Managed database — RDS PostgreSQL/MySQL or Aurora Serverless v2 (backend frameworks only)
    ├── worker.tf               # Background worker service (ECS Procfile projects only)
    ├── s3.tf / dynamodb.tf / redis.tf / sqs.tf / bedrock.tf / ses.tf / cron.tf   # Modular addons via `grada add` (when added)
    └── secret_keys.json        # Dynamic key map for injected environment variables
```

---

## 📦 Reference Implementations

* **[Next.js Fullstack App](https://github.com/anton-codes-iac/deploy-stack-nextjs-example):** A complete Next.js deployment showcasing the generated Terraform, CloudFront setup, and automated OIDC workflow.
* **[Docker Compose to AWS Migration](https://github.com/anton-codes-iac/deploy-stack-docker-compose-example):** Demonstrates automatic translation of local `docker-compose.yml` sidecars (like Redis) into a multi-container AWS ECS Task Definition communicating over `localhost`.
* **[Heroku to AWS Migration (Django)](https://github.com/anton-codes-iac/deploy-stack-heroku-django-example):** A classic Heroku-style monolith migrated via the Procfile Importer.
* **[Zero-Secret AWS Secrets Manager Injection](https://github.com/anton-codes-iac/deploy-stack-secrets-example):** A production-grade Node.js architecture demonstrating zero-plaintext secret injection. Encrypts local `.env` variables directly into AWS and maps them into ECS memory at container boot, verified against GitHub's API.

👉 **[View all 14+ reference implementations in our Examples Gallery](./apps/docs/src/content/docs/guides/examples.md)**

---

## 🤖 AI Context Management (Cursor, Roo Code, Trae, Copilot, Windsurf, Claude, Goose, Aider, Continue)

AI coding assistants are incredible, but they often hallucinate custom Terraform or raw AWS CLI commands that can break your infrastructure state. `grada` natively intercepts and guides AI agents directly in your IDE by providing strict deployment rules and project-specific context (like your exact AWS Region and Container Port).

**How it works:**
* **Quickstart Flow:** The CLI silently auto-detects if you are using AI tools in your repository and safely injects context.
* **Advanced Flow:** You are explicitly prompted to choose which AI assistants your team uses.
* **Standalone Command:** You can run `npx grada-run sync-ai` at any time to selectively generate these rules later.

**Safe & Non-Destructive:** We use isolated rule files (like `.cursor/rules/grada.mdc`) or strictly delimited blocks (`<!-- BEGIN GRADA CONTEXT -->` … `<!-- END GRADA CONTEXT -->`) to ensure your team's existing agent instructions, coding standards, and project prompts are **never overwritten**.

## 🔌 AI Agent MCP Server

`grada` ships a native [Model Context Protocol](https://modelcontextprotocol.io) server so AI assistants can inspect and operate your infrastructure directly — stack analysis, add-on provisioning, live status, logs, and secrets drift. No hosting needed: your agent spawns it locally on demand.

**One-command install** (writes the server entry to your editor's MCP config):

```bash
npx grada-run mcp --install cursor        # → ~/.cursor/mcp.json
npx grada-run mcp --install vscode        # → user mcp.json (default profile)
npx grada-run mcp --install claude-desktop # → Claude Desktop config
npx grada-run mcp --install windsurf      # → ~/.codeium/windsurf/mcp_config.json
npx grada-run mcp --install zed           # → ~/.config/zed/settings.json
npx grada-run mcp --install gemini-cli    # → ~/.muse/settings.json
```

**Manual config** (any other MCP client — Claude Code plugins, Cline, Continue):

```json
{
    "mcpServers": {
        "grada": { "command": "npx", "args": ["grada-run", "mcp"] }
    }
}
```

MCP registry listings (Smithery, mcp.so, Glama, Anthropic directory) are in progress; the Custom GPT path works through the self-hosted HTTP transport (`--transport http`) behind your own tunnel.

---

## 🛡️ Telemetry & Privacy
By default, `grada` collects anonymous, hashed usage data to help improve the CLI (e.g., framework presets used, deployment success rates). **No codebase files, AWS credentials, or personal data are ever collected.**

To opt out, simply append the flag:
```bash
npx grada-run --no-telemetry
```
To opt out of every run at once, set `DO_NOT_TRACK=1` (or `DO_NOT_TRACK=true`) in your environment instead.

---

## 🗺️ Roadmap

### Phase 10: Complete Day-0 to Day-N Lifecycle Mastery (Completed — 19/19)
**Goal:** Zero-Console Production Independence. Eliminate the final architectural, data, and operational triggers that force developers to open the AWS Management Console across the entire application lifecycle.

### Phase 11: The `grada.run` Rebrand, Daily Observability & Agentic Ecosystem (Current)
**Goal:** Transition the platform identity to **Grada (`grada.run`)**, close the daily observability gap with zero-cost CloudWatch Golden Signals, eliminate cross-command state-transition bugs, and launch the native MCP and AI Agent Plugin ecosystem.

👉 **[See what's shipped and what's next in the full roadmap](./apps/docs/src/content/docs/roadmap.md)**

---

## 📜 License

Distributed under the **MIT License**. See [LICENSE](LICENSE) for more information.