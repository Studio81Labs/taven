# Role

Act as the implementation orchestrator.

# Source

The approved implementation plan is:

`docs/work/<epic-or-feature>/implementation-plan.md`

Read it completely before modifying code.

Also read:
- AGENTS.md
- referenced GitHub issues
- relevant repository documentation

# Objective

Implement the approved plan end to end.

Treat architectural decisions in the plan as authoritative unless implementation reveals a material gap.

# Execution responsibilities

- follow the execution order and dependency graph
- use serial, parallel, or hybrid execution exactly where appropriate
- delegate bounded work to subagents when useful
- prefer optimized models for mechanical or well-defined subtasks
- keep changes scoped
- run tests, lint, type checking, and relevant verification
- maintain linkage between implementation work, PRs, and GitHub issues
- create PRs according to the planned PR boundaries
- close/link issues only when their acceptance criteria are actually satisfied

# Escalation rule

Do not autonomously redesign architecture when implementation reveals a material gap.

Escalation is required when the discovered issue affects:

- architecture
- persistence/data model
- public API/contracts
- security boundaries
- concurrency/lifecycle semantics
- backward compatibility
- core product behavior
- assumptions that invalidate the approved plan

When escalation is required:

1. Stop only the affected work.
2. Create:
   `docs/work/<epic-or-feature>/escalations/<NNN>.md`
3. Include:
   - context
   - discovered gap
   - conflicting assumption
   - relevant files/code
   - why implementation cannot safely continue
   - options identified
   - concrete decision required
4. Mark the escalation OPEN.
5. Report that the task is blocked on architecture.

Do not resolve the escalation yourself unless explicitly authorized.

# Completion

After implementation:

- verify all planned phases
- ensure all acceptance criteria are satisfied
- create/update PRs
- report completed issues, remaining work, tests performed, and any known limitations
