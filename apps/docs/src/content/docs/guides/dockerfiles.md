---
title: Dockerfiles & the Container Contract
description: What your app must do at runtime (port, bind address, health check) and the per-framework prerequisites.
sidebar:
  order: 4
---

Setup generates a framework-specific Alpine multi-stage `Dockerfile` engineered for zero Critical/High CVEs. All ten presets — including the generic Node.js, Python, and Django images — build dependencies in an isolated `builder` stage and ship only production artifacts in a minimal `runner` stage with no package managers. Your app only needs to honor a small runtime contract — plus a few per-framework prerequisites printed as warnings (`src/utils/warnings.js`) at the end of setup.

Two target notes: on `--target lambda` the generated `Dockerfile` additionally embeds the AWS Lambda Web Adapter extension (inserted after the last `FROM`) so standard HTTP servers handle API Gateway events with zero code changes; on `--target static` no `Dockerfile` is generated at all — deploys sync the build folder to S3 instead.

## The container contract

Every generated image assumes three things. Violating any of them is the most common cause of failing ALB health checks after an otherwise successful `apply`:

1. **Listen on `$PORT`.** The container must serve traffic on the port baked in as `{{PORT}}` (default per framework — see [Supported Frameworks](/grada/guides/frameworks/)).
2. **Bind `0.0.0.0`, not `localhost`.** Localhost-bound apps are unreachable inside ECS networking and Docker.
3. **Answer the health check with `200 OK`.** The ALB polls your health-check path (default `/`) and accepts any `2xx–3xx` status; anything outside that range marks the task unhealthy and the pipeline's new deployment never stabilizes.

## Per-framework prerequisites

| Framework | What setup warns you about |
| --------- | -------------------------- |
| NestJS | Bind `0.0.0.0` in `src/main.ts`: `await app.listen(process.env.PORT ?? 3000, '0.0.0.0')` |
| Next.js | Set `output: 'standalone'` in your Next config and create a health-check route (copy-paste code is in the generated README's "Critical Application Prerequisites") |
| Node.js / Express | An `index.js` entrypoint at the project root — the image runs `node index.js` directly, so a `start` script alone is not enough (use a `Procfile` `web:` command for any other start command) — and `0.0.0.0` binding |
| Python (FastAPI) | Web framework in `requirements.txt`, `0.0.0.0` binding, and a health-check route returning `200 OK` |
| Rails | Your default `Dockerfile` is backed up to `Dockerfile.bak` and replaced with the Alpine build; if you use SQLite locally but provisioned RDS, add the `pg` gem |
| Static sites | Output folder defaults to `/app/dist` — if your framework emits `build/` or `out/`, update the `COPY` command; ensure a `build` script exists (e.g. `vite build`) |

Warnings are skipped with `--preconfigured` and for `static` projects whose build directory was auto-detected.

## What command runs your app

The container's start command is resolved in this order:

1. `Procfile` `web:` command, if a `Procfile` exists (a `worker:` process additionally generates `worker.tf`, i.e. a second ECS service that doubles Fargate cost).
2. Otherwise the `command` of the `docker-compose.yml` web service, if one exists.
3. Otherwise the default `CMD` in the generated `Dockerfile` (for generic Node.js projects this is `node index.js`).

## Keeping images lean

Setup writes a `.dockerignore` excluding `.git/`, `terraform/`, state files, and `.env`, and appends Terraform entries to an existing `.gitignore`. Never commit `.env` — runtime secrets come from AWS Secrets Manager (see [Secrets Management](/grada/guides/secrets-management/)).

## See also

- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for how the image is built and rolled out.
- [diagnose](/grada/cli/diagnose/) for reading ECS failure output when the contract is broken.
