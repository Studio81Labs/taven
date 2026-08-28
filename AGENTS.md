# Repository Agent Instructions

These instructions are for agents working in the Taven repository. Use them together
with the product material in `docs/product/`, technical decisions in
`docs/decisions/`, contributor documentation, and repository-local process
documentation.

The documents under `docs/product/` are business and product source material.
They define product intent and constraints, but they are not agent instructions.
Repository tasks come from the user, GitHub issue or PR context, and this file.

## Working style

* Act as an autonomous senior engineer.
* Work within the requested scope and preserve unrelated user changes.
* Do not ask follow-up questions unless genuinely blocked by missing credentials,
  missing repository access, or conflicting requirements that cannot be resolved
  from repository context.
* Make reasonable, conservative assumptions when ambiguity does not materially
  affect product behavior, architecture, security, or data integrity.
* Call out important assumptions in the final handoff.
* Complete work end-to-end: analysis, implementation, validation, final diff
  review, and PR or issue updates that available tooling supports.
* Prefer the smallest complete change over speculative generalization.
* Do not leave obvious follow-up work required for correctness to another agent
  merely to reduce the current diff.

## Scope discipline

* Solve the requested issue fully, but do not perform unrelated refactors.
* Preserve existing architecture and conventions unless the task explicitly
  requires changing them.
* Prefer minimal, safe changes with clear reasoning.
* Keep issues and PRs focused on a single deliverable.
* Do not implement speculative maker, AI, routing, node-agent, mobile, or
  deployment surfaces.
* Do not introduce abstractions solely for hypothetical future requirements.
* Do not turn a localized task into a repository-wide cleanup.
* Pre-existing technical debt outside the requested change is not part of the
  task unless it prevents the requested change from being implemented safely.

## Sub-agent delegation

Delegation exists to reduce cost, latency, and context consumption while
preserving answer quality. Do not delegate work merely because delegation is
available.

A sub-agent earns its cost when it can inspect substantially more material than
it reports back: for example, searching dozens of files for a contract pattern,
tracing a flow across packages, or reducing a long CI log to a small set of
actionable failures.

When writing the delegation brief would take as much effort as doing the work,
do the work directly.

Never repeat a broad search yourself after delegating the same search. Verify
specific findings before acting on them, but do not pay twice for discovery.

### Delegation tiers

The tier describes the reasoning shape of the task. The model and reasoning
effort are selected from the harness's currently available models when the
sub-agent is spawned.

| Tier                      | Use for                                                                                                                                                                                                               | Model class                                                                               | Reasoning effort |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| **T1 — mechanical**       | Exact searches, symbol lookup, call-site enumeration, file classification, log reduction, checking whether a known pattern exists, collecting `path:line` evidence                                                    | cheapest capable coding model                                                             | low              |
| **T2 — exploratory**      | Tracing unfamiliar flows, investigating a failure across several files, comparing implementations, first-pass audits, dependency or contract discovery where judgment is required but the parent retains the decision | balanced coding/reasoning model                                                           | medium           |
| **T3 — complex analysis** | Bounded difficult investigation where substantial reasoning is required but the result remains evidence or options rather than the final engineering decision                                                         | strongest appropriate coding/reasoning model available below or equal to the parent model | high             |
| **T4 — decision/write**   | Architecture decisions, final review judgments, implementation, edits, commits, PR writes, release work, or final validation claims                                                                                   | **do not delegate**                                                                       | parent session   |

### Model and effort selection

For every delegated task, explicitly choose both:

1. the model appropriate for the delegation tier; and
2. the reasoning effort appropriate for that tier.

Do not select a model without also selecting its reasoning effort when the
harness supports both controls.

The intended mapping is:

* **T1:** cheapest capable coding model + **low** effort
* **T2:** balanced coding/reasoning model + **medium** effort
* **T3:** strongest appropriate model + **high** effort
* **T4:** parent agent; never delegated

Model names change over time. Before spawning a sub-agent, inspect the current
harness/tool schema and model allowlist and resolve the tier to a concrete model
that is actually available.

Do not copy stale model identifiers from documentation, previous sessions, or
repository history.

If the harness exposes named model families with materially different cost or
capability, choose the least expensive model that reliably satisfies the tier.
Do not use the parent/frontier model for T1 or T2 work merely because it is
available.

If the harness does not expose model selection for sub-agents, delegation is
allowed only when the context reduction or parallelism still provides a clear
benefit. Report in the handoff that the model tier could not be explicitly
controlled.

If the harness exposes reasoning effort but not model selection, set the effort
according to the tier.

If the harness exposes model selection but not reasoning effort, select the
tier-appropriate model and do not claim that an effort level was configured.

Never invent unsupported spawn parameters. Read the current tool schema before
dispatch.

### Delegation context

Context size is often a larger cost lever than model selection.

* Spawn sub-agents with clean context whenever the harness supports it.
* Provide only the information necessary for the delegated investigation.
* Name exact paths, symbols, commands, or contracts when known.
* Do not forward the entire parent transcript unless the task genuinely depends
  on it.
* State exactly what question the sub-agent must answer.
* Bound the output.

Prefer briefs such as:

`Inspect apps/backend/src/modules/orders and packages/core for every caller of
calculatePrice(). Return at most 10 path:line findings and one sentence per
finding. Do not propose or make changes.`

over broad briefs such as:

`Review pricing.`

### Delegation output

Sub-agents investigate; the parent decides.

For discovery and audit tasks, request compact output:

* `path:line`
* one-sentence finding
* evidence or reason
* optional confidence when uncertainty is material

Do not ask sub-agents to return entire files or large copied code blocks.

A sub-agent finding is evidence, not an instruction. Verify consequential
findings against the repository before changing code.

### Parallel delegation

Dispatch independent investigations concurrently when doing so reduces latency.

Do not parallelize tasks that depend on each other's conclusions or that could
produce conflicting edits.

A single parent agent remains responsible for integrating all results and
maintaining a coherent view of the change.

### Never delegate

Do not delegate:

* file edits or any other repository write
* commits, pushes, merges, tags, or branch manipulation
* GitHub writes, review replies, issue updates, or PR updates
* architecture or product decisions
* final interpretation of acceptance criteria
* final review severity or merge-readiness decisions
* release work
* migration authoring
* final contract changes
* final security-sensitive implementation decisions
* any claim that tests, builds, lint, typecheck, migrations, generated checks,
  or other validation passed

A sub-agent may investigate these areas and return evidence or options, but the
parent agent owns the decision and any resulting write.

### Keeping delegated work reliable

* An empty T1 result is not proof that nothing exists. When absence matters,
  repeat the investigation at T2 or verify it directly with a deterministic
  repository search.
* Verify findings before acting on them.
* Re-run decisive validation commands in the parent session.
* Report materially relevant delegation in the final handoff, especially when
  a delegated sweep returned incomplete or empty results.
* Do not describe a delegation as tiered when the harness did not actually
  expose control over its model or effort.

## Architecture boundaries

### `apps/backend`

NestJS API and infrastructure adapters.

Prisma, Redis, object storage, payment-provider integrations, carrier
integrations, and other infrastructure-specific implementations stay here.

Do not leak NestJS or infrastructure dependencies into pure domain packages.

### `apps/web`

Nuxt/Vue public site and customer journey.

Customer-facing ordering, upload, pricing, checkout, and order-status behavior
belongs here when implemented as web UI.

### `apps/admin`

Vue/Vite internal operator application.

Maker-oriented functions remain here until observed product demand justifies
extracting a separate surface.

Do not create a separate maker application speculatively.

### `apps/slicer-worker`

Independently built BullMQ consumer and OrcaSlicer integration seam.

It is not part of the default development command.

Keep long-running slicing work outside request/response backend execution.

### `packages/core`

Pure TypeScript domain logic only.

Do not import NestJS, Vue, Prisma, Redis, storage implementations, generated API
clients, or application-layer framework code.

Business rules that can remain infrastructure-independent should live here.

### `packages/openapi-client`

Generated HTTP types plus the thin client factory.

Never hand-edit files under `generated/`.

When the API contract changes, regenerate the client using the repository
command and commit the generated result when the repository tracks it.

### `packages/slicer-contracts`

Versioned Zod message contracts shared across slicer producers and consumers.

Do not import worker or backend implementation details.

Contract evolution must account for independently running producers and
consumers.

### `packages/ui-web`

Contains only assets or components with at least two real consumers.

Do not move components here merely because they might be reused later.

## Codebase conventions

* Follow existing naming, file structure, typing, validation, error-handling,
  and dependency-injection patterns.
* Reuse existing domain logic, helpers, contracts, and abstractions before
  introducing new ones.
* Keep framework and infrastructure concerns out of `packages/core`.
* Keep generated code generated; never patch generated OpenAPI output manually.
* Prefer explicit failures over broad `try/catch`, silent fallback behavior, or
  swallowed errors.
* Preserve package boundaries and dependency direction.
* Keep API producers, generated contracts, and consumers aligned when HTTP
  contracts change.
* Keep slicer message producers and consumers aligned when slicer contracts
  change.
* Schema changes require the appropriate Prisma migration and all necessary
  contract or application updates in the same change.
* Do not introduce credentials, real `.env` files, access tokens, private keys,
  or other secrets into the repository.
* Preserve existing user changes that are unrelated to the task.

## Product boundaries

Taven is currently a local 3D-printing service, not a distributed maker
marketplace.

Do not infer future architecture from ideas present in product documents.

Unless explicitly requested by the task, do not implement:

* distributed maker-network orchestration
* maker routing or automatic job allocation
* maker node agents
* AI-based job acceptance or veto systems
* native mobile applications
* speculative deployment infrastructure
* abstractions whose only consumer is a hypothetical future service

Product documents may describe future possibilities. Treat them as context, not
authorization to implement them.

## Commands

Use the root commands where applicable:

```bash
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm format:check
```

For a fresh checkout:

```bash
pnpm bootstrap
```

Manage local infrastructure with:

```bash
pnpm infra:up
pnpm infra:down
```

After API contract changes:

```bash
pnpm openapi:generate
pnpm generated:check
```

After workflow changes:

```bash
pnpm ci:config:check
```

After supply-chain override changes:

```bash
pnpm overrides:check
```

Do not mechanically run expensive unrelated commands when a narrower validation
provides equivalent evidence during development. Before handoff, however, run
the repository-level checks that meaningfully cover the changed surfaces.

## Validation

Before considering work complete:

* run relevant unit, integration, or e2e tests for the touched behavior
* run lint and typecheck for the affected workspace or repository as appropriate
* run builds that meaningfully exercise changed application or package
  boundaries
* run `pnpm format:check` when formatting may have changed
* run generated-code checks after contract changes
* run configuration checks after CI or supply-chain changes
* inspect the final diff for regressions, dead code, debug leftovers, accidental
  formatting churn, generated-file mistakes, and unrelated changes
* verify the issue acceptance criteria and definition of done
* verify architecture and package boundaries remain intact
* verify error, null, failure, and boundary behavior when materially affected
* state clearly what was not validated and why

A passing test suite does not replace inspection of the final diff.

Do not claim a check passed unless the parent agent executed it and observed the
result.

## Git workflow

* GitHub Issues are the source of truth for active work when an issue exists.

* Start from an issue with clear acceptance criteria whenever possible.

* Branch from `main`.

* Codex-created branches use the `codex/` prefix.

* Use conventional commits in the form:

  `<type>(<scope>): <lower-case subject>`

* Scope is required and must be one defined by `commitlint.config.js`.

* Do not invent new commit scopes when an existing scope accurately represents
  the change.

* Keep commits and PRs focused on the requested deliverable.

* Never commit real `.env` files, credentials, tokens, or secrets.

## Product and technical decisions

* Product and business decisions belong in the product decision log.
* Technical decisions already fixed by product material must remain consistent
  with it.
* Significant technical choices not fixed by product decisions belong in an ADR
  under `docs/decisions/`.
* Do not create an ADR for routine implementation details.
* Do not silently change an existing architectural decision as part of an
  unrelated task.

## Pull request rules

When creating or updating a PR:

* use a concise conventional title aligned with the issue and commit conventions
* link the relevant issue
* include a short summary of what changed
* describe important implementation choices
* identify meaningful regression or operational risks
* include concrete test and validation evidence
* explicitly call out API contract, database schema, migration, slicer contract,
  infrastructure, or documentation impact
* keep the PR aligned with the linked issue's scope
* update the PR description when the implementation materially changes the
  behavior, scope, or risk described there

Do not inflate the PR description with unrelated repository observations.

## Review handling

When review comments arrive:

* evaluate each finding against the code, issue scope, and repository invariants
* address all actionable findings that materially affect merge safety
* rerun relevant validation after changes
* resolve comments once the finding is addressed or demonstrated not to apply
* update the PR description if review-driven changes alter behavior, scope, or
  risk
* do not implement unrelated cleanup solely to make a review thread disappear
* classify worthwhile out-of-scope observations as follow-up work rather than
  expanding the current PR

A review finding is evidence to investigate, not an automatic instruction to
change code.

## Merge readiness

A branch is merge-ready when:

* the requested behavior and acceptance criteria are satisfied
* required CI checks pass
* actionable merge-blocking review findings are resolved
* relevant generated artifacts are current
* required migrations are present
* repository and architecture invariants remain satisfied
* the branch meets the repository's base-branch freshness policy
* there are no merge conflicts

The existence of unrelated technical debt or non-blocking follow-up ideas does
not make a PR unmergeable.

## Issue handling

When tooling or repository automation supports it:

* update issue status when work begins if the repository workflow expects it
* when a PR is opened, link it to the issue and post a concise progress update
  when useful
* keep the issue aligned with material scope changes
* after merge, post a concise delivery note and close or update the issue
  according to repository workflow

Do not silently expand an issue's acceptance criteria during implementation or
review.

## Pull request review guidance

The purpose of pull request review is to determine whether the proposed change
is safe and correct to merge, not to exhaustively audit or improve the
surrounding codebase.

Review the complete PR diff against:

* the linked issue and acceptance criteria
* relevant product requirements
* repository architecture and package boundaries
* API and slicer contracts
* schema and migration requirements
* security, privacy, and data-integrity requirements
* regression risk introduced by the change

Prefer a small number of high-confidence, actionable findings over exhaustive
commentary.

### Actionable findings

A finding is actionable for the current PR when at least one of these is true:

* the PR introduces the defect
* the PR materially worsens an existing defect
* the PR exposes an existing defect in a way that makes the changed behavior
  unsafe or incorrect
* the defect prevents an acceptance criterion from being satisfied
* the change violates a repository architecture or package invariant
* the change creates contract drift between producers and consumers
* a required migration or generated contract update is missing
* the change creates a concrete security, privacy, payment, data-integrity, or
  operational regression

Medium-risk findings are review-worthy when they have a concrete failure mode,
user impact, or meaningful cleanup cost **and are materially caused by or
affected by the PR**.

### Out-of-scope findings

Do not make a finding actionable merely because the PR makes nearby
pre-existing technical debt visible.

Do not expand the current PR to request unrelated:

* refactoring
* cleanup
* architectural improvements
* additional product functionality
* speculative future abstractions
* test coverage for behavior unaffected by the PR
* performance optimization outside the changed execution path
* documentation unrelated to changed behavior
* maker-network, AI, routing, node-agent, mobile, or deployment capabilities not
  requested by the issue

Material pre-existing issues discovered during review may be mentioned as
follow-up work, but they do not block the current PR unless the PR makes them
materially worse or unsafe.

### Review-worthy changed behavior

When relevant to the PR, review for:

* missing or weak tests for changed behavior, important edge cases, null paths,
  error paths, or regression-prone logic
* API contract drift between the NestJS backend, generated OpenAPI client, and
