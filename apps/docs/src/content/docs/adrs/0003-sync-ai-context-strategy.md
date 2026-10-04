---
title: "AI Context Synchronization Strategy"
description: "Sync IaC context into AI coding assistants with sync-ai."
---

* **Status:** Accepted
* **Date:** 2026-09-02 (Retroactive)

## Context and Problem Statement

Modern engineering teams heavily utilize AI coding assistants (Cursor, GitHub Copilot, Windsurf, Claude Code, etc.) in their local IDEs. However, when dealing with Infrastructure-as-Code (IaC), AI models frequently hallucinate invalid Terraform syntax, recommend destructive manual AWS CLI commands, or ignore critical project-specific constraints like unprivileged container ports and OIDC auth flows.

Furthermore, automatically writing instruction files into user repositories carries a high risk of clobbering a team's existing, carefully crafted agent prompts.

## Decision Drivers

* **Hallucination Mitigation:** Provide structured, deterministic instructions to IDE AI assistants to ensure they generate valid Terraform and safe workflows.
* **Non-Destructive Integration:** Guarantee that existing `.cursorrules`, `CLAUDE.md`, or shared workspace instruction files are never accidentally overwritten or destroyed.
* **Multi-Tool Support:** Support the highly fragmented landscape of AI coding tools without forcing users into a specific IDE.

## Considered Options

1. **Single Global Instruction File:** Only support `.cursorrules` (rejected as too narrow for modern multi-tool teams).
2. **Blind Overwrite of Agent Files:** Replace existing AI rule files with `grada` defaults (rejected due to the unacceptable risk of destroying user configuration).
3. **Isolated Rule Files + Delimited Block Injection (`sync-ai`):** Create dedicated files where supported (e.g., `grada.mdc`), and safely inject delimited, managed markdown blocks into existing shared instruction files where necessary.

## Decision Outcome

**Chosen Option:** Build a dedicated `npx grada-run sync-ai` command and a non-destructive auto-injection engine.

### Supported Targets
The engine intelligently maps instructions to the following environments:
* **Cursor:** `.cursor/rules/grada.mdc`
* **Roo Code / Roo-Cline:** `.roo/rules/grada.md`
* **Trae:** `.trae/rules/project_rules.md` (managed block injection)
* **Continue:** `.prompts/grada.prompt`
* **Windsurf:** `.windsurfrules` (managed block injection)
* **GitHub Copilot:** `.github/copilot-instructions.md` (managed block injection)
* **Claude Code:** `CLAUDE.md` (managed block injection)
* **Goose:** `.goosehints`
* **Aider:** `.aider.conf.yml` (managed block injection, `#` comments)

### Positive Consequences
* Dramatically reduces AI-induced infrastructure errors and dangerous AWS CLI recommendations.
* Safe, idempotent execution allows teams to run `npx grada-run sync-ai` whenever their architecture parameters (like AWS region or ports) change, without fear of losing their own prompts.

### Negative Consequences
* Requires ongoing maintenance of parser logic and block delimiters as AI coding assistant vendors rapidly change their configuration file specifications.