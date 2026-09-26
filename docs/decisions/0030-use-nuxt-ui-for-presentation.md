# ADR 0030: Use Nuxt UI as the foundation for custom Taven presentation

- **Status:** accepted; implementation and validation required
- **Date:** 2026-09-26
- **Authority:** owner decision to use Nuxt UI for basic elements and custom
  composition, and to update UI documentation and review rules
- **Scope:** `apps/web`, `apps/admin`, and genuinely shared visual assets/components
- **Amends:** the UI-library and presentation-preservation constraints in the
  [final website design plan](../plans/2026-09-25-final-web-design.md)

## Context

The functioning application was built using mock-era presentation. Applying
parts of the final design to that structure has left a hybrid of the old and
target UI. Preserving the old markup can prevent faithful implementation even
when behavior is correct. Building every standard UI element locally also adds
work unrelated to Taven's product-specific interactions.

## Decision

Use Nuxt UI as the standard component foundation for both applications, including
basic elements such as buttons, cards, headers and form controls where they fit.
Keep the public web on Nuxt and the admin on Vue/Vite. Configure the library for
each application; this decision does not require moving the admin to Nuxt.

Apply a Taven theme for colors, typography, spacing, borders, radii, sizes and
interaction states. The approved target design controls the result, including
the website's square corners, planes and technical typography. Nuxt UI defaults
are not a replacement design. Share brand values while allowing deliberate
application-specific density and composition.

Keep product-specific elements and page layouts custom: model preview,
configuration choices, price breakdown, order context, title-block footers and
operator workflows. They may compose Nuxt UI elements. A library header or card
may supply structure while Taven owns its content and layout. Do not force a
library component where it compromises the approved design, or create a wrapper
for every library component without a concrete recurring requirement.

Keep page-specific components in their application. `packages/ui-web` continues
to require at least two real consumers for shared assets/components. Share theme
values only where actually consumed; keep Nuxt module/runtime configuration in
`apps/web`, and Vue/Vite integration in `apps/admin`. Do not install a second
generic UI toolkit as part of this decision.

## Authorized refactoring and limits

For an assigned target-design screen or flow, rewriting templates, replacing or
recomposing components, separating presentation from existing functional logic,
and deleting superseded styles/components are part of implementation. Existing
mock structure is not an invariant. Reuse working domain logic, composables and
integrations; preserve their observable behavior and contracts.

API and slicer contracts, routes, authorization, session/storage semantics,
pricing, legal consent, payment idempotency and provider integrations remain
unchanged unless separately authorized. Mock screenshots cannot authorize fake
commercial facts or unsupported features. Missing design states must use the
same visual system and represent real application state.

Migrate coherent screens or flows with explicit boundaries, including applicable
responsive, loading, empty, error, disabled and success states. Do not mark a
screen finished while it mixes superseded mock presentation with the target
design. Other screens may remain pending in separately scoped work. Remove old
styles and components only after their remaining consumers have been accounted
for; avoid unintended changes to the other application.

The existing numbered website references and their product/contract corrections
remain authoritative. The admin adopts the same foundation with its own assigned
screen requirements; this decision does not invent approved admin mockups or
extend the website epic to every operator screen.

## Review and completion

Reviewers must treat the refactoring above as in scope for the assigned design
deliverable. The old plan's "No new UI framework" constraint and generic
preserve-structure/minimize-diff guidance cannot be used to restore the mock UI
or reject this approved foundation. The owner decision supersedes that specific
constraint in older planning/issue text; other issue criteria remain unchanged.
Implementation issues and PRs should cite this ADR when applying the amendment.

Require comparison with the target reference at matching viewports and relevant
states, plus regression and accessibility evidence for the changed interactions.
Functional tests alone do not establish visual completion. Update obsolete
markup-dependent tests without weakening behavioral assertions. Review screenshot
baseline changes against the target rather than automatically accepting output.
For screens without a supplied visual reference, document the intended composition
and states in the scoped implementation plan before claiming visual completion.

Real regressions, target-design mismatches, incomplete states, package violations
and out-of-scope behavior changes remain reviewable. This decision removes no
validation, independent-review or launch-approval gate. Library integration and
presentation replacement need no repeated architecture approval; material
changes to the preserved contracts still require escalation.

## Consequences and alternatives

Taven retains ownership of its visual identity and custom composition while
using a maintained component foundation. Adoption still requires dependency,
build/SSR, accessibility and visual validation; a theme alone does not complete
the redesign. This documentation change installs no package and claims no UI
migration or runtime validation.

Continuing a fully custom generic UI layer would retain unnecessary maintenance.
daisyUI was considered as a CSS foundation; the owner selected Nuxt UI for the
component foundation. Combining both is not part of this decision.

References: [Nuxt UI integration for Nuxt and Vue](https://nuxt.com/modules/ui),
[Nuxt UI theming](https://ui.nuxt.com/).
