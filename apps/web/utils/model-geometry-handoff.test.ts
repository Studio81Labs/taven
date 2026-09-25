import { afterEach, expect, it, vi } from "vitest";
import type { ModelGeometry } from "./model-geometry";
import {
  holdModelGeometryForRoute,
  takeModelGeometryForRoute,
} from "./model-geometry-handoff";

afterEach(() => vi.unstubAllGlobals());

it("transfers geometry once to the matching quote session only", () => {
  vi.stubGlobal("window", {});
  const geometry = { triangleCount: 12 } as ModelGeometry;

  holdModelGeometryForRoute("session-a", geometry);
  expect(takeModelGeometryForRoute("session-b")).toBeUndefined();
  expect(takeModelGeometryForRoute("session-a")).toBeUndefined();

  holdModelGeometryForRoute("session-a", geometry);
  expect(takeModelGeometryForRoute("session-a")).toBe(geometry);
  expect(takeModelGeometryForRoute("session-a")).toBeUndefined();
});

it("does not retain geometry on the server", () => {
  const geometry = { triangleCount: 12 } as ModelGeometry;
  holdModelGeometryForRoute("session-a", geometry);
  expect(takeModelGeometryForRoute("session-a")).toBeUndefined();
});
