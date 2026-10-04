---
title: Quickstart (5 minutes)
description: Go from empty repo to live AWS deployment in five minutes with grada.
sidebar:
  order: 0
---

Deploy your first app to AWS in about five minutes. This is the fastest path; follow the links for details at each step.

## Prerequisites

- Node.js 18+, an AWS account, and AWS credentials in your terminal (`aws sso login` or `aws configure`).
- A git repository with your app. Stuck on auth? See [Troubleshooting AWS Credentials](/grada/guides/aws-credentials/).

## Step 1 — Scaffold

```bash
npx grada-run
```

The wizard auto-detects your framework, `Procfile`, `vercel.json`, and Compose files, then writes Terraform, a `Dockerfile`, and `.github/workflows/deploy.yml`. It also asks which compute target to generate (`ecs`, `lambda`, or `static`) — pick `static` for static-site frameworks; the default is `ecs`. Not sure your stack is supported? Check [Supported Frameworks](/grada/guides/frameworks/).

## Step 2 — Provision

```bash
npx grada-run apply
```

This creates the ALB, ECS cluster, and service. Your URL returns `503` until the first image is pushed — that is expected.

## Step 3 — Ship

```bash
git add .
git commit -m "ci: infra"
git push
```

Pushing to your deploy branch triggers the pipeline: Terraform sync, Docker build, image scan, ECS rollout. How it works is explained in [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/).

## Step 4 — Verify

- Open the ALB URL from the `apply` output.
- Still seeing `503` or `502` after the workflow finishes? Run `npx grada-run diagnose` — usually the container failed its health check. See [Dockerfiles & the Container Contract](/grada/guides/dockerfiles/).
- Need env vars? Continue with [Secrets Management](/grada/guides/secrets-management/).

## Next steps

- [Supported Frameworks](/grada/guides/frameworks/) — framework requirements and detection rules.
- [Reference Implementations & Examples](/grada/guides/examples/) — working repos per framework.
- [Headless Mode & Automation](/grada/guides/headless/) — non-interactive `npx grada-run --headless` for CI.
- Migrating? Start with [Vercel (Next.js)](/grada/migrations/nextjs-vercel-to-aws/), [Vercel (Astro)](/grada/migrations/astro-vercel-to-aws/), [Vercel (SvelteKit)](/grada/migrations/sveltekit-vercel-to-aws/), or [Heroku (Procfile)](/grada/migrations/heroku-procfile-to-aws/).
