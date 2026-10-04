---
title: Docker Compose Support
description: How grada maps docker-compose.yml services to ECS — web-service selection, ports, env vars, and sidecars.
sidebar:
  order: 5
---

If your repo contains a Compose file (`docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, or `compose.yaml`), setup parses it (`src/utils/dockerCompose.js`) and translates its services into the ECS task definition. Your Compose file keeps working locally, and these are the exact mapping rules that decide what runs in AWS.

## File discovery

Only the repo root is checked, trying `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, then `compose.yaml` in order — the first file found wins. A file with no `services` key — or one that fails YAML parsing — is treated as absent (a warning is printed, setup continues), so a stray or malformed file never blocks generation.

## Which service is "web"

The service used as the ECS web service is the **first service with an exposed port**; if none exposes a port, the first service listed wins. Every other service becomes an ECS **sidecar** in the same task definition. Structure your file accordingly: the publicly reachable app must be the port-exposing service.

## Port mapping

The container port is taken from the **last segment of the first port entry** — `"8080:80"` and `"127.0.0.1:8001:8001"` both resolve to the right-hand value (`80` and `8001`). Only the first entry is read, and any non-numeric characters are stripped. This port overrides the configured container port during setup, and the ALB health check targets it.

## Environment and command injection

- **Environment** supports both Compose styles: `environment:` as a mapping is used as-is; as a list (`- KEY=value`) each entry is split on the first `=`.
- The web service's variables are injected directly into the ECS task definition, and its `command` overrides the container start command — but only when no `Procfile` `web:` process already set one (`Procfile` wins; see [Dockerfiles](/grada/guides/dockerfiles/)).
- Sidecars get the same treatment: their environment is injected, their `command` is preserved, a missing `image` defaults to `alpine:latest`, and each sidecar logs to the shared CloudWatch log group under an `ecs-<service>` stream prefix.

## What this means in practice

- Sidecars (Redis, Memcached, background helpers) run **in the same task** as the web container and share its lifecycle — this is co-location, not separate services.
- The mapping is ECS-shaped on other targets too: on `--target lambda` the web service's environment still injects into the function (and the port override applies), but the command override and sidecars are skipped; on `--target static` there is no container or function to inject into, so Compose services are ignored.
- Compose `build:` contexts are not used in AWS; the image is built from the generated `Dockerfile` by the [CI/CD pipeline](/grada/guides/cicd-pipeline/).
- Runtime secrets still belong in AWS Secrets Manager, not in Compose `environment:`. See [Secrets Management](/grada/guides/secrets-management/).

## See also

- [Supported Frameworks](/grada/guides/frameworks/) for detection and defaults.
- [Dockerfiles & the container contract](/grada/guides/dockerfiles/) for runtime requirements.
