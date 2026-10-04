---
title: CI/CD Pipeline & First Deploy
description: How the generated GitHub Actions workflow builds, scans, and deploys your app with zero stored AWS keys.
sidebar:
  order: 1
---

Every `npx grada-run` run generates `.github/workflows/deploy.yml`. This page explains what that pipeline does, when it runs, and why your site returns `503` until the first push completes.

## When it runs

The workflow triggers on two events (`templates/github/deploy.yml`):

- A `push` to your deploy branch (`{{DEPLOY_BRANCH}}`, chosen during setup).
- A weekly Sunday cron (`0 0 * * 0`) that re-applies the Terraform configuration, so drift and base-image updates converge automatically.

The region, ECR repository, ECS cluster, and ECS service names are baked in at generation time as `<project>-repo`, `<project>-cluster`, and `<project>-service`.

## No stored AWS keys

Authentication uses GitHub OIDC, not long-lived credentials. The workflow declares:

```yaml
permissions:
  id-token: write
  contents: read
```

and assumes the `{{PROJECT_NAME}}-github-actions-role` IAM role created by `terraform/oidc.tf`. There is nothing to rotate and no secret to leak. (If your AWS account already has a GitHub OIDC provider, set `create_oidc_provider = false` in `terraform/oidc.tf` — see [apply](/grada/cli/apply/).)

## The five stages

1. **IaC security scan.** Trivy scans `terraform/` for vulnerabilities, secrets, and misconfigurations (`CRITICAL,HIGH`). It is informational only (`exit-code: '0'`), so it never blocks the build; results land in the GitHub step summary.
2. **Infrastructure sync.** The `grada-run/grada-action@v1` step runs Terraform against `terraform/`, so infrastructure changes committed alongside code are applied before the new image rolls out.
3. **Build & push.** The workflow logs in to Amazon ECR, runs `docker build` on your generated `Dockerfile`, and tags the result with both the short commit SHA (e.g. `abc1234`, the immutable deploy artifact) and `latest` (kept for convenience and scanning).
4. **Container scan.** Trivy scans the built image (`os,library`, `ignore-unfixed: true`), again informational only with results in the step summary.
5. **Deploy.** Both tags are pushed to ECR then the workflow registers a brand-new ECS task definition revision pinned to the SHA-tagged image and deploys it (`aws ecs update-service --task-definition <new-revision> --force-new-deployment`), which rolls the new image across your tasks behind the ALB. Because every push creates a fresh revision, `npx grada-run rollback [revision]` always has history to return to — and Terraform is configured to leave the service's task definition alone (`lifecycle { ignore_changes = [task_definition] }`), so the next `apply` never reverts a code-only deploy.

## Lambda target pipeline

On `--target lambda` projects the same `deploy.yml` shape applies, but the Deploy stage pushes the SHA-tagged image to ECR and calls `aws lambda update-function-code` (then `aws lambda wait function-updated`) instead of registering a task definition — Terraform ignores the function's `image_uri` (mirroring the ECS `task_definition` rule) so code deploys and `apply` never fight. There is no task-revision history, so `rollback` is ECS-only; redeploy a previous SHA tag to revert.

## Static target pipeline

On `--target static` projects the workflow has no build-and-push stages: after the IaC scan and infrastructure sync it runs `npm ci` and `npm run build` on Node.js 22, `aws s3 sync`s the build folder (`BUILD_DIR`, auto-detected) with `--delete`, and issues a `/*` CloudFront invalidation. There is no `503` window and no image history — the first push publishes the site, and every push republishes it. `rollback` is ECS-only here too.

## Optional pre-deploy migration gate

`db migrate --cmd "<command>" --setup-ci` adds a migration step to the Deploy stage: after the new task definition is registered and before the service updates, it runs your migration command as a one-off ECS task against the newly built image — a failing migration halts the release automatically. Re-running the command updates the wired step in place. `init` can wire the same gate at scaffold time with `--setup-ci-migrate` (or the interactive prompt when a database and migration command are detected). ECS targets only — Lambda projects skip the gate (run migrations from CI against your database endpoint instead). See [`db migrate`](/grada/cli/db/).

## Scheduled drift detection (opt-in)

`--setup-ci-drift` (or `drift --setup` on an existing project) scaffolds a second workflow, `.github/workflows/drift.yml`, that runs `terraform plan` daily at 06:00 UTC plus on manual dispatch. When live AWS state differs from Terraform it opens (or updates, without spamming) a GitHub Issue labeled `iac-drift` with the plan diff; when drift resolves it comments `✅ Drift resolved` and closes the issue. Set a `SLACK_WEBHOOK_URL` repository secret to also post alerts to Slack. Run `npx grada-run drift` anytime for the same check locally. See [`drift`](/grada/cli/drift/).

## Why you see a 503 first

`npx grada-run apply` provisions the ALB, cluster, and service, but no container image exists until this workflow runs once. Pushing to your deploy branch (`git add . && git commit -m "ci: infra" && git push`) builds and deploys the first image, clearing the `503`. If the service stays unhealthy after that, run `npx grada-run diagnose` — usually the container failed its ALB health check (see [Dockerfiles](/grada/guides/dockerfiles/)). (On `--target lambda` projects the same flow provisions the API Gateway and function instead; `apply` seeds a placeholder image so Day-0 succeeds, and the first push replaces it.)

## Related workflows

- `preview.yml` / `teardown.yml` exist only when ephemeral PR previews are enabled. See [Ephemeral PR Previews](/grada/guides/ephemeral-pr-previews/).
- Secrets are injected at deploy time from AWS Secrets Manager, never from the repo. See [Secrets Management](/grada/guides/secrets-management/).

## See also

- [Quickstart](/grada/guides/quickstart/) for the 5-minute path that ends here.
- [Supported Frameworks](/grada/guides/frameworks/) for what the pipeline builds.
- Migrating? See [Vercel (Next.js)](/grada/migrations/nextjs-vercel-to-aws/), [Vercel (Astro)](/grada/migrations/astro-vercel-to-aws/), [Vercel (SvelteKit)](/grada/migrations/sveltekit-vercel-to-aws/), and [Heroku (Procfile)](/grada/migrations/heroku-procfile-to-aws/).
