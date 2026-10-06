---
title: Supported Frameworks & Detection
description: Which frameworks grada detects, the signals it looks for, the valid --framework ids, and per-framework requirements.
sidebar:
  order: 2
---

`grada` is designed to be as "zero-config" as possible. During setup, it inspects your repo (`src/utils/detector.js`) and preselects a framework preset. However, because different frameworks have unique internal architectures (especially around network binding and build outputs), a few frameworks require minor application-level tweaks to run securely in a Dockerized AWS Fargate environment.

## The 3-tier support philosophy

We handle framework requirements using a 3-tier strategy so you are never left guessing why a deployment failed:

1. **Zero-touch plugins (Tier 1):** If you scaffold through one of our ecosystem plugins (e.g., `nest add nest-grada` or `cookiecutter-django-grada`), your project is generated pre-configured for grada deployment. Zero manual intervention required.
2. **Intelligent CLI pre-flight (Tier 2):** If you run the standalone `grada` CLI against a raw repository, the CLI statically analyzes your code. If it detects a missing production requirement (like a localhost binding), it will flag it inline in your terminal with the exact copy-paste fix.
3. **In-repo docs (Tier 3):** The generated `DEPLOYMENT.md` file always contains a framework-specific checklist before you push to CI/CD.

## Detection precedence

Checks run top-down; the first match wins.

| # | Signal | Preset (`id` / name) |
| - | ------ | -------------------- |
| 1 | `package.json` depends on `@nestjs/core` | `nestjs` / NestJS |
| 2 | `package.json` depends on `next` | `nextjs` / Next.js |
| 3 | `package.json` depends on `nuxt` | `nuxt` / Nuxt 3 (SSR) |
| 4 | `package.json` depends on `express` | `node` / Node.js / Express |
| 5 | `package.json` depends on `@sveltejs/kit` | `svelte` / SvelteKit SSR |
| 6 | `package.json` depends on `react-scripts`, `gatsby`, `astro`, `vite`, `@vue/cli-service`, or `@angular/cli` | `static` / (that generator) |
| 7 | `requirements.txt` contains `fastapi` | `python` / Python FastAPI |
| 8 | `requirements.txt` contains `django`, or `manage.py` exists | `django` / Django |
| 9 | `Gemfile` contains a `rails` gem | `rails` / Ruby on Rails |
| 10 | `go.mod` exists | `go` / Go |
| 11 | No match | No preset — you pick from the interactive list |

Notes from the actual code:

- Both `dependencies` and `devDependencies` are searched, so a framework listed only under dev dependencies still matches.
- A malformed `package.json` or `vercel.json` is silently ignored (no match), never fatal.
- An empty `vercel.json` (no `redirects`, `headers`, or `rewrites`) is treated as absent.

## Valid `--framework` ids

The interactive picker and the headless `--framework` flag accept: `node`, `nestjs`, `nextjs`, `nuxt`, `svelte`, `python`, `django`, `rails`, `go`, `static`. In headless mode with no `--framework`, detection applies and anything unmatched falls back to `static`.

Framework and `--target` are independent choices with one guardrail: `--target static` requires the `static` preset — or a detected static export (Next.js `output: 'export'`, SvelteKit `adapter-static`) — and rejects anything else with a validation error. Every other framework runs on `ecs` and `lambda` — Lambda via the Web Adapter, with workers, ALB listener rules, and the migration gate skipped.

## Per-framework defaults

- **Static build directory** (`buildDir`): SvelteKit `build`, Gatsby `public`, Next.js static export `out`, everything else (`astro`, `vite`, Vue, Angular) `dist`. This selects the folder the generated `Dockerfile` serves — or, on `--target static`, the folder synced to S3 (`BUILD_DIR`).
- **Default container port**: `8080` for `static` and `go`, `8000` for `python` and `django`, `3000` for everything else (headless uses `8080` only when `--framework=static`, else `3000`).
- **Database prompt**: offered only for backend presets (`node`, `nestjs`, `nextjs`, `nuxt`, `svelte`, `python`, `django`, `rails`, `go`).

## Framework requirements cheat sheet

| Framework | What `grada` automates | Application code requirement | Zero-click starter / plugin |
|---|---|---|---|
| **Next.js** | Multi-stage Dockerfile, CloudFront edge routing, `vercel.json` parsing | `output: 'standalone'` must be set in `next.config.js` (container targets; static exports use `output: 'export'` with `--target static`) | Built-in CLI detection |
| **NestJS** | Multi-stage TypeScript build (`dist/`), unprivileged Node runtime | `await app.listen(port, '0.0.0.0')` in `src/main.ts` | `nest-grada` (`nest add`) |
| **FastAPI** | Alpine Python container, Uvicorn CLI args, unprivileged port mapping | None (0.0.0.0 set via Docker CMD) | `cookiecutter-fastapi-grada` |
| **Django** | Gunicorn WSGI adapter, Celery worker topologies, RDS bindings | None (0.0.0.0 set via Docker CMD) | `cookiecutter-django-grada` |
| **Ruby on Rails** | Puma adapter, `RAILS_MASTER_KEY` injection into Secrets Manager placeholder, Kamal Dockerfile replaced with a minimal multi-stage Alpine build | None (0.0.0.0 set via Docker CMD) | `rails-template-grada` |
| **Nuxt 3** | Nitro-optimized Node output | None (`NITRO_HOST=0.0.0.0` injected automatically) | `nuxt-grada` |
| **SvelteKit** | Node adapter conversion | None (`HOST=0.0.0.0` injected automatically) | `svelte-adapter-grada` |
| **Static Sites** *(Vite, Astro, React)* | Output folder detection (`dist/`, `build/`, `out/`), Nginx routing | None | `vite-plugin-grada` |

## Post-detection checks

After detection, setup validates framework-specific requirements and warns before generating:

- **NestJS**: `src/main.ts` (or `main.js`) must bind `0.0.0.0`, e.g. `await app.listen(process.env.PORT ?? 3000, '0.0.0.0')`.
- **Next.js**: config must set `output: 'standalone'` (`.js/.mjs/.cjs/.ts` checked) — unless it sets `output: 'export'`, which routes to `--target static` instead.
- **SvelteKit**: adapter must not be `@sveltejs/adapter-vercel` or `adapter-auto`.
- **Astro**: adapter must not be `@astrojs/vercel`.

Alongside detection, setup also auto-detects `Procfile` (web/worker commands), `vercel.json` edge rules (translated to ALB listener rules), and `docker-compose.yml` services (port override plus sidecars).

## The golden rule: 0.0.0.0 vs localhost

The most common reason a newly deployed container fails its ALB health check is network binding.

In local development, frameworks bind to `localhost` (or `127.0.0.1`) for security. However, inside a Docker container on AWS ECS, binding to `localhost` means the web server only listens to internal container traffic. The AWS Application Load Balancer (ALB) trying to route traffic from the outside world will hit a closed port, resulting in a `502 Bad Gateway` or `503 Service Temporarily Unavailable`.

**Always ensure your application explicitly binds to `0.0.0.0`.**

## See also

- [Dockerfiles & the container contract](/grada/guides/dockerfiles/) for what your app must do at runtime.
- [Headless Mode](/grada/guides/headless/) for automating framework selection.
- [Examples](/grada/guides/examples/) for reference repositories and ecosystem plugins per framework.
