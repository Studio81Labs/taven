# ADR 0001: Use Nuxt for the public web application

- **Status:** accepted
- **Date:** 2026-08-26

## Context

Taven's public surface combines acquisition pages, durable legal/content pages,
and the interactive quote and checkout journey. Search visibility is a durable
acquisition requirement, while a separate marketing application would duplicate
routing, content, and visual work at this stage.

## Decision

Use Nuxt with Vue 3 and TypeScript in `apps/web`. Keep public content and the
interactive customer journey in the same application until independent
operational or ownership needs justify a split.

## Consequences

The web application can server-render or pre-render public pages while retaining
Vue for interactive flows. Nuxt-specific code stays in `apps/web`; reusable UI
requires a second consumer before it moves to `packages/ui-web`.
