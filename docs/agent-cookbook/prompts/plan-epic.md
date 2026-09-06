# Role

Act as the architecture and implementation planning agent for this work.

Use high reasoning effort. Do not implement production code.

# Objective

Analyze the referenced epic/issue and all relevant child issues, repository code, product specifications, architecture documentation, and existing implementation patterns.

Produce a complete technical implementation plan that another agent can execute without having to redesign the feature.

# Sources of truth

- GitHub epic: <EPIC>
- Child issues: inspect all linked issues
- Product specification: <SPEC>
- Repository instructions: AGENTS.md
- Relevant architecture / ADRs / existing implementation

If sources conflict, identify the conflict explicitly instead of silently choosing one.

# Required analysis

Determine:

- current system behavior and architecture
- target behavior
- affected modules/packages/apps
- domain and data model changes
- persistence/migrations
- API/contracts/events
- frontend/UI impacts
- integration boundaries
- security and lifecycle concerns
- backward compatibility
- test strategy
- rollout/migration concerns
- dependencies between child issues
- appropriate PR boundaries
- whether execution should be serial, parallel, or hybrid

Do not parallelize merely because tasks can technically run concurrently. Consider architectural coupling, merge risk, implementation uncertainty, and compute usage.

# Output

Create:

`docs/work/<epic-or-feature>/implementation-plan.md`

The plan must contain:

1. Goal and scope
2. Source requirements and linked GitHub issues
3. Current-state analysis
4. Target architecture
5. Key technical decisions
6. Detailed implementation design
7. Issue-to-execution mapping
8. Dependency graph
9. Execution strategy:
   - SERIAL / PARALLEL / HYBRID
   - rationale
   - maximum useful concurrency
10. Implementation phases
11. Expected PR boundaries and linked issues
12. Testing and verification strategy
13. Integration validation
14. Escalation criteria
15. Definition of done

Do not begin implementation.

When the plan is complete, summarize unresolved questions requiring human approval.
