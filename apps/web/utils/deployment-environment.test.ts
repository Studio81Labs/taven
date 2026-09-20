import { describe, expect, it } from "vitest";
import {
  isProductionDeployment,
  normalizeDeploymentEnvironment,
} from "./deployment-environment";

describe("deployment environment", () => {
  it.each(["development", "staging", "production"])(
    "accepts the exact %s identity",
    (value) => {
      expect(normalizeDeploymentEnvironment(value)).toBe(value);
    },
  );

  it.each([undefined, "", "prod", "Production", "staging "])(
    "normalizes invalid identity %s to unknown",
    (value) => {
      expect(normalizeDeploymentEnvironment(value)).toBe("unknown");
    },
  );

  it("only treats explicit production as indexable", () => {
    expect(isProductionDeployment("production")).toBe(true);
    expect(isProductionDeployment("staging")).toBe(false);
    expect(isProductionDeployment(undefined)).toBe(false);
  });
});
