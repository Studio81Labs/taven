import { describe, expect, it } from "vitest";
import { isLegalAvailability } from "./legal-availability";

describe("legal availability", () => {
  it("rejects malformed availability responses", () => {
    expect(isLegalAvailability(null)).toBe(false);
    expect(
      isLegalAvailability({
        schemaVersion: 1,
        policyRevision: "legal-policy-v1",
        evaluatedAt: "2030-01-01T00:00:00.000Z",
        documents: {},
      }),
    ).toBe(false);
  });

  it("accepts the complete fixed-key availability response", () => {
    expect(isLegalAvailability(availability())).toBe(true);
  });
});

function availability() {
  const document = {
    revision: "document-v1",
    status: "approved" as const,
    effectiveAt: "2030-01-01T00:00:00.000Z",
    effective: true,
  };
  return {
    schemaVersion: 1 as const,
    policyRevision: "legal-policy-v1",
    evaluatedAt: "2030-01-01T00:00:00.000Z",
    documents: {
      terms: document,
      claims: document,
      privacy: document,
      prohibitedContent: document,
      retention: document,
      photoConsent: document,
    },
  };
}
