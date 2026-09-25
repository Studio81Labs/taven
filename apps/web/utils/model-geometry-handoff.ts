import type { ModelGeometry } from "./model-geometry";

let pending: { sessionId: string; geometry: ModelGeometry } | undefined;

export function holdModelGeometryForRoute(
  sessionId: string,
  geometry: ModelGeometry | undefined,
): void {
  if (typeof window === "undefined") return;
  pending = geometry ? { sessionId, geometry } : undefined;
}

export function takeModelGeometryForRoute(
  sessionId: string,
): ModelGeometry | undefined {
  if (typeof window === "undefined") return undefined;
  const handoff = pending;
  pending = undefined;
  return handoff?.sessionId === sessionId ? handoff.geometry : undefined;
}
