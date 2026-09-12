import { describe, expect, it } from "vitest";
import {
  hasEffectiveAutomaticQuoteDocuments,
  isAutomaticQuoteEnabled,
} from "./automatic-quote-launch";

describe("automatic quote launch gate", () => {
  const approvedDocument = (id: string) => ({
    id,
    path: `/${id}`,
    title: id,
    summary: id,
    status: "approved" as const,
    effectiveAt: "2026-01-01",
    approvalEvidence: "#38",
  });

  it("requires every blocking document to be effective", () => {
    const documents = {
      terms: approvedDocument("terms-v1"),
      claims: approvedDocument("claims-v1"),
      privacy: approvedDocument("privacy-v1"),
      prohibitedContent: approvedDocument("prohibited-content-v1"),
      retention: approvedDocument("retention-v1"),
    };

    expect(hasEffectiveAutomaticQuoteDocuments(documents)).toBe(true);
    expect(
      hasEffectiveAutomaticQuoteDocuments({
        ...documents,
        privacy: {
          ...documents.privacy,
          status: "draft" as const,
          effectiveAt: null,
          approvalEvidence: null,
        },
      }),
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
