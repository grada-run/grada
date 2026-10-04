# Specification: Golden Signals, Static Target, and Docs Audit

## 1. Overview
This sprint bridges the gap between raw infrastructure and Day-2 operational excellence. It supercharges the `status` command with live CloudWatch Golden Signals, introduces a zero-cost `--target static` topology for SPA/SSG frontends, and synchronizes our Architecture Decision Records (ADRs) and Astro Starlight documentation to match the current `grada` platform capabilities.

## 2. Boundaries & Constraints
- **Zero-Cost Telemetry:** Golden Signals must use standard CloudWatch metrics (1-minute or 5-minute intervals) that do not incur AWS custom metric charges. 
- **Backwards Compatibility:** Enhancing `status` with telemetry must degrade gracefully (e.g., skip metrics if the AWS SDK fails or permissions are missing) without failing the core health check.
- **MCP Parity:** The programmatic `runStatus({ json: true })` function must include these new Golden Signals so the AI agent (`grada mcp`) automatically inherits the observability data.
- **ISOLATION:** The `static` target must not break existing `ecs` or `lambda` generation logic.

## 3. Implementation Targets

### A. Golden Signals & Alerting (`src/commands/status.js` & `alerts.js`)
- **Live Metrics:** Integrate `@aws-sdk/client-cloudwatch`. Update `status.js` to fetch the last 15 minutes of:
  - **ALB:** `RequestCount`, `HTTPCode_Target_5XX_Count`, `TargetResponseTime` (p95).
  - **ECS:** `CPUUtilization`, `MemoryUtilization`.
  - **DB (if present):** Aurora `ServerlessDatabaseCapacity` (ACU), `DatabaseConnections`.
- **Watch Mode:** Implement `grada status --watch` using a `setInterval` loop (e.g., 10s) that clears the terminal and repaints the Clack dashboard with live metric sparklines or raw values.
- **Alerts Command:** Implement `src/commands/alerts.js` (e.g., `grada alerts --webhook <url>`). This should generate a minimal Terraform snippet (`alerts.tf`) mapping existing CloudWatch Alarms (like the 5xx alarm) to an SNS topic that forwards to the provided Slack/Discord webhook URL.

### B. Zero-Compute Static Target (`--target static`)
- **Initialization:** Update `src/commands/init.js` and `tests/generator.test.js`. If a project is purely static (e.g., Vite SPA, Astro SSG, Next.js static export), `grada init --target static` should bypass Docker entirely.
- **Terraform Template:** Create `templates/terraform/static/`. The topology must be: S3 Bucket (private) + CloudFront Distribution + Origin Access Control (OAC). No ALB, no ECS, no NAT Gateways. Fixed cost = ~$0.00/mo.
- **Deployment Pipeline:** Update `templates/github/deploy.yml` for static targets. Instead of `docker build`, it should run `npm run build`, followed by `aws s3 sync` to the bucket and `aws cloudfront create-invalidation`.

### C. ADRs & Documentation Audit (`docs/` & `adr/`)
- **ADR Backfill:** Write or update Architecture Decision Records (Markdown files in `/docs/src/content/docs/adr/` or similar) for:
  1. `004-two-tier-e2e-testing.md` (Mock Tier 0 vs Live Tier 1).
  2. `005-multi-stage-docker-hardening.md` (Security rationale).
  3. `006-native-mcp-server.md` (STDIO architecture and IDE extensions).
- **Docs Scrub:** Search the Starlight documentation and root `README.md`. Ensure all references to `deploy-stack` are updated to `grada`. Ensure the AI agent integration (`grada mcp`) and `--target static` are fully documented.

## 4. Acceptance Criteria
1. `grada status` and `grada status --json` return populated Golden Signals without throwing AWS SDK errors.
2. `grada status --watch` repaints the console on a polling interval.
3. `grada init --target static` scaffolds a purely S3/CloudFront Terraform stack and a matching CI/CD YAML file.
4. E2E Tier 0 (Unit/Mock) tests pass for both the new metric functions and static generators.
5. All ADRs are present and `deploy-stack` legacy names are purged from the user-facing docs.