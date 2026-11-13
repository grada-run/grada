# Preview Task-Role Confinement

## 1. Problem

Preview credentials retain `ecs:RunTask`, `ecs:RegisterTaskDefinition`,
`ecs:ExecuteCommand`, and `iam:PassRole` with no prod scoping, and the
0.49.2 permissions boundary caps *created roles*, not the preview role's
own calls. A same-repo PR can therefore register a task definition
naming the prod task role and `RunTask` it with `PassRole` — all
allowed — then read prod secrets and the database over the VPC; with
exec enabled on both services, it can equally open an interactive shell
in a prod task. Read-only, insider-only, no destruction.

Extension found during spec research (same root cause, strictly worse):
nothing denies `AttachRolePolicy` / `PutRolePolicy` / `DetachRolePolicy` /
`DeleteRolePolicy` on the *prod task and execution roles* either
(`DenyCIRoleMutation` covers the CI roles only). PR-controlled preview
Terraform can attach `AdministratorAccess` to the prod task role and run
with it — full admin, not just read-only. Worse, it can re-trust the
prod task role (`UpdateAssumeRolePolicy`) and assume it directly,
bypassing every execution deny; the scheduler role is equally
unprotected. This spec closes all three paths.

## 2. Design (and rejected alternative)

Close by *target*, not by caller: deny the execution APIs on exact prod
ARNs while `pr-*` stays allowed. The preview migration gate and preview
Terraform touch only `pr-*` resources, so they keep working under the
same credentials.

Rejected: the dedicated migration-executor role + isolated job. It adds
a role, a job, and a credential-handoff protocol to solve a problem that
ARN scoping already solves — the choke point (`PassRole` at `RunTask`
time plus role-policy writes) is deny-able on exact ARNs, and the
migrate gate never names a prod ARN. Revisit only if implementation-time
verification (section 5) shows a load-bearing action lacks resource-level
support.

New `preview_guardrails` statements (prod-scoped; `pr-*` untouched):

- `DenyProdTaskExecution`: `ecs:RunTask`, `ecs:StopTask`,
  `ecs:ExecuteCommand`, `ecs:CreateService` on the prod cluster, prod
  services, prod task families (with `:*` revision suffix), and
  `task/<prod-cluster>/*`. `CreateService` is free: preview clusters
  are workspace-suffixed, so preview Terraform never creates services
  in the prod cluster (the `PassRole` choke already contains the
  damage, but persistence deserves its own deny). The `Describe*`
  family is deliberately
  absent: `plan.yml` refreshes default state with preview credentials
  (no workspace select), so describing prod is legitimate traffic —
  recon (task-def contents, image URIs, subnets) stays readable as an
  explicit residual.
- `DenyProdTaskDefinitionRegistration`: `ecs:RegisterTaskDefinition`,
  `ecs:DeregisterTaskDefinition` on the prod families
  (`<prod-prefix>-task`, `<prod-prefix>-worker-task`).
  `RegisterTaskDefinition` is very likely resource-`*-only`, which
  would void that half of the statement — acceptable, because the
  cluster-scoped `RunTask` deny is the real choke (an attacker cannot
  run what they register); bare-family ARNs are likewise moot via the
  cluster match.
- `DenyProdPassRole`: `iam:PassRole` on the prod task + execution role
  ARNs as *string-built* ARNs (not HCL refs: static trees define no
  IAM roles, so refs dangle and `validate` fails — ECS and Lambda use
  identical physical role names, so one pattern covers both and matches
  nothing on static).
- `DenyProdAppRoleMutation`: `iam:AttachRolePolicy`,
  `iam:DetachRolePolicy`, `iam:PutRolePolicy`, `iam:DeleteRolePolicy`,
  `iam:UpdateAssumeRolePolicy`, `iam:DeleteRole` on the string-built
  task, execution, *and scheduler* role ARNs (closes the extension
  paths, including the assume-it-directly bypass). `iam:UpdateRole`
  and tagging stay allowed (cosmetic — description, session duration
  within AWS bounds, tags).

Mirror all four into the boundary policy (`BoundaryDenyTaskExecution`,
etc.): backdoor creds must face the same prod wall, while `pr-*`
execution stays allowed for the sandbox. Preview Terraform's `pr-*`
refresh/apply/register/pass calls match no deny on either side.

Resource-support grounding: `RunTask` and `PassRole` scoping is proven
by Grada's own live cron triggers (the shipped scheduler policy scopes
both the same way); `RegisterTaskDefinition` scoping is *not* proven
and rides the RunTask-choke fallback above. No interaction with the
boundary PassRole carve-out (it governs capped roles; these denies
govern preview credentials) — ship in either order.

## 3. Exact statements

Guardrail additions (append inside `preview_guardrails`; boundary twins
identical except SIDs — see section 4 for the shared-source refactor):

```hcl
{
  Sid    = "DenyProdTaskExecution"
  Effect = "Deny"
  Action = ["ecs:RunTask", "ecs:StopTask", "ecs:ExecuteCommand", "ecs:CreateService"]
  Resource = [
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:cluster/${local.prod_prefix}-cluster",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/${local.prod_prefix}-service",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:service/${local.prod_prefix}-cluster/${local.prod_prefix}-worker-service",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task/${local.prod_prefix}-cluster/*",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${local.prod_prefix}-task:*",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${local.prod_prefix}-worker-task:*",
  ]
},
{
  Sid    = "DenyProdTaskDefinitionRegistration"
  Effect = "Deny"
  Action = ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition"]
  Resource = [
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${local.prod_prefix}-task:*",
    "arn:aws:ecs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:task-definition/${local.prod_prefix}-worker-task:*",
  ]
},
{
  Sid    = "DenyProdPassRole"
  Effect = "Deny"
  Action = ["iam:PassRole"]
  Resource = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.prod_prefix}-task-role",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.prod_prefix}-execution-role",
  ]
},
{
  Sid    = "DenyProdAppRoleMutation"
  Effect = "Deny"
  Action = ["iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:DeleteRole"]
  Resource = [
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.prod_prefix}-task-role",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.prod_prefix}-execution-role",
    "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${local.prod_prefix}-cron-scheduler-role",
  ]
},
```

Notes:

- String-built role ARNs (not HCL refs): static trees define no IAM
  roles, so refs would dangle and fail `validate`. ECS and Lambda use
  identical physical role names, so one pattern covers both and matches
  nothing on static (same accepted pattern as the ECS/Lambda data
  denies).
- `RunTask` / `PassRole` scoping is proven by live cron triggers (the
  shipped scheduler policy scopes both the same way and triggers
  fire); `RegisterTaskDefinition` scoping is unproven and rides the
  RunTask-choke fallback per section 2.

## 4. Refactoring (in scope)

This spec adds four more twin pairs to a hand-mirrored set the review
already flags as drift-prone. To stop the next 214-class omission at
the source, implement alongside the statements:

1. **Shared ARN locals (HCL-native, no pipeline change).** Lift each
   twin pair's resource list into a `locals` list (e.g.
   `guardrail_ecs_resources`) referenced by both the `DenyProd*` and
   `BoundaryDeny*` twins — one list, two consumers. Apply to the four
   new pairs; migrate the existing thirteen identical pairs in the
   same edit (mechanical, `terraform validate` proves it).
2. **Twin-parity test.** Extend the template contract tests: for every
   twinable Sid in `preview_guardrails`, assert a `BoundaryDeny*`
   twin exists with identical Action/Resource. Exact enumeration:
   13 identical twins (`DenyComputeAbuse`, `DenySnapshotSharing`,
   plus the 11 `DenyProd*` data statements) + 1 asymmetric pair
   (`DenyIAMBackdoors` ↔ deliberately stronger `BoundaryDenyIAM`) +
   4 no-twin by design (`DenyCIRoleMutation`,
   `DenyRoleWithoutBoundary`, `DenyBoundarySwap`,
   `DenyBoundaryMutation`) — pin that 5-entry allowlist (4 + 1
   asymmetric) explicitly, plus the 4 new twins from this spec. This
   fails the build on the next one-sided edit.
3. **Test slice helper.** The template tests slice policies by marker
   string in several places; extract one `slicePolicy(tf, marker)`
   helper in `ci-hardening.test.js`.

Explicitly out of scope: generating `oidc.tf` from JS (over-engineering
against the static-template pipeline).

## 5. Validation and acceptance

- Template contract tests (red-first): the four new Sids with exact
  actions/resources on both sides; the parity test from section 4;
  assertions that no new Resource pattern matches `pr-*`.
- `terraform fmt -check`, full unit suite, Tier 0, `validate` + `tflint`
  on ECS/full/static/Lambda renders.
- **Implementation-time verification (blocking):** confirm the
  remaining gated actions support resource-level permissions (the
  Service Authorization Reference is JS-rendered and unverifiable from
  here). `RunTask` / `PassRole` are live-proven; `StopTask` and
  `DeregisterTaskDefinition` must be confirmed — if either lacks
  support, drop just that action with a residual note (DoS-only, not
  data access) rather than broadening scope. `RegisterTaskDefinition`
  is presumed `*-only` and already covered by the RunTask-choke
  fallback. A `plan.yml` refresh staying green is an explicit
  acceptance gate (it legitimately describes prod).
- Live proof runbook (manual, post-apply with preview credentials):
  `RunTask` / `ExecuteCommand` / `PassRole` /
  `RegisterTaskDefinition` / `AttachRolePolicy` against prod ARNs →
  denied; the same calls against `pr-*` → allowed; a preview apply +
  migration gate run stays green.
- Docs: pipeline-guide paragraph + ADR-0006 amendment + release notes
  (public-notes rule: no bug numbers, no severities).

## 6. Non-goals and residuals

- Read residuals, split explicitly: (a) task-mediated reads are
  closed (no prod execution surface remains); (b) direct reads stay
  open — `GetSecretValue` on the prod vault, S3 object reads, and
  log-tail reads are all still allowed, as is `Describe*` recon
  (task-def contents, image URIs, subnets). Accepted (read-only,
  insider-only, as filed). Likely-safe follow-up (not this spec):
  deny `GetSecretValue` on the prod vault — preview Terraform needs
  ARNs, not values. When that follow-up lands, assert the vault-push
  flow reads values with non-preview credentials (push runs outside
  preview jobs, but prove it in that spec).
- Full preview least-privilege redesign.
- The companion snapshot fixes ship alongside per the combined-scope decision but are
  separate fixes, not part of this spec.
