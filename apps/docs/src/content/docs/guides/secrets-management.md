---
title: "Secrets Management in grada"
description: "Sync .env files to AWS Secrets Manager without committing plaintext secrets."
sidebar:
  order: 7
---

Managing `.env` files across a team and syncing them to the cloud is a notorious pain point. `grada` solves this by natively integrating with **AWS Secrets Manager**, ensuring zero plaintext secrets ever touch your GitHub repository or CI/CD pipelines. Secrets Manager bills $0.40 per secret per month (one for your app secrets, plus one for the database master password when applicable) — itemized in the `apply` cost preview. Static targets (`--target static`) provision no vault — there is no compute to inject secrets into, so the `secrets` commands point back to `apply`.

## The Secrets Lifecycle

To maintain zero-secret Git repositories and safe infrastructure provisioning, secrets follow a strict 4-step lifecycle:

```text
1. Scaffold        ───▶  2. Provision Vault   ───▶  3. Push Secrets     ───▶  4. Deploy to App
(grada)           (grada apply)       (secrets push .env)       (git push)
Generates Terraform       Creates empty vault        Uploads encrypted keys    ECS container boots
& secret_keys.json        in AWS Secrets Mgr         & updates secret_keys     with injected env
```

---

### Step 1: Provision the Vault (Day 1)
Your Secrets Manager vault is declared in `terraform/secrets.tf`. Provision the base infrastructure first:

```bash
npx grada-run apply
```
*This creates an empty, secure secret vault named `<project-name>-secrets` in your AWS account.*

### Step 2: Push Secrets to AWS
Once the vault exists, push your local `.env` values directly to AWS:

```bash
npx grada-run secrets push .env
```

**What happens under the hood?**
1. The CLI reads your local `.env` file.
2. It encrypts the key-value pairs and pushes them securely into AWS Secrets Manager under your project's namespace (e.g., `my-project-secrets`).
3. It generates a local `terraform/secret_keys.json` file containing *only the names* of your keys (e.g., `["API_KEY", "STRIPE_SECRET"]`), **not the values**. Re-running setup never wipes this file.

> 💡 **Tip:** The `secrets push` command takes the file path as the first argument. If you need to use other flags, ensure they are appended at the end of the command:
> `npx grada-run secrets push .env --any-other-flags`

> 🌱 **No `.env` yet?** `secrets push` offers to create an empty one for you interactively. In CI / `--headless` mode it exits 1 instead of prompting, so generate the file before pushing.

### Step 3: Map Secrets into the Container
Commit the updated `terraform/secret_keys.json` and push to GitHub:

```bash
git add terraform/secret_keys.json
git commit -m "chore: map new secrets to ECS"
git push origin main
```

Terraform reads `secret_keys.json` during the GitHub Actions deployment and maps each key directly into your ECS Task Definition. When your Fargate container boots up, AWS injects the secret values into `process.env` (Node) or `os.environ` (Python) in memory. On `--target lambda` projects the vault stays shared for runtime reads (`APP_SECRETS_ARN`) and fresh invocations pick up new values automatically — no restart step exists.

> ⚠️ **Commit this file.** `secret_keys.json` holds key *names* only — never values — so it is safe for version control, and deployment depends on it.

---

### Day-2: Pull, Audit, and Rotate (no redeploy)

Secrets don't stand still — teammates join, keys rotate, local `.env` files get lost. Two commands close the loop:

```bash
npx grada-run secrets pull    # merge remote values into local .env
npx grada-run secrets audit   # diff local .env vs AWS, change nothing
```

`pull` appends missing remote keys after your existing entries, keeps local-only variables, and asks before overwriting conflicting values (automatic in `--headless` mode). `audit` prints a colored drift report: `+` missing locally, `~` mismatched values, `-` never pushed to AWS.

**Which flow do I need?**

| Situation | Command |
|---|---|
| New variable name added/removed | `secrets push`, then commit `secret_keys.json` + `git push` (task definition must be rebuilt) |
| Only a value changed (same keys) | `secrets push`, then accept the rolling ECS restart prompt — live in seconds, no redeploy |
| New machine / lost `.env` | `secrets pull` |
| "Why doesn't my app see the new value?" | `secrets audit` first, then push or restart accordingly |

See the [secrets CLI reference](/grada/cli/secrets/) for flags, merge rules, and prerequisites.