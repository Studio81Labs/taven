# `@taven/ui-web`

Visual tokens and components with two real consumers: `apps/web` and
`apps/admin`. Page-specific UI stays in its application. `TavenStatusPanel` is
the initial shared health/foundation surface and should not become a generic
component dumping ground.

The approved foundation is Nuxt UI plus Taven theming and custom product
composition; see [ADR 0030](../../docs/decisions/0030-use-nuxt-ui-for-presentation.md).
Adoption is pending implementation. This package is not a second generic UI
library: share only assets/components with two real consumers, and avoid
mechanical wrappers around every Nuxt UI component. Application-specific layouts
and Nuxt/Vite integration stay in their applications. Existing mock-era visual
structure may be replaced during scoped design work; account for both consumers
before changing shared styles.
