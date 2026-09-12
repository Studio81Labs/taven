import { describe, expect, it } from "vitest";
import {
  hasEffectiveAutomaticQuoteDocuments,
  isAutomaticQuoteEnabled,
} from "./automatic-quote-launch";
import type { LegalAvailability } from "./legal-availability";
import type { LegalDocument } from "../content/launch-manifest";

describe("automatic quote launch gate", () => {
  const approvedDocument = (id: string) =>
    ({
      id,
      path: `/${id}`,
      title: id,
      summary: id,
      sections: [],
      status: "approved" as const,
      effectiveAt: "2026-01-01T00:00:00.000Z",
      approvalEvidence: "#38",
    }) satisfies LegalDocument;

  it("requires every blocking document to be effective", () => {
    const documents = {
      terms: approvedDocument("terms-v1"),
      claims: approvedDocument("claims-v1"),
      privacy: approvedDocument("privacy-v1"),
      prohibitedContent: approvedDocument("prohibited-content-v1"),
      retention: approvedDocument("retention-v1"),
    };

    const availability: LegalAvailability = {
      schemaVersion: 1,
      policyRevision: "test",
      evaluatedAt: "2026-01-01T00:00:00.000Z",
      documents: {
        terms: record("terms-v1"),
        claims: record("claims-v1"),
        privacy: record("privacy-v1"),
        prohibitedContent: record("prohibited-content-v1"),
        retention: record("retention-v1"),
        photoConsent: record("photos-v1"),
      },
    };
    expect(hasEffectiveAutomaticQuoteDocuments(documents, availability)).toBe(
      true,
    );
    expect(
      hasEffectiveAutomaticQuoteDocuments(
        {
          ...documents,
          privacy: {
            ...documents.privacy,
            status: "draft" as const,
            effectiveAt: null,
            approvalEvidence: null,
          },
        },
        availability,
      ),
    ).toBe(false);
  });

  it("requires an explicit runtime true and approved manifest inputs", () => {
    const approved = {
      hasApprovedAcquisitionDocuments: true,
      hasApprovedCommercialContent: true,
    };

    expect(isAutomaticQuoteEnabled({ ...approved, runtimeEnabled: true })).toBe(
      true,
    );
    expect(
      isAutomaticQuoteEnabled({ ...approved, runtimeEnabled: "true" }),
    ).toBe(true);
    expect(
      isAutomaticQuoteEnabled({ ...approved, runtimeEnabled: " true" }),
    ).toBe(false);
    expect(
      isAutomaticQuoteEnabled({
        ...approved,
        runtimeEnabled: false,
      }),
    ).toBe(false);
    expect(
      isAutomaticQuoteEnabled({
        runtimeEnabled: true,
        hasApprovedAcquisitionDocuments: false,
        hasApprovedCommercialContent: true,
      }),
    ).toBe(false);
  });
});

function record(revision: string) {
  return {
    revision,
    status: "approved" as const,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    effective: true,
  };
}
