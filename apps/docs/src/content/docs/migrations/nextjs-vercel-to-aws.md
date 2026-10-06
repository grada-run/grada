---
title: "Migrating Next.js from Vercel to AWS"
description: "Pick a compute target, fix output standalone, and map Vercel storage to Grada add-ons."
---

Leaving Vercel means answering two questions: **where does the app run**, and **where does the data live**. Grada maps both onto explicit choices instead of Vercel's implicit platform.

## Choose your compute target

| Vercel shape | Grada target | Command |
|---|---|---|
| Serverless Functions (API routes, SSR, sporadic traffic) | `--target lambda` | `npx grada-run --target lambda` |
| Static Export (`output: 'export'`, no server code) | `--target static` | `npx grada-run --target static` |
| Full-stack / steady traffic / WebSockets / background work | `--target ecs` (default) | `npx grada-run --target ecs` |

- **Lambda** runs your container image through the Lambda Web Adapter behind API Gateway + CloudFront. Scale-to-zero, `$0` idle — closest to the Vercel serverless feel. No worker service, no ALB listener rules.
- **Static** deploys pre-built assets straight to S3 + CloudFront. No containers, no VPC, no database. Only valid for fully static exports.
- **ECS** runs always-on Fargate containers behind an ALB + CloudFront. Required for WebSockets, long-lived connections, and `Procfile` workers.

`vercel.json` redirects are auto-translated into ALB listener rules on `--target ecs`. Lambda and static targets have no ALB, so the CLI skips them with a warning — recreate them as API Gateway routes (Lambda) or CloudFront Functions (static) after provisioning, or move them into `next.config.js` rewrites/redirects instead.

## Map Vercel storage to add-ons

| Vercel | Grada | Command |
|---|---|---|
| Vercel KV (Upstash Redis) | ElastiCache Valkey | `grada add db:redis` |
| Vercel Postgres (Neon) | Aurora Serverless v2 Postgres | `grada --needsDatabase --db-engine aurora-postgresql`, then `grada db import --from <neon-url>` |
| Vercel Blob | Private S3 + CloudFront | `grada add storage:s3` |

Connection strings arrive as injected environment variables (`REDIS_URL`, `DATABASE_URL`) — no Upstash/Neon SDK changes beyond the host.

## Framework fix: `output: 'standalone'`

If you are seeing a warning from `grada` about `output: 'standalone'`, your Next.js configuration is missing a crucial setting required for containerized environments.

By default, Next.js requires your entire `node_modules` folder to run the production server. This creates massive, bloated Docker containers that boot slowly and cost more to host. The `standalone` output mode tells Next.js to trace your code and bundle *only* the specific files and dependencies actually used in production, creating an ultra-lean deployment artifact. (Static exports skip this — see `--target static` above.)

### 1. Update `next.config.js` (or `.mjs` / `.cjs`)

**Before (Vercel Default):**
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Other existing config...
};

export default nextConfig;
```

**After (AWS Ready):**
```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // <-- Add this line
  // Other existing config...
};

export default nextConfig;
```

### 2. (ECS only) Define a health check route

AWS Application Load Balancers require a route to ping to ensure your app is healthy. If you don't already have one, create a simple API route in your app (e.g. `app/api/health/route.ts` for App Router, or `pages/api/health.ts` for Pages Router) that returns a `200 OK` status.

When running `grada`, choose **Advanced Configuration** and set your ALB Health Check Path to this route (e.g., `/api/health`). Lambda targets don't need this (API Gateway health-checks differently).

### 3. Deploy

Run `npx grada-run apply`. The CLI's generated `Dockerfile` will automatically target your new `.next/standalone` directory and deploy the optimized build to the cloud.

## Next steps

- [Migration Overview](/grada/migrations/) for the full provider-to-target matrix.
- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what happens on `git push`.
- [Static-Site Hosting](/grada/guides/static-hosting/) if you chose `--target static`.
