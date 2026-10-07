---
title: Static-Site Hosting
description: Run a zero-compute static site on S3 + CloudFront — what gets generated, how deploys work, and how Day-2 commands behave.
---

`--target static` is zero-compute hosting for static-site frameworks (Vite, Astro, Create React App — anything the `static` framework preset detects) plus detected static exports (Next.js `output: 'export'`, SvelteKit `adapter-static`). There are no containers, no VPC, and no Dockerfile: pre-built files sync to a private S3 bucket served through CloudFront.

## What gets generated

A static scaffold is deliberately small:

- `terraform/main.tf` — private S3 bucket, CloudFront distribution with Origin Access Control (OAC), and the bucket policy that lets CloudFront read while blocking all public access.
- `terraform/oidc.tf`, `terraform/backend.tf` — the same keyless CI role and remote state as other targets.
- `.github/workflows/deploy.yml` — build, sync, and invalidate (see below).
- A deployment doc rendered from the static template (`README.md`, `DEPLOYMENT.md`, or `GRADA.md` — never overwriting your own files).

There is intentionally no `network.tf`, `secrets.tf`, `cloudfront.tf`, `Dockerfile`, `worker.tf`, `database.tf`, or preview workflow. Anything that is neither a static-site framework nor a detected static export is rejected with a hard validation error (`STATIC_TARGET_FRAMEWORK_MISMATCH`) — containers belong on `ecs` or `lambda`. A detected `Procfile` worker or database request is skipped with a warning: there is no compute to run or connect from.

Unknown paths fall back to `/index.html` (custom error responses), so client-side routers work without extra configuration.

## The deploy pipeline

Every push to your deploy branch (plus a weekly Sunday re-apply) runs the same shape as other targets, minus anything container-shaped:

1. **IaC scan.** Trivy scans `terraform/` (advisory only, results in the step summary).
2. **Infrastructure sync.** The `grada-run/grada-action@v1` step applies Terraform.
3. **Build.** Node.js 22 runs `npm ci` and `npm run build`.
4. **Sync.** `aws s3 sync` uploads the build folder (`BUILD_DIR`, auto-detected as `dist/`, `build/`, or `out/`) with `--delete`, so removed files disappear from the site.
5. **Invalidate.** A `/*` CloudFront invalidation clears the edge cache (looked up by distribution comment, so renames never break it).

There is no `503` window like container targets: `apply` provisions an empty bucket behind CloudFront, and the first push publishes the site.

## Cost and outputs

The fixed baseline is **$0.00/mo** — the pre-flight preview shows `Fixed Baseline: $0.00/mo (Usage-based only via S3/CloudFront)`. You pay only for S3 storage and requests plus CloudFront requests and egress, all usage-metered.

The stack outputs `site_url` (plus `site_bucket`, `cloudfront_distribution_id`, and `cloudfront_domain_name`), and `apply` prints the Site URL when provisioning succeeds.

## Day-2 commands on static

| Command | Static behavior |
| ------- | --------------- |
| `status` | Reports CloudFront distribution status (`Deployed` vs propagating) and the site URL instead of ECS health. |
| `logs` | Container-oriented; behaves as on an unprovisioned ECS project (service-not-found guidance). |
| `exec`, `rollback` | Fail fast with an unsupported-target error before any AWS lookup — static sites have no shell to attach to and no revisions to restore. |
| `alerts` | Scaffolds a CloudFront `5xxErrorRate` alarm (SNS + optional chat webhook) pinned to `us-east-1`. |
| `secrets` | No vault is provisioned; `push`, `pull`, and `audit` exit immediately with an unsupported-target error. Static sites needing secrets need an API backend. |
| `db *` | No database can be provisioned; every command exits immediately with an unsupported-target error instead of probing RDS. |
| `diagnose` | Nothing to inspect — fails fast with an unsupported-target error before any AWS lookup; use `status` instead. |
| `sleep` / `wake` | Nothing to pause — there is no compute or database, so both exit successfully before any AWS call. |
| `add` | Addon infrastructure still scaffolds (SQS queues, DynamoDB tables, SES identities), but container env injection is skipped — there is no task role to inject into. Wire the Terraform outputs into your build manually. |
| `domain add` | Not supported yet: it patches `terraform/cloudfront.tf`, which static never generates. Attach a custom domain to the distribution in the AWS console for now. |
| `drift`, `gc`, `destroy`, `eject` | Work as usual (`destroy` tears down the bucket and distribution; `eject` leaves pure Terraform). |

## See also

- [Stack Architecture](/grada/guides/architecture/) for the static topology and the Fargate-vs-Lambda tradeoff table.
- [`npx grada-run`](/grada/cli/init/) for the `--target` flag and static validation.
- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for the shared pipeline stages.
- [Understanding Your AWS Bill](/grada/guides/understanding-your-bill/) for usage-billing drivers.
