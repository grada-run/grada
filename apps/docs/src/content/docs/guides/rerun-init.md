---
title: Re-running Init Safely
description: What happens when setup finds existing files — backups, regeneration, and how to recover.
sidebar:
  order: 10
---

Re-running `npx grada-run` to change region, size, or framework is safe and predictable: setup never merges with your existing generated files. It backs them up, regenerates from scratch, and tells you exactly what moved.

## The conflict prompt

When setup finds any of `terraform/`, `Dockerfile`, or `.github/workflows/deploy.yml` in the target directory (`src/utils/backup.js`), it lists the conflicts and offers two choices:

- **Backup & Regenerate** — each conflicting path is renamed with a timestamp suffix (e.g. `terraform.bak.1726771200000`), then fresh files are generated.
- **Cancel** — exits immediately with no changes.

In `--headless` mode there is no prompt: existing files are backed up automatically. Either way, nothing is ever merged or partially overwritten.

## Backups stay local

After backing up, setup appends a `# grada backups` block (`*.bak.*`) to `.gitignore` (creating the file if needed), so backup clutter never reaches GitHub. To recover a previous configuration, compare with `diff -r terraform.bak.<timestamp> terraform/` and copy back what you need — then delete the `.bak.*` directory when you are satisfied. (`npx grada-run eject` removes all `*.bak.*` files as part of decoupling.)

## What regeneration touches

`src/utils/generator.js` writes a fixed file set and handles pre-existing files explicitly:

- `terraform/*.tf`, `Dockerfile`, `.github/workflows/deploy.yml`, plus `preview.yml`/`teardown.yml` only when PR previews are enabled. Switching `--target` on a re-run regenerates a different set (e.g. static drops the `Dockerfile`); `preview.yml`/`teardown.yml` are never in the conflict set, so delete them by hand when moving to a target without previews.
- `terraform/secret_keys.json` is preserved when it already exists (only created as `[]` on first setup) — but on Backup & Regenerate, `terraform/` moves to `terraform.bak.<timestamp>` wholesale, so the fresh tree starts with `[]`. Restore your key map from the `.bak` copy (or re-push) before the next deploy.
- If your repo already has a `README.md`, it is kept and gets a short Deployment pointer appended; the generated guide goes to `DEPLOYMENT.md` instead (`GRADA.md` when both files are yours — see [`npx grada-run`](/grada/cli/init/)).
- Existing `.gitignore` / `.dockerignore` files are preserved with only the grada entries appended (Terraform state paths, `.env`); missing ones are created with framework-appropriate presets.
- **Rails only:** if `ci.yml` or `dependabot.yml` exist, setup asks whether to disable them by renaming to `.bak` (default CI usually crashes without a database service); in headless mode they are disabled automatically.

## Suggested workflow

1. Commit your work before re-running, so `git status` shows exactly what regeneration changed.
2. Re-run, review the diff (`git diff`, plus `diff -r` against the `.bak` copies for untracked files like `terraform/` internals).
3. Run `npx grada-run apply` to converge AWS with the new configuration.
4. Delete the `.bak.<timestamp>` copies once the new infrastructure is verified.

## See also

- [apply](/grada/cli/apply/) for converging AWS after regeneration.
- [eject](/grada/cli/eject/) for what happens to backups on decoupling.
