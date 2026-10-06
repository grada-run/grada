---
title: "Migration Overview"
description: "Map Vercel, Heroku, and Docker Compose workloads onto Grada compute targets."
---

Every migration answers the same two questions: **where does the app run** (compute target) and **where does the data live** (add-ons). This page is the crossroads — pick your source on the left, your target on the right.

## Provider-to-target matrix

| Source workload | Grada target | Migration guide |
|---|---|---|
| Vercel Serverless Functions (SSR, API routes) | `--target lambda` | [Next.js](/grada/migrations/nextjs-vercel-to-aws/), [Astro](/grada/migrations/astro-vercel-to-aws/), [SvelteKit](/grada/migrations/sveltekit-vercel-to-aws/) |
| Vercel Static Export | `--target static` | Same framework guides + [Static-Site Hosting](/grada/guides/static-hosting/) |
| Vercel full-stack / steady traffic | `--target ecs` | Same framework guides |
| Heroku web dyno (+ worker dyno) | `--target ecs` | [Heroku Procfile](/grada/migrations/heroku-procfile-to-aws/) |
| Heroku Postgres / Redis | `--needsDatabase` / `db:redis` | [Heroku Procfile](/grada/migrations/heroku-procfile-to-aws/) (`db import`) |
| `docker-compose.yml` services | `--target ecs` (sidecars co-located) | [Docker Compose](/grada/guides/docker-compose/) |

## Storage and service mapping

| Source | Grada | Command |
|---|---|---|
| Vercel KV / Heroku Redis / Compose `redis` | ElastiCache Valkey | `grada add db:redis` |
| Vercel Postgres / Heroku Postgres / Compose `postgres` | RDS or Aurora Serverless v2 | `grada --needsDatabase --db-engine aurora-postgresql`, then `grada db import` |
| Vercel Blob / Heroku attachments | Private S3 + CloudFront | `grada add storage:s3` |
| Heroku worker dyno / Compose helper | SQS + scale-to-zero worker (ECS) | `grada add queue:sqs` |
| Vercel Cron | EventBridge Scheduler + one-off tasks | `grada add cron` |

## Target cheat sheet

- **`--target ecs`** (default): always-on Fargate + ALB + CloudFront. Required for WebSockets, `Procfile` workers, Compose sidecars, and ALB listener rules.
- **`--target lambda`**: scale-to-zero containers via the Lambda Web Adapter + API Gateway + CloudFront. No workers, no sidecars, no listener rules — `$0` idle.
- **`--target static`**: zero-compute S3 + CloudFront for pre-built assets. No containers, VPC, database, or secrets.

## Next steps

- Start with your framework guide above, then [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/).
- [Understanding Your AWS Bill](/grada/guides/understanding-your-bill/) for what each target costs.
