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

The credential expires within 90 days. Rotation updates all five encrypted
repository secret copies and validates one default-branch run per repository
before revoking the old token. Suspected disclosure requires immediate
revocation, removal or replacement in all five repositories, review of Actions
logs and token audit records, and temporary schedule disablement if revocation
cannot be confirmed.

## Consequences

Every project-family repository can detect shared-policy drift against every
other member while retaining stack-specific topology. Compromise of the read
credential may disclose selected private sibling source but cannot write code,
issues, workflows, releases, settings, secrets, or deployments.

Rollback removes Poker Hero from Taven's inventory and Taven from Poker Hero's
inventory, then removes Taven's secret copy. A credential incident revokes the
token globally before repository edits; rollback never widens permissions or
deletes sibling source.
