# ADR 0003: Enroll Taven In Project-Family Drift Monitoring

Status: accepted

Date: 2026-08-26

## Context

Taven is a first-class member of the Studio81 Labs project family with Nexcue,
TableTap, Tarmoto, and Poker Hero. The repositories share infrastructure policy
but not every application capability. Their scheduled drift workflows need to
read one another without granting cross-repository write access.

## Decision

Taven lists the other four family repositories in `SIBLING_REPOS` and keeps the
same Monday drift schedule, local `infra-drift` issue ownership, hash-locked
PyYAML dependency, and byte-identical comparison script as the family baseline.
Capability markers distinguish Taven's Node services from Poker Hero's FastAPI
backend and React/Vite PWA without placeholder applications or workflows.

`SIBLING_READ_TOKEN` is a fine-grained personal access token restricted to the
selected private family repositories with repository Contents read permission
only. Public family repositories require no additional repository entitlement.
The secret is stored independently in each repository and is passed only to a
job running trusted default-branch code; manual dispatches targeting any other
ref are skipped before checkout. The repository-scoped Actions token owns only
Taven's local issue writes.

The credential expires within 90 days. Rotation updates every encrypted
repository secret copy in the family and validates one default-branch run per
repository before revoking the old token. Suspected disclosure requires
immediate revocation, removal or replacement everywhere the token is held,
review of Actions logs and token audit records, and temporary schedule
disablement if revocation cannot be confirmed.

## Consequences

Every project-family repository can detect shared-policy drift against every
other member while retaining stack-specific topology. Compromise of the read
credential may disclose selected private sibling source but cannot write code,
issues, workflows, releases, settings, secrets, or deployments.

Rollback removes a sibling from Taven's inventory and Taven from that
sibling's inventory, then removes Taven's secret copy for it. A credential
incident revokes the token globally before repository edits; rollback never
widens permissions or deletes sibling source.

## Update (2026-09-21)

Poker Hero (renamed `Studio81Labs/sidekick` in September 2026) is archived and
retired from the family drift comparison — the rollback procedure above, run
for real rather than described in the abstract. `SIBLING_REPOS` now names
three siblings (Nexcue, TableTap, Tarmoto) instead of four, and the
Poker-specific topology handling this ADR described (capability markers
distinguishing Taven's Node services from its FastAPI backend and React/Vite
PWA) is removed from `check-sibling-drift.py` along with it. The rest of this
ADR — enrollment, the token model, and the rotation/incident procedure —
remains in force for the three active siblings; status stays `accepted`.
