---
title: "Migrating from Heroku to AWS (Procfile Support)"
description: "Map Heroku Procfile web and worker processes to AWS ECS Fargate services."
---

When migrating from Heroku or Render, you likely rely on a `Procfile` to define your application's architecture (e.g., a web server and a background worker like Celery or Sidekiq). 

`grada` natively understands Heroku `Procfile` syntax and automatically translates it into a production-grade, multi-container AWS architecture.

## How it Works

When you run `npx grada-run`, the CLI scans your root directory for a `Procfile`. 

### The `web` Process
If the CLI detects a `web:` declaration:
1. It overrides the default Docker `CMD`.
2. It provisions an AWS ECS Fargate service for this process.
3. It automatically wires this specific container to your public-facing Application Load Balancer (ALB) so it can receive internet traffic.

### The `worker` Process
If the CLI detects a `worker:` declaration:
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

## Next steps

- [CI/CD Pipeline & First Deploy](/grada/guides/cicd-pipeline/) for what happens on `git push`.
- [Supported Frameworks](/grada/guides/frameworks/) for Procfile and framework detection.
- [Background Workers](/grada/guides/background-workers/) for the worker service, SQS scale-to-zero, and day-2 operations.