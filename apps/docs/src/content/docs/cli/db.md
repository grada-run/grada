---
title: db
description: Tunnel to, migrate, back up, and restore your managed RDS database.
---

Run migrations, create safety checkpoints, and restore your managed database — all from the terminal, without ever exposing the database to the public internet.

## Commands

```bash
npx grada-run db connect                  # Open a secure local tunnel
npx grada-run db migrate --cmd "<command>" # Run migrations inside your VPC
npx grada-run db backup                   # Create a snapshot checkpoint
npx grada-run db restore <snapshot-id>    # Restore from a snapshot
npx grada-run db enable-vector            # Enable pgvector for AI embeddings
npx grada-run db import --file <dump.sql> # Import a SQL dump
```

All commands work across engines: RDS PostgreSQL, RDS MySQL 8.0, and Aurora PostgreSQL Serverless v2 (see `--db-engine` in [init](/grada/cli/init/)). `db connect` prints `mysql://` URIs and tunnels to port `3306` for MySQL, and discovers Aurora clusters via `<project-name>-db-cluster` automatically.

Compute-target notes: on `--target lambda` projects, `backup` and `restore` work unchanged (pure RDS APIs), but `connect` and `import` need a running ECS container as a jump host and `migrate` and `enable-vector` run one-off ECS tasks — with no cluster to run in, they fail instead. Run migrations from CI against your database endpoint on Lambda projects. On `--target static` projects no database can exist, so every `db` command reports that none is provisioned.

## db connect

Connect your local tools (psql, DBeaver, DataGrip) or a local `.env` file directly to your isolated RDS instance. The command tunnels through a running ECS container as a jump host.

- Finds your RDS database (`<project-name>-db`, `<project-name>-db-cluster` for Aurora, or the `<workspace>` variants for PR-preview environments) and reads its endpoint and managed credentials from Secrets Manager.
- Prints the local host, port, database name, username, and a copy-pasteable `postgresql://` connection string. The password stays masked as `********` unless you pass `--show-credentials`.
- Finds a running container for the current project automatically and opens the tunnel via the Session Manager port-forwarding session. Press Ctrl+C to close it.
- Resolves its inputs automatically: cluster, service, and region (same order as `exec`: explicit flag → environment variable → `terraform/main.tf` → default).
- When no database is provisioned, or no containers are running, explains what to do (`init`/`apply`/`status`) and exits 1 instead of failing cryptically.
- On expired AWS credentials, points you to `aws sso login` / `aws configure` and exits 1 instead of throwing.
- Emits a `db_connect_run` telemetry event recording success and outcome. Credentials are never included in telemetry.

```bash
npx grada-run db connect
npx grada-run db connect --port 5544
npx grada-run db connect --show-credentials
npx grada-run db connect --workspace pr-123
```

Paste the printed connection string into DBeaver, or export it locally:

```bash
export DATABASE_URL="postgresql://dbadmin:<password>@localhost:5432/<dbname>"
```

The printed connection string already percent-encodes special characters in the username and password (AWS-generated passwords often contain `@`, `[`, or `/`). The standalone `Password:` line is shown verbatim — encode it yourself if you build a URI by hand instead of copying ours.

| Flag | Description |
| ---- | ----------- |
| `--port <port>` | Local port for the tunnel (defaults to the remote database port: `5432` for PostgreSQL/Aurora, `3306` for MySQL). Must be a number between 1 and 65535. |
| `--show-credentials` | Reveal the decrypted password in the terminal output. Masked by default. |
| `--workspace <name>` | Target a PR-preview environment (e.g. `--workspace pr-123`). Falls back to the workspace in `.terraform/environment`. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--region <region>` | Explicit AWS region override. |

## db migrate

Run schema migrations or seed scripts (Prisma, Drizzle, Alembic, Django, Rails, or anything custom) inside your VPC as a short-lived ECS task — no tunnel, no local database access needed. Logs stream live to your terminal, and the command exits with your migration's own exit code.

When you omit `--cmd`, the project is inspected for a known migration setup (`db:migrate` / `migrate` npm scripts, Prisma, Drizzle, Alembic, Django, Rails) and the detected command is used (in CI) or offered for confirmation (interactively).

When your task definition carries discrete `DB_*` credentials, the command synthesizes the engine-matching `DATABASE_URL` at runtime — with `PGSSLMODE=require` for PostgreSQL, since RDS/Aurora enforces `rds.force_ssl = 1`.

```bash
npx grada-run db migrate --cmd "npx prisma migrate deploy"
npx grada-run db migrate                     # auto-detect the command
npx grada-run db migrate --cmd "npm run db:seed" --timeout 1200
```

| Flag | Description |
| ---- | ----------- |
| `--cmd <command>` | Migration command to run. Auto-detected when omitted. |
| `--task-def <task-def>` | Task definition (ARN or `family:revision`) to run. Defaults to the live service revision. |
| `--timeout <seconds>` | Give up after this long (default `600`). The task is stopped automatically. |
| `--setup-ci` | Install the pre-deploy migration gate into `.github/workflows/deploy.yml` instead of running. |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--container <name>` | Explicit container name override. |
| `--region <region>` | Explicit AWS region override. |

### Pre-deploy migration gate

`db migrate --setup-ci` adds a step to your deploy workflow that runs migrations against the newly built image **before** the ECS service updates — a failing migration halts the release automatically:

```bash
npx grada-run db migrate --cmd "npx prisma migrate deploy" --setup-ci
```

The step is re-installed cleanly on every run, so re-running the command updates the wired migration command in place.

## db backup

Create a point-in-time safety checkpoint of your database (a cluster snapshot for Aurora) before risky operations like migrations or restores. The command waits until the snapshot is ready, then prints the restore command for it.

```bash
npx grada-run db backup
npx grada-run db backup --id pre-migration-checkpoint
npx grada-run db backup --no-wait          # return immediately
```

| Flag | Description |
| ---- | ----------- |
| `--id <snapshot-id>` | Custom snapshot id. Defaults to `<db>-manual-YYYYMMDD-HHmmss`. |
| `--timeout <seconds>` | Give up waiting after this long (default `900`). Creation continues in the background. |
| `--no-wait` | Return immediately without waiting for the snapshot to become available. |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--db-identifier <id>` | Explicit RDS identifier override (instance or Aurora cluster). |
| `--region <region>` | Explicit AWS region override. |

## db restore

Restore your database from a manual or automated snapshot. Omit the snapshot id to pick from a list of available checkpoints, newest first.

Restoring works through Terraform: the command pins the snapshot in `terraform/database.tf` (`snapshot_identifier`, in the instance or `aws_rds_cluster` block), so the VPC wiring, security groups, and Secrets Manager integration stay intact and future applies stay clean. Run `npx grada-run apply` afterwards to perform the restore.

```bash
npx grada-run db restore                  # pick a snapshot interactively
npx grada-run db restore my-snapshot-id
npx grada-run db restore my-snapshot-id --yes   # skip confirmation (for CI)
```

> **Restoring replaces your current data.** Everything written after the snapshot is permanently discarded. Create a safety checkpoint with `npx grada-run db backup` first if you might need the current data.

| Flag | Description |
| ---- | ----------- |
| `<snapshot-id>` | Snapshot to restore (positional). Omit to choose interactively. |
| `--yes` | Skip the confirmation prompt. Required in non-interactive environments. |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--db-identifier <id>` | Explicit RDS identifier override (instance or Aurora cluster). |
| `--region <region>` | Explicit AWS region override. |

After `apply` completes, leave `snapshot_identifier` in `terraform/database.tf` — it keeps subsequent applies drift-free.

## db enable-vector

Enable the `pgvector` extension on RDS PostgreSQL or Aurora PostgreSQL for AI/RAG embeddings — no OpenSearch cluster required. Runs a one-off ECS task inside your VPC that executes `CREATE EXTENSION IF NOT EXISTS vector` using whatever client your image already has (`psql`, `pg`/`@prisma/client`, or `psycopg`), negotiating TLS on every branch for `rds.force_ssl` databases, then verifies the installed version. Refuses to run on MySQL projects.

```bash
npx grada-run db enable-vector
npx grada-run db enable-vector --task-def myapp-task:4 --timeout 300
```

If your project has a Prisma schema without `postgresqlExtensions`, the command prints the snippet to add. When the container has no usable PostgreSQL client, it exits 3 with install guidance instead of failing cryptically.

| Flag | Description |
| ---- | ----------- |
| `--task-def <task-def>` | Task definition to run (defaults to the service's active revision). |
| `--timeout <seconds>` | Give up waiting after this long (default `600`). |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--cluster <name>` | Explicit cluster name override. |
| `--service <name>` | Explicit service name override. |
| `--container <name>` | Explicit container name override. |
| `--region <region>` | Explicit AWS region override. |

## db import

Stream a local SQL dump or a remote database (Heroku, Supabase, Render, Railway) directly into your isolated RDS instance through an automated background SSM tunnel — the database stays private throughout.

```bash
npx grada-run db import --file ./prod.sql --yes
npx grada-run db import --file ./prod.sql.gz --yes   # gzipped dumps stream through gunzip
npx grada-run db import --file ./prod.dump --yes     # Postgres custom archives via pg_restore
npx grada-run db import --from "postgresql://user:pass@host:5432/db" --yes
```

- Pass exactly one of `--file` / `--from` (or pick interactively when neither is given).
- `.dump` archives restore with `pg_restore --no-owner --no-acl`; `--from` pipes `pg_dump` (`mysqldump` for MySQL targets) straight into the target client, so multi-gigabyte databases never touch your disk.
- **Secrets never touch argv or disk.** Target credentials come from Secrets Manager and travel via `PGPASSWORD` / `MYSQL_PWD`; `--from` passwords are parsed out of the URL and passed the same way. Validation errors print the URL with the password masked as `****`.
- **TLS by default.** Postgres clients on both sides run with `PGSSLMODE=require` (unless you pinned `PGSSLMODE`), since RDS/Aurora enforces `rds.force_ssl = 1`.
- The tunnel binds an ephemeral loopback port (never `5432`/`3306`, which may already serve a local database) and is always torn down afterwards, even on failure or Ctrl+C.
- Requires the matching client tools locally: `psql` / `pg_restore` / `pg_dump` (`brew install libpq`, then add `$(brew --prefix libpq)/bin` to `PATH`) or `mysql` / `mysqldump` (`brew install mysql-client`).

| Flag | Description |
| ---- | ----------- |
| `--file <path>` | Local `.sql`, `.sql.gz`, or `.dump` file to import. |
| `--from <url>` | Source `postgresql://` or `mysql://` URL (must include a database name). |
| `--yes` | Skip the confirmation prompt. Required in non-interactive environments. |
| `--project-name <name>` | Explicit project name override. |
| `--workspace <name>` | Target a PR-preview environment. |
| `--db-identifier <id>` | Explicit RDS identifier override. |
| `--region <region>` | Explicit AWS region override. |

> **Importing writes to your live database.** Take a safety checkpoint with `npx grada-run db backup` before importing into a database you care about.

## Prerequisites

- Run `npx grada-run apply` first with a managed database provisioned (answer "Yes" to the database prompt during `init`).
- `db connect` additionally needs the AWS CLI and the Session Manager plugin (`brew install session-manager-plugin` on Mac; the command prints the right instructions for your OS when it's missing). On expired credentials, refresh with `aws sso login` or `aws configure`. See the [AWS credentials guide](/grada/guides/aws-credentials/).

## See also

- [Managed Database Connections](/grada/guides/database-connections/)
- [exec](/grada/cli/exec/)
- [status](/grada/cli/status/)
