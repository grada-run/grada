---
title: Reference Implementations & Examples
description: Example repositories demonstrating how grada handles frameworks and architectural patterns, plus ecosystem plugins and starters.
sidebar:
  order: 3
---

These repositories demonstrate how `grada` handles various frameworks and architectural patterns. Each example includes the auto-generated Terraform, GitHub Actions, and container configurations.

## Featured migrations

* **[Heroku to AWS Migration (Django)](https://github.com/anton-codes-iac/deploy-stack-heroku-django-example):** A classic Heroku-style monolith migrated via the Procfile Importer, demonstrating a multi-container Web and Celery Worker architecture deployed from a single codebase.
* **[Vercel to AWS Migration (Next.js)](https://github.com/anton-codes-iac/deploy-stack-vercel-nextjs-example):** Demonstrates automatic translation of Vercel edge routing (`vercel.json`) to native AWS Application Load Balancer rules.
* **[Docker Compose to AWS Migration](https://github.com/anton-codes-iac/deploy-stack-docker-compose-example):** Demonstrates automatic translation of local `docker-compose.yml` sidecars (like Redis) into a multi-container AWS ECS Task Definition communicating over `localhost`.

## DevSecOps & security architectures

* **[Zero-Secret AWS Secrets Manager Injection](https://github.com/anton-codes-iac/deploy-stack-secrets-example):** A production-grade Node.js architecture demonstrating zero-plaintext secret injection. It pushes local `.env` variables directly to AWS and maps them into ECS memory at runtime, exposing a live endpoint querying GitHub's API.

## Frontend & fullstack frameworks

* **[Next.js Fullstack App](https://github.com/anton-codes-iac/deploy-stack-nextjs-example):** A complete Next.js deployment showcasing the generated Terraform, CloudFront setup, and automated OIDC workflow.
* **[Vite / React SPA](https://github.com/anton-codes-iac/deploy-stack-vite-example):** Demonstrates SPA routing and `dist/` auto-detection.
* **[Create React App](https://github.com/anton-codes-iac/deploy-stack-cra-example):** Validates backward compatibility with legacy Webpack pipelines and `build/` auto-detection.
* **[Astro Static Site](https://github.com/anton-codes-iac/deploy-stack-astro-example):** Demonstrates modern static site generation (SSG).
* **[SvelteKit Application](https://github.com/anton-codes-iac/deploy-stack-svelte-example):** Demonstrates static adapter integration and custom output folder detection.
* **[Nuxt 3 (SSR)](https://github.com/anton-codes-iac/deploy-stack-nuxt-example):** Demonstrates a fully server-side rendered Nuxt application using Nitro's optimized Node output.

## Backend APIs & monoliths

* **[Express.js API](https://github.com/anton-codes-iac/deploy-stack-express-example):** A standard Node.js backend setup.
* **[NestJS API](https://github.com/anton-codes-iac/deploy-stack-nest-example):** A robust NestJS architecture utilizing highly optimized multi-stage TypeScript builds.
* **[Python FastAPI](https://github.com/anton-codes-iac/deploy-stack-fastapi-example):** A Python API demonstrating unprivileged port mapping.
* **[Ruby on Rails](https://github.com/anton-codes-iac/deploy-stack-rails-example):** A production Rails 7+ setup featuring an auto-provisioned PostgreSQL database and secure `RAILS_MASTER_KEY` string-literal injection into the initial Secrets Manager placeholder.
* **[Django / Python](https://github.com/anton-codes-iac/deploy-stack-django-example):** A secure Gunicorn/WSGI implementation with PostgreSQL and unprivileged container adapters.
* **[Go / Fiber](https://github.com/anton-codes-iac/deploy-stack-go-example):** A compiled Go binary deployment on a minimal Alpine runner demonstrating ultra-low memory footprints and instant boot times.

---

## Ecosystem plugins & starters

In addition to standalone reference repositories, `grada` provides native integrations that hook directly into framework build pipelines and community template engines:

* **[astro-grada](https://www.npmjs.com/package/astro-grada):** Push-button deployment plugin for Astro sites.
* **[nuxt-grada](https://www.npmjs.com/package/nuxt-grada):** Nitro-optimized deployment integration for Nuxt 3 applications.
* **[vite-plugin-grada](https://www.npmjs.com/package/vite-plugin-grada):** Zero-config Vite build plugin for single-page applications.
* **[svelte-adapter-grada](https://www.npmjs.com/package/svelte-adapter-grada):** Native SvelteKit adapter producing optimized Fargate container builds.
* **[nest-grada](https://www.npmjs.com/package/nest-grada):** Native Angular DevKit schematic for NestJS, installable via `nest add`.
* **[cookiecutter-django-grada](https://github.com/anton-codes-iac/cookiecutter-django-grada):** Community Django starter listed on Django Packages.
* **[cookiecutter-fastapi-grada](https://github.com/anton-codes-iac/cookiecutter-fastapi-grada):** Instant scaffolding for modern, async FastAPI deployments.
