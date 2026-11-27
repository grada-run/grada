---
title: "Managed Database Connections"
description: "Provision a managed AWS RDS PostgreSQL database for backend frameworks."
sidebar:
  order: 6
---

When you run `npx grada-run` for a backend framework (Node, Django, Rails, Go, etc.), the CLI prompts you to automatically provision a managed AWS RDS PostgreSQL database. The database adds a fixed monthly cost on top of the stack baseline — the `apply` preview itemizes it before you provision.

## Zero-Trust Architecture

If you select "Yes", `grada` builds a true zero-trust network topology:
1. The PostgreSQL instance is deployed into heavily restricted **Isolated Subnets**.
2. It is given a strict Security Group that *only* allows inbound traffic from your specific ECS Fargate containers on port `5432`.
3. The database is completely inaccessible from the public internet.
4. TLS is enforced server-side via a dedicated parameter group (`rds.force_ssl`, or `require_secure_transport` on MySQL) — plaintext clients cannot negotiate. Aurora enforces through a cluster parameter group whose family derives from the resolved regional default engine at plan time, so the floating version never mismatches.

## Enforcing TLS on existing databases

Trees scaffolded before TLS enforcement pick it up on the next `apply`, but enforcement only bites after a reboot — and a single-AZ micro has no standby, so plan minutes of downtime:

1. Snapshot first: `npx grada-run db backup`.
2. `npx grada-run apply` in your maintenance window, then reboot (`aws rds reboot-db-instance`, or `aws rds reboot-db-cluster` for Aurora) if the window hasn't.
3. Verify: connect with `PGSSLMODE=require` (PostgreSQL) and confirm a plaintext attempt is refused.

## Aurora major-version rollovers

The Aurora TLS group takes its family from the regional default engine at creation; later default-major rollovers (years apart) change nothing, so `apply` stays clean and the group keeps enforcing TLS on your still-current major. Only a manual major upgrade needs the group to follow — and because the group is attached, the follow is a rename, never a taint (same-name replacement cannot apply while attached). Recover:

1. Snapshot first: `npx grada-run db backup` (cluster snapshots).
2. Major-upgrade the cluster in your maintenance window (RDS console or `aws rds modify-db-cluster` with major upgrade enabled), after the usual compat homework — extensions, parameter changes, and a tested rollback snapshot. Major upgrades always need this care; the manual step is inherent, not grada overhead.
3. Bump the group stamp to the new major in `terraform/grada.auto.tfvars` (`aurora_param_group_stamp = "17"`), then re-apply. The group is replaced create-before-destroy (pending-reboot, TLS already enforced — no behavior change) and the cluster points at the matching family. Leave the stamp set — the next major bumps it again.

Upgrading to this grada version replaces the group once (its name no longer carries the major) — create-before-destroy applies it cleanly. If you are mid-rollover-failure on the old naming (apply failing on a family mismatch), do the major upgrade first, then upgrade grada.

## Auto-Injected Environment Variables

You do not need to configure database connection strings manually. The generated Terraform automatically creates a secure, random master password in AWS Secrets Manager and injects the following environment variables directly into your running containers:

* `DB_HOST` (The internal AWS DNS endpoint)
* `DB_PORT` (5432, or 3306 for MySQL)
* `DB_NAME` (Your deterministic database name, derived from your project name)
* `DB_USER` (Injected securely at runtime)
* `DB_PASSWORD` (Injected securely at runtime)

To connect your application, simply configure your ORM (Prisma, Django, TypeORM, Active Record) to read from these grada injected variables.

Most frameworks expect a single connection string (e.g., `DATABASE_URL`). Construct it from the injected variables at runtime:

```bash
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
```

If the password contains special characters (e.g., `@`, `[`, `/`), percent-encode it before placing it in the URI.

RDS enforces TLS (`rds.force_ssl = 1`): libpq-based clients negotiate it automatically, but drivers that default to plaintext need an explicit opt-in — append `?sslmode=require` to the URL (Prisma, JDBC-style clients) or pass the driver's SSL option (e.g. `ssl` in Node `pg`).

## Running Database Migrations

Because the database is in an isolated subnet, you cannot run schema migrations directly from your local laptop.
The best practice is [`db migrate`](/grada/cli/db/) — it launches a short-lived ECS task inside your VPC that runs your migration command (auto-detected for Prisma, Drizzle, Alembic, Django, Rails, and `db:migrate` npm scripts, or pass `--cmd`), streams the logs to your terminal, and exits with your migration's exit code.

To gate releases on migrations, run `db migrate --cmd "<command>" --setup-ci` once: it adds a pre-deploy step to `.github/workflows/deploy.yml` that runs migrations against the newly built image before the ECS service updates, halting the release if they fail.

## Inspecting Data Locally

For read-only inspection from your laptop (psql, DBeaver, Prisma Studio), open a secure tunnel with [`db connect`](/grada/cli/db/) instead of exposing the database — and run schema changes with [`db migrate`](/grada/cli/db/) so they execute inside the VPC.

## Choosing an Engine

When you answer "Yes" to the database prompt (or pass `--db-engine`), pick the engine that fits your workload:

| Engine | What you get | Cost |
| ------ | ------------ | ---- |
| `postgres` (default) | RDS PostgreSQL 16 on `db.t4g.micro` | ~$13.98/mo fixed |
| `mysql` | RDS MySQL 8.0 on `db.t4g.micro`; containers get `DB_PORT=3306` and a `DB_ENGINE=mysql` marker | ~$13.98/mo fixed |
| `aurora-postgresql` | Aurora PostgreSQL Serverless v2, scaling 0–2 ACU with auto-pause (takes the regional Aurora default version) | $0/mo idle compute (+$0.12/ACU-hr when active, plus storage) |

MySQL projects get a `mysql://` connection string from `db connect`, and `db migrate` synthesizes the matching `DATABASE_URL` scheme automatically. Aurora clusters are discovered as `<project-name>-db-cluster` by every `db` subcommand; backups and restores use cluster snapshots. The architecture preview and cost estimate reflect the provisioned engine.

## Importing Existing Data

Bringing a database from Heroku, Supabase, or another provider? [`db import`](/grada/cli/db/) streams a local dump (`--file`, including `.sql.gz` and Postgres `.dump` archives) or a live remote database (`--from`) into your isolated instance through a temporary SSM tunnel — the database is never exposed to do it. Credentials travel via `PGPASSWORD` / `MYSQL_PWD` and are masked in all output; take a [`db backup`](/grada/cli/db/) checkpoint first.