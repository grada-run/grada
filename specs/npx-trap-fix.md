# Specification: The `npx` Trap Fix (Intelligent Runner Generation)

## 1. Context & Problem
In `v0.40.0`, we hardened the generated Dockerfiles using multi-stage builds that strip package managers (`npm`, `pnpm`, `yarn`, `npx`) from the final runner image to reduce the CVE surface area. To prevent runtime container crashes, we added a guardrail that blocks `npm run` and `npx` commands during `db migrate`, `add cron`, and `init --setup-ci-migrate`. 

However, this forces Node.js developers to manually pass `--cmd "node ./dist/migrate.cjs"` every time. Grada needs to automatically detect the framework and ORM, intelligently map them to their compiled `node` execution paths, and inject those safe commands into the workflow and addons.

## 2. Scope of Work
Update the framework/ORM detection engine to output compiled `node` commands instead of raw `package.json` scripts or `npx` binaries for Node.js-based projects. 

This applies to:
- `grada init --setup-ci-migrate` (GitHub Actions deploy workflow injection).
- `grada db migrate` (Interactive and headless defaults).
- `grada add cron` (Interactive command suggestion).

Non-Node ecosystems (Django/`python manage.py`, Rails/`rails db:migrate`, Go) are unaffected as they do not rely on `npm` in the runner image.

## 3. The Detection Matrix
Implement a mapping system in the auto-detection utility (e.g., `src/utils/detectors.js` or wherever migration detection lives).

### Next.js, Nuxt, Astro, or generic Node + Drizzle ORM
- **Trigger:** `package.json` contains `drizzle-kit` and/or `drizzle-orm`.
- **Generated Command:** `node ./dist/migrate.cjs`
- **UX Requirement:** If Grada auto-selects this, it MUST print a post-scaffold informational warning: 
  *`"Detected Drizzle ORM. Configured migration gate to use 'node ./dist/migrate.cjs'. Ensure your build script bundles your migrator to this path."`*

### Node + Prisma
- **Trigger:** `package.json` contains `prisma`.
- **Generated Command:** `node ./node_modules/prisma/build/index.js migrate deploy`
- **UX Requirement:** Print post-scaffold warning: 
  *`"Detected Prisma. Configured migration gate to run via 'node_modules/prisma/build/index.js'. Ensure Prisma is in your production dependencies."`*

### NestJS + TypeORM
- **Trigger:** `package.json` contains `@nestjs/core` and `typeorm`.
- **Generated Command:** `node ./dist/migration.js` (or similar standard NestJS output).

### Fallback
If the ecosystem is Node.js but no known ORM is detected, or if the user's `package.json` script cannot be safely mapped to a `node` command, fall back to the existing `v0.40.0` behavior: refuse headless runs with `NPM_CMD_STRIPPED_RUNNER` and require the user to explicitly provide a `--cmd`.

## 4. Required Code Changes
1. **Migration Detector:** Update the logic that scans `package.json` scripts. Instead of returning the first matching `npm run db:migrate` or `npx` string, run it through the new mapping matrix.
2. **CI Generator:** Update the `deploy.yml` template compiler so that `--setup-ci-migrate` accepts the mapped `node` command and writes it directly to the `aws ecs run-task` step.
3. **CLI Prompts:** Update the interactive prompts for `db migrate` and `add cron` to default to the mapped `node` command if available.

## 5. Acceptance Criteria
- `npm test` passes (all existing unit tests remain green).
- New unit tests verifying the matrix (e.g., mocking a `package.json` with `drizzle-kit` yields `node ./dist/migrate.cjs`).
- Running `init --setup-ci-migrate` on a Drizzle project headless succeeds without throwing `NPM_CMD_STRIPPED_RUNNER` and correctly writes `node ./dist/migrate.cjs` into `.github/workflows/deploy.yml`.