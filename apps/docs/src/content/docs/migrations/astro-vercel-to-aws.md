---
title: "Migrating Astro from Vercel to AWS"
description: "Pick a compute target, switch to the Node adapter, and map Vercel storage to Grada add-ons."
---

Leaving Vercel means answering two questions: **where does the app run**, and **where does the data live**. Grada maps both onto explicit choices instead of Vercel's implicit platform.

## Choose your compute target

| Astro shape | Grada target | Command |
|---|---|---|
| SSR / server output, sporadic traffic | `--target lambda` | `npx grada-run --target lambda` |
| Static output (`output: 'static'`), content sites | `--target static` | `npx grada-run --target static` |
| SSR with steady traffic or background work | `--target ecs` (default) | `npx grada-run --target ecs` |

- **Lambda** runs your standalone Node server as a container image through the Lambda Web Adapter behind API Gateway + CloudFront. Scale-to-zero, `$0` idle.
- **Static** deploys the `dist/` output straight to S3 + CloudFront. No containers, no VPC, no database.
- **ECS** runs the standalone server always-on in Fargate behind an ALB + CloudFront.

`vercel.json` redirects are auto-translated into ALB listener rules on `--target ecs` only — Lambda and static targets skip them with a warning.

## Map Vercel storage to add-ons

| Vercel | Grada | Command |
|---|---|---|
| Vercel KV (Upstash Redis) | ElastiCache Valkey | `grada add db:redis` |
| Vercel Postgres (Neon) | Aurora Serverless v2 Postgres | `grada --needsDatabase --db-engine aurora-postgresql`, then `grada db import --from <neon-url>` |
| Vercel Blob | Private S3 + CloudFront | `grada add storage:s3` |

## Framework fix: switch to the Node adapter

If you are seeing a warning from `grada` about your Astro adapter, it means your project is currently configured to build specifically for Vercel's proprietary serverless network.

To deploy Astro as a containerized application on standard AWS infrastructure (Lambda or ECS targets), switch to Astro's official Node.js adapter. (Static-output sites skip the adapter entirely — see `--target static` above.)

### 1. Install the Node adapter

```bash
npm install @astrojs/node
npm uninstall @astrojs/vercel
```

### 2. Update `astro.config.mjs`

**Before (Vercel Lock-in):**
```javascript
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel/serverless';

export default defineConfig({
  output: 'server',
  adapter: vercel(),
});
```

**After (AWS Ready):**
```javascript
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone'
  }),
});
```

### 3. Deploy

That's it! Your Astro app is now decoupled from Vercel.

Run `npx grada-run apply` and the CLI will automatically package this standalone Node server into a hardened Docker container and deploy it to your AWS cluster.

## Next steps

- [Migration Overview](/grada/migrations/) for the full provider-to-target matrix.
- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what happens on `git push`.
- [Supported Frameworks](/grada/guides/frameworks/) for Astro build requirements.
