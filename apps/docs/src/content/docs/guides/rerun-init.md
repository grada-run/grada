---
title: Re-running Init Safely
description: What happens when setup finds existing files — backups, regeneration, and how to recover.
sidebar:
  order: 10
---

Re-running `npx grada-run` to change region, size, or framework is safe and predictable: setup never merges with your existing generated files. It backs them up, regenerates from scratch, and tells you exactly what moved.

## The generation manifest

Every run records content hashes of what it generated in `.grada/manifest.json` (gitignored), so a re-run can tell pristine output from your hand edits (or addon wiring added later via `grada add`).

## The conflict prompt

When setup finds any of `terraform/`, `Dockerfile`, or `.github/workflows/deploy.yml` in the target directory, it lists the conflicts and offers two choices:

- **Backup & Regenerate** — each conflicting path is renamed with a timestamp suffix (e.g. `terraform.bak.1726771200000`), then fresh files are generated.
- **Cancel** — exits immediately with no changes.

When files differ from the manifest, the prompt names them (`Modified since generation: terraform/main.tf, Dockerfile`), so you know exactly what is at stake before you answer.

In `--headless` mode there is no prompt: unmodified trees regenerate silently (idempotent), but modified trees fail with `MODIFIED_TREE` instead of clobbering your edits — re-run with `--force` to back up and regenerate. Either way, nothing is ever merged or partially overwritten. Projects created before manifests existed keep the historical auto-backup behavior.

## Ejected projects

Re-running setup on an [ejected](/grada/cli/eject/) project would re-apply managed metadata to your vanilla Terraform, so it needs an explicit opt-in: interactive runs confirm first, headless runs fail with `EJECTED_PROJECT` unless `--force` is passed.

## Backups stay local

After backing up, setup appends a `# grada backups` block (`*.bak.*`) to `.gitignore` (creating the file if needed), so backup clutter never reaches GitHub. To recover a previous configuration, compare with `diff -r terraform.bak.<timestamp> terraform/` and copy back what you need — then delete the `.bak.*` directory when you are satisfied. (`npx grada-run eject` removes all `*.bak.*` files as part of decoupling.)

## What regeneration touches

Setup writes a fixed file set and handles pre-existing files explicitly:

- `terraform/*.tf`, `Dockerfile`, `.github/workflows/deploy.yml`, plus `preview.yml`/`teardown.yml` only when PR previews are enabled. Switching `--target` on a re-run regenerates a different set (e.g. static drops the `Dockerfile`); `preview.yml`/`teardown.yml` are never in the conflict set, so delete them by hand when moving to a target without previews.
- `terraform/secret_keys.json` is preserved when it already exists (only created as `[]` on first setup) — on Backup & Regenerate its contents are automatically restored over the fresh tree, so your key map survives even though `terraform/` moves to `terraform.bak.<timestamp>` wholesale.
- If your repo already has a `README.md`, it is kept and gets a short Deployment pointer appended; the generated guide goes to `DEPLOYMENT.md` instead (`GRADA.md` when both files are yours — see [`npx grada-run`](/grada/cli/init/)).
- Existing `.gitignore` / `.dockerignore` files are preserved with only the grada entries appended (Terraform state paths, `.env`); missing ones are created with framework-appropriate presets.
- **Rails only:** if `ci.yml` or `dependabot.yml` exist, setup asks whether to disable them by renaming to `.bak` (default CI usually crashes without a database service); in headless mode they are disabled automatically.

## The resource suffix survives re-runs

The random resource suffix (`grada_resource_suffix`, e.g. `-a1b2c3`) minted on first setup is parsed out of the existing tree and reused on every re-run — target pivots and flag changes never re-mint it, since a new suffix would rename live singletons like the RDS identifier. Treat the local as immutable: editing it by hand replaces those resources. Trees scaffolded before suffixes keep rendering unsuffixed names (zero drift).

## The project name survives re-runs

The project name is read back out of the existing tree (`app_name` in `terraform/main.tf`) and reused, so renaming or copying the directory and re-running setup keeps rendering the same resource names. When the directory basename disagrees with the tree, setup warns loudly and keeps the tree's name — re-deriving from the directory would silently provision a parallel stack on the next apply while the old one keeps billing. Pass `--project-name <name>` to rename explicitly (setup warns that the next apply forks a new stack); cloning a tree as the starting point for a genuinely new project needs the same flag.

## Suggested workflow

1. Commit your work before re-running, so `git status` shows exactly what regeneration changed.
2. Re-run, review the diff (`git diff`, plus `diff -r` against the `.bak` copies for untracked files like `terraform/` internals).
3. Run `npx grada-run apply` to converge AWS with the new configuration.
4. Delete the `.bak.<timestamp>` copies once the new infrastructure is verified.

## See also

- [apply](/grada/cli/apply/) for converging AWS after regeneration.
- [eject](/grada/cli/eject/) for what happens to backups on decoupling.
