---
title: "Migrating Astro from Vercel to AWS Fargate"
description: "Switch the Astro adapter to Node standalone to leave Vercel for AWS Fargate."
---

If you are seeing a warning from `grada` about your Astro adapter, it means your project is currently configured to build specifically for Vercel's proprietary serverless network. 

To deploy Astro as a containerized application on standard AWS infrastructure, you simply need to switch to Astro's official Node.js adapter.

## How to Fix

### 1. Install the Node adapter
Run the following command in your terminal to swap out the Vercel adapter for the Node adapter:

```bash
npm install @astrojs/node
npm uninstall @astrojs/vercel
```

### 2. Update `astro.config.mjs`
Open your Astro configuration file and replace the Vercel import with the Node import.

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

- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what happens on `git push`.
- [Supported Frameworks](/grada/guides/frameworks/) for Astro build requirements.
