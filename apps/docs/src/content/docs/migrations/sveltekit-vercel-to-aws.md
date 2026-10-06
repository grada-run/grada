---
title: "Migrating SvelteKit from Vercel to AWS"
description: "Pick a compute target, switch to adapter-node, and map Vercel storage to Grada add-ons."
---

Leaving Vercel means answering two questions: **where does the app run**, and **where does the data live**. Grada maps both onto explicit choices instead of Vercel's implicit platform.

## Choose your compute target

| SvelteKit shape | Grada target | Command |
|---|---|---|
| SSR app, sporadic traffic | `--target lambda` | `npx grada-run --target lambda` |
| Prerendered / static site (`adapter-static`) | `--target static` | `npx grada-run --target static` |
| SSR with steady traffic or background work | `--target ecs` (default) | `npx grada-run --target ecs` |

- **Lambda** runs your `adapter-node` build as a container image through the Lambda Web Adapter behind API Gateway + CloudFront. Scale-to-zero, `$0` idle.
- **Static** deploys the prerendered `build/` output straight to S3 + CloudFront. No containers, no VPC, no database.
- **ECS** runs the Node server always-on in Fargate behind an ALB + CloudFront.

`vercel.json` redirects are auto-translated into ALB listener rules on `--target ecs` only — Lambda and static targets skip them with a warning.

## Map Vercel storage to add-ons

| Vercel | Grada | Command |
|---|---|---|
| Vercel KV (Upstash Redis) | ElastiCache Valkey | `grada add db:redis` |
| Vercel Postgres (Neon) | Aurora Serverless v2 Postgres | `grada --needsDatabase --db-engine aurora-postgresql`, then `grada db import --from <neon-url>` |
| Vercel Blob | Private S3 + CloudFront | `grada add storage:s3` |

## Framework fix: switch to the Node adapter

If you are seeing a warning from `grada` about your SvelteKit adapter, your project is currently using `@sveltejs/adapter-auto` (which often defaults to Vercel) or the explicit `@sveltejs/adapter-vercel`.

These adapters are designed specifically for proprietary serverless edge networks. To run your SvelteKit app in a scalable, standard Docker container on AWS, switch to Svelte's official Node adapter. (Prerendered sites skip this — use `adapter-static` with `--target static` instead.)

### 1. Install the Node Adapter

```bash
npm install -D @sveltejs/adapter-node
npm uninstall @sveltejs/adapter-auto @sveltejs/adapter-vercel
```

### 2. Update `svelte.config.js`

**Before (Locked into Vercel/Auto):**
```javascript
import adapter from '@sveltejs/adapter-auto'; // or '@sveltejs/adapter-vercel'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	}
};

export default config;
```

**After (AWS Ready):**
```javascript
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter()
	}
};

export default config;
```

### 3. Deploy

Your SvelteKit app is now decoupled!

Run `npx grada-run apply`. The CLI will automatically detect the standard Node build output, package it into a hardened Docker container, and deploy it to your AWS cluster.

## Next steps

- [Migration Overview](/grada/migrations/) for the full provider-to-target matrix.
- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what happens on `git push`.
- [Supported Frameworks](/grada/guides/frameworks/) for SvelteKit adapter requirements.
