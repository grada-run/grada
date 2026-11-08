---
title: Roadmap
description: Where grada has been and what comes next — completed phases and the current milestone.
---

### Phase 1–3: The Core Engine (Completed)
- [x] **Core MVP:** Interactive CLI, ECS Fargate + ALB generation, CI/CD, and Secrets sync.
- [x] **Production Readiness:** CloudFront CDN edge distribution, native S3 state locking, and secure OIDC integration.
- [x] **Smart Experience:** Zero-config framework auto-discovery for static output directories.
- [x] **Trust & Observability:** DevSecOps Trivy scanning, automated 5XX alarms, 14-day log retention, and safe local overwrite protections.

### Phase 4: Trust Anchors & TAM Expansion (Completed)
- [x] **Ecosystem Distribution:** Native GitHub Marketplace Action for rapid discovery.
- [x] **Cost Transparency:** Pre-flight AWS cost estimator injected directly into the CLI wizard.
- [x] **Zero Vendor Lock-In:** Explicit `npx grada-run eject` command to safely strip `ManagedBy` tags and CLI metadata, leaving behind pure IaC.
- [x] **Heavy Backend Monoliths:** Hardened, unprivileged container adapters for Go, Nuxt.js, Django, and Rails, complete with automated zero-trust RDS PostgreSQL provisioning.

### Phase 5: The Activation Engine (Completed)
- [x] **Local Execution Wrapper:** Native `grada apply` command with terminal-optimized streaming to eliminate Terraform context switching.
- [x] **Ecosystem Integrations:** Official plugins published to the Astro Integrations directory (`astro-grada`) and Nuxt module registry (`nuxt-grada`).

### Phase 6: Migration & Trust Engine (Completed)
- [x] **Dry-Run Visualization:** Interactive pre-flight terminal UI with ASCII topology maps and precise, dynamic AWS cost estimation.
- [x] **PaaS Importers:** Auto-parse `vercel.json` and Heroku `Procfile` configurations to map routing rules, web commands, and background workers automatically.
- [x] **Docker Compose to ECS Translator:** Automatically converting a familiar local `docker-compose.yml` into production ECS task definitions.
- [x] **AI Agent Rulesets:** Publishing `.cursorrules` and Copilot instructions that teach AI assistants exactly how to utilize the CLI on the user's behalf.

### Phase 7: Team Workflows & Ecosystem Integrations (Completed)
*Focus: Enhance collaborative development and expand native support across major framework ecosystems.*
- [x] **Ephemeral PR Previews:** Generate GitHub Actions workflows that spin up temporary ECS Fargate tasks and post live preview URLs directly in pull request comments to streamline team code reviews.
- [x] **AI Context Synchronization:** Implement `grada sync-ai` to automatically generate `.cursorrules` and AI context files, ensuring coding assistants generate accurate deployment commands tailored to the project.
- [x] **Native Ecosystem Integrations:** Publish seamless, push-button plugins across major frameworks.
  - [x] `vite-plugin-grada` (Live on NPM)
  - [x] `svelte-adapter-grada` (SvelteKit adapter integration)
  - [x] `cookiecutter-django-grada` (Listed on Django Packages)
  - [x] `cookiecutter-fastapi-grada` (Cookiecutter for modern async Python)
  - [x] `nest-grada` (Native `nest add` schematic for NestJS)
  - [x] `rails-template-grada` (Zero-click Ruby on Rails application template)
- [x] **Automated Troubleshooting:** `grada diagnose` (alias: `wtf`) automatically analyzes common day-2 AWS operational issues (e.g., Fargate OOM kills, ALB 502s) directly from the terminal.

### Phase 8: Platform Hardening & Developer Experience (Completed)
*Focus: Solidify the core engine's reliability, prove security compliance, and establish documentation hub before introducing Day-2 operational commands.*
- [x] **Documentation Hub:** Launch a dedicated Astro Starlight documentation site featuring interactive architecture diagrams, core concept deep-dives, and detailed CLI references.
- [x] **Continuous Infrastructure Validation:** Implement a GitHub Actions matrix pipeline that automatically generates, compiles, and validates Terraform syntax (`terraform validate`, `tflint`) against all supported frameworks on every commit.
- [x] **Automated Security & Compliance Proving:** Integrate DevSecOps infrastructure scanning (`trivy` or `tfsec`) directly into the CI pipeline to mathematically guarantee zero-CVE, secure-by-default AWS provisioning.
- [x] **Integration Stability Suite:** Expand Vitest coverage to enforce strict contracts for headless execution flags (`--preconfigured`, `--headless`), ensuring seamless interoperability with third-party scaffolding tools.

### Phase 9: Day-2 Operations & Developer Retention (Completed)
*Focus: Uninterrupted Developer Flow. Deliver a seamless Day-2 environment where users maintain full infrastructure control without leaving the command line to troubleshoot.*
- [x] **Context-Aware Log Streaming:** `grada logs <service> --tail --error`. Implement a live stream using the CloudWatch Logs API to merge API/frontend logs in a color-coded terminal view, eliminating the need to navigate the AWS web console.
- [x] **1-Click Container Access:** `grada exec <service>`. Automatically drop the user into a secure bash shell inside a running Fargate container using AWS Systems Manager (SSM) Session Manager, abstracting away complex IAM trust policies and local agent requirements.
- [x] **Secure Secrets Sync & Rolling Restarts:** `grada secrets pull/audit`. Fetch vault payloads to a local `.env`, compare local vs. remote keys, and trigger rolling ECS restarts for value-only rotations.
- [x] **Secure Database Tunneling:** `grada db connect`. Utilize SSM Port Forwarding to open a secure `localhost` tunnel directly to your private RDS PostgreSQL instance, allowing tools like DBeaver or Prisma Studio to query production data without public internet exposure.
- [x] **Health & Alarm Dashboard:** `grada status`. Query the ECS Service status (Desired vs. Running tasks) and CloudWatch Alarms (e.g., ALB 5XX errors), printing a clear green/red operational status matrix directly in the terminal.
- [x] **Orphaned Resource Garbage Collection:** `grada gc`. Scan the AWS account for unattached Elastic IPs, abandoned ECR image layers, and lingering CloudWatch log groups left behind by PR previews or manual deletions, safely removing them to protect the user's AWS bill.

### Phase 10: Complete Day-0 to Day-N Lifecycle Mastery (Completed — 19/19)
**Goal:** Zero-Console Production Independence. Eliminate the final architectural, data, and operational triggers that force developers to open the AWS Management Console across the entire application lifecycle.

- [x] **Custom Domains & Automated SSL:** `grada domain add <domain>`. Automate Route 53 Hosted Zone bindings or provide an interactive External DNS verification flow (Cloudflare, Namecheap) with automated ACM TLS certificate issuance (including `us-east-1` validation for edge/CloudFront) and ALB listener routing.
- [x] **Instant One-Command Rollback:** `grada rollback [revision]`. List the last 5 deployed task revisions and instantly revert the live ECS service to a prior healthy revision in under 15 seconds, bypassing lengthy rebuild cycles during production regressions.
- [x] **Self-Healing Deployment Circuit Breakers:** Enable native ECS deployment circuit breakers (`deployment_circuit_breaker { enable = true, rollback = true }`) in Terraform, automatically rolling back failed container rollouts and broken health checks without operator intervention.
- [x] **Pre-Deploy Database Migration Gate:** Inject an isolated `aws ecs run-task` step into `.github/workflows/deploy.yml` to execute schema migrations (`prisma migrate deploy`, `alembic upgrade head`, `rails db:migrate`) against RDS inside the VPC before rolling out the new service revision, automatically halting the release if migrations fail.
- [x] **On-Demand Database Snapshots & Restore:** `grada db backup` and `grada db restore`. Provide instantaneous CLI wrappers around RDS manual snapshots and point-in-time recovery so developers can create pre-migration safety checkpoints or restore instances directly from the terminal.
- [x] **Transactional Email & DKIM Automation:** `grada add email:ses`. Provision Amazon SES Domain Identities, auto-inject the 3 required DKIM CNAME records into Route 53 (or output external DNS records), configure SPF/DMARC baselines, and attach least-privilege `ses:SendEmail` permissions to the ECS Task Role.
- [x] **Application Object Storage:** `grada add storage:s3`. Provision secure, private S3 buckets for asset uploads configured with CloudFront Origin Access Control (OAC), CORS rules, and presigned URL IAM policies injected directly into the container runtime.
- [x] **In-Memory Caching & Async Queues:** `grada add db:redis` (powered by cost-optimized AWS ElastiCache for Valkey/Redis) and `grada add queue:sqs`. Scaffold private in-memory cache clusters, SQS queues with dead-letter queues, and scale-to-zero background worker Fargate services driven by queue depth auto-scaling (`ApproximateNumberOfMessagesVisible`).
- [x] **Scheduled Cron Jobs:** `grada add cron`. EventBridge Scheduler rules that trigger one-off Fargate tasks on a cron schedule.
- [x] **Serverless NoSQL:** `grada add db:dynamodb`. Provision scale-to-zero DynamoDB (`PAY_PER_REQUEST`) tables with free VPC Gateway Endpoints and auto-wired IAM policies.
- [x] **Vector Databases:** `grada db enable-vector`. One-command `pgvector` provisioning on RDS PostgreSQL for AI/RAG embeddings without expensive OpenSearch clusters.
- [x] **Multi-Engine RDS & Aurora Scale-to-Zero:** Support PostgreSQL, MySQL, and Aurora Serverless v2 (`0 ACU` auto-pause) across `init`, `db connect`, `db backup`, and `db restore` with automatic URI formatting (`postgresql://` and `mysql://`).
- [x] **On-Demand Remote Migration Runner:** `grada db migrate [--cmd <command>]`. Launch an ephemeral, one-off ECS Fargate task inside the private VPC to execute ad-hoc schema migrations or seed scripts (`prisma`, `alembic`, `rails db:seed`), streaming stdout/stderr live to the terminal.
- [x] **Zero-Trust Database Ingestion:** `grada db import [--file <dump.sql> | --from <url>]`. Stream local SQL dumps or remote databases (Heroku, Supabase, Render, Railway) directly into the isolated private RDS instance via an automated background SSM tunnel.
- [x] **GenAI Primitives:** `grada add ai:bedrock`. Configure least-privilege IAM policies for invoking AWS Bedrock foundation models.
- [x] **Serverless Compute Primitives:** `grada --target lambda`. Provide an alternate AWS Lambda + API Gateway deployment target for scale-to-zero web workloads.
- [x] **Environment Hibernation & FinOps:** `grada sleep <env>` and `grada wake <env>`. Scale ECS task counts to zero, stop non-production RDS instances, guard against the AWS 7-day RDS auto-restart behavior, and display estimated hourly savings to eliminate idle staging costs.
- [x] **Scheduled IaC Drift Detection:** `grada drift` and `--setup-ci-drift`. Generate an automated GitHub Action that periodically executes `terraform plan -detailed-exitcode` against live AWS infrastructure, opening GitHub Issues or dispatching Slack notifications when out-of-band console changes occur.
- [x] **Dependency-Aware Init:** Scan manifests for database, worker, migration, and addon signals before prompting — pre-selecting the database question, pre-filling the worker command, pre-checking detected addons with evidence, and offering the pre-deploy migration gate — with `--with` for one-pass headless composition.

### Phase 11: The `grada.run` Rebrand, Daily Observability & Agentic Ecosystem (Current)
**Goal:** Transition the platform identity to **Grada (`grada.run`)**, close the daily observability gap with zero-cost CloudWatch Golden Signals, eliminate cross-command state-transition bugs, and launch the native MCP and AI Agent Plugin ecosystem.

- [x] **Unified Brand & Binary Transition (`grada`):** Ship the `grada` binary and `@grada-run/grada` alias with transparent fallbacks keeping existing deployments working.
- [x] **AI-Driven Edge-Case & State Transition Audit:** Systematic audits tracing multi-step lifecycle mutations across `ecs`/`lambda` targets, patching race conditions, state locks, and UX dead ends.
  - [x] Target guards: static/lambda refusals across Day-2 commands.
  - [x] Lifecycle fixes: asleep-`apply` gate, idempotent `wake`, eject markers, `rollback` diagnostics, `add` upserts, `--strict` sleep/wake (see `specs/state-transition-audit-fixes.md`).
  - [x] Cross-command seams: `destroy` data-loss gate, `apply` target-switch gates, wake-first eject, atomic writes (see `specs/state-transition-audit-fixes-2.md`).
  - [x] Collision-resistant naming: entropy suffix, state adoption gate, backend recovery (see `specs/resource-naming-entropy.md`).
- [x] **Three-Tier E2E Harness & Automation Bypasses:** Black-box Tier 0 (every PR), Tier 1 (nightly live lifecycle), and Tier 2 (nightly live-service acceptance) suites, plus `--auto-approve`/`--yes`/`--headless` bypasses for `apply`, `destroy`, and `eject`.
- [x] **Deterministic Suite & Flaky Test Elimination:** Isolate network/loopback and SDK mocks in the Vitest suite and eliminate timing-dependent failures.
- [x] **Live Service Acceptance (Tier 2 E2E):** Nightly run proving addon wiring and task IAM/VPC access on real AWS (see testing-strategy).
- [x] **Multi-Stage Dockerfile Hardening:** Multi-stage Alpine builds stripping package managers from the final runtime image. Distroless runners were evaluated and rejected (no shell breaks ECS Exec debugging) — see ADR-0012.
- [x] **Test Suite Deduplication & Hygiene:** Centralize the `@clack/prompts` and `telemetry` mocks in `tests/helpers/`, registered suite-wide via `tests/setup.js`.
- [x] **Golden Signals Live Telemetry:** `grada status` (and `--watch`) surfaces real-time CloudWatch Golden Signals at $0 extra AWS cost. Lambda signals deferred.
- [x] **Email Alert Scaffolding:** `grada alerts` scaffolds an SNS topic plus a 5xx alarm with a manual email-subscription step.
- [x] **Chat Alert Webhooks:** Forwarding Lambda so CloudWatch alarms reach Slack or Discord webhooks. Container-crash EventBridge routing deferred.
- [x] **Architecture Decision Records (ADRs) & Docs Audit:** Review and standardize all ADRs and Starlight docs under the `grada` brand with zero stale references.
- [x] **Zero-Compute Static Target (`--target static`):** Deploy pre-built static assets directly to S3 fronted by CloudFront, bypassing compute entirely.
- [x] **Native MCP Server Mode (`grada mcp`):** Embed an MCP server in the CLI exposing `analyze_stack`, `add_primitive`, `stack_status`, `fetch_logs`, and `audit_secrets` over STDIO, plus Streamable HTTP and a 6-editor `--install` flag. (`estimate_cost`, `diagnose_stack`, `check_drift` deferred.) See [mcp](/grada/cli/mcp/).
- [x] **Claude Code, Cursor & Codex Plugin Manifests:** Package plugin manifests, `SKILL.md` playbooks, and editor rules so Grada installs natively in Claude Code, Cursor, Copilot, Windsurf, Zed, and VS Code.
- [x] **Automated IDE Guardrail Hooks:** Agent plugin hooks that run `terraform validate` after `.tf` edits and prompt `grada secrets audit` on new `.env` keys.
- [ ] **Production Flagship Blueprint (`saas-starter`):** Publish a full-stack, production-ready SaaS reference repository deployable in one command with `grada`.
- [ ] **Production AI Blueprint (`ai-worker`):** Publish an async AI reference repository (FastAPI + Bedrock + Aurora `pgvector` + SQS worker + S3 ingestion) demonstrating enterprise RAG without OpenSearch costs.
- [ ] **Serverless Scale-to-Zero Blueprint (`grada-lambda-fastapi`):** Publish a reference repository demonstrating the `--target lambda` container image workflow with Lambda Web Adapter, API Gateway HTTP API v2, and CloudFront.
- [x] **Plan-on-PR CI/CD Workflows:** Generate `.github/workflows/plan.yml` posting a sticky, diff-highlighted `terraform plan` comment on every PR. See [CI/CD Pipeline](/grada/guides/cicd-pipeline/).
- [x] **The npx Trap Fix:** Generate framework-compiled runners instead of guaranteed-to-fail `npx` commands, with a headless refusal and interactive warning guardrail.
- [x] **Automated Pre-Migration Snapshots:** Take an RDS snapshot automatically before the CI migration gate runs.
- [x] **Generic One-Off Task Runner:** `grada run --cmd "..."` executes backfills, admin scripts, and repairs in an ephemeral VPC task with live log streaming. See [run](/grada/cli/run/).
- [x] **Least-Privilege CI Roles:** Two roles — deploy (branch-bound trust) and preview (pull-request-bound trust) — on managed baselines with explicit deny guardrails.
- [ ] **High-Conversion `grada.run` Launch Site:** Ship the flagship marketing front-end above the Starlight docs with interactive terminal demos, a cost savings calculator, and a capability matrix.
- [x] **Migration Guide Deep Review:** Re-verify every migration flow end to end and rewrite the guides to be accurate click-by-click.
- [ ] **Ecosystem Rebrand to Grada:** Rename the `deploy-stack-*` repositories, framework integrations, and starters to the Grada brand with updated READMEs and listings.
