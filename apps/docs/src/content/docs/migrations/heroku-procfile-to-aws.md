---
title: "Migrating from Heroku to AWS (Procfile Support)"
description: "Map Heroku dynos and Postgres to ECS services, SQS workers, and RDS."
---

When migrating from Heroku or Render, you likely rely on a `Procfile` to define your application's architecture (e.g., a web server and a background worker like Celery or Sidekiq).

`grada` natively understands Heroku `Procfile` syntax and automatically translates it into a production-grade, multi-container AWS architecture.

## Dyno-to-target matrix

| Heroku shape | Grada target | Notes |
|---|---|---|
| Web dyno (+ optional worker dyno) | `--target ecs` (default) | Web → ALB-backed Fargate service; `worker:` → separate `worker.tf` service |
| Web dyno only, sporadic traffic | `--target lambda` | Single scale-to-zero function; `worker:` entries are skipped with a warning |
| Heroku Postgres | Aurora/RDS + `db import` | See below — works with ECS and Lambda targets |
| Heroku Redis | ElastiCache Valkey | `grada add db:redis` |

Heroku apps with a `worker:` process **must** use `--target ecs` — Lambda and static targets have no worker service. For queue-driven (rather than Procfile-driven) workers, prefer `grada add queue:sqs`, which provisions the queue plus a scale-to-zero worker service on ECS.

## How the Procfile maps

When you run `npx grada-run`, the CLI scans your root directory for a `Procfile`.

### The `web` Process
If the CLI detects a `web:` declaration:
1. It overrides the default Docker `CMD`.
2. It provisions an AWS ECS Fargate service for this process (or the Lambda function command on `--target lambda`).
3. On ECS, it automatically wires this specific container to your public-facing Application Load Balancer (ALB) so it can receive internet traffic.

### The `worker` Process
If the CLI detects a `worker:` declaration (ECS targets only):
1. It generates a completely separate ECS Fargate task definition and internal service (`worker.tf`, no load balancer — though it still runs in the public subnets) running the same image with your worker command.
2. The service gets **no load balancer**, so nothing routes internet traffic to it — it still reaches your database, caches, and queues over the VPC network.
3. It shares the web container's secrets, database variables, and log group (worker entries carry the `worker` stream prefix), scaling independently of the web service.

## Example

**Your `Procfile`:**
```text
web: gunicorn myapp.wsgi
worker: celery -A myapp worker -l info
```

**The Result:**
Running `grada` will automatically generate the Terraform required to spin up both containers simultaneously from the exact same Docker image, scaling them independently based on your needs.

## Migrating Heroku Postgres

Provision the destination first, then stream the data in — no dump files, no public database exposure:

```bash
# 1. Scaffold with a database (Aurora recommended for scale-to-zero)
npx grada-run --target ecs --needsDatabase --db-engine aurora-postgresql
npx grada-run apply

# 2. Stream Heroku Postgres straight into private RDS over an SSM tunnel
grada db import --from <heroku-database-url> --yes
```

`db import` accepts a `--file <dump.sql>` instead if you prefer `pg_dump`. Run pending schema migrations afterwards with `grada db migrate`.

## Next steps

- [Migration Overview](/grada/migrations/) for the full provider-to-target matrix.
- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what happens on `git push`.
- [Supported Frameworks](/grada/guides/frameworks/) for Procfile and framework detection.
- [Background Workers](/grada/guides/background-workers/) for the worker service, SQS scale-to-zero, and day-2 operations.
