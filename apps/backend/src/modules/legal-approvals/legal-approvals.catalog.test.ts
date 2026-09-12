import { describe, expect, it } from "vitest";
import { assertEffectiveQuoteRequestLegalDocuments } from "../../launch-approval-gates";
import {
  evaluateLegalApprovals,
  legalApprovalCatalog,
  type LegalApprovalCatalog,
} from "./legal-approvals.catalog";

describe("legal approval catalog", () => {
  it("keeps the checked-in launch catalog explicitly draft and ineffective", () => {
    const evaluated = evaluateLegalApprovals(
      new Date("2030-01-01T00:00:00.000Z"),
    );

    expect(evaluated.schemaVersion).toBe(1);
    expect(evaluated.evaluatedAt).toBe("2030-01-01T00:00:00.000Z");
    expect(
      Object.values(evaluated.documents).every(
        (document) => document.status === "draft" && !document.effective,
      ),
    ).toBe(true);
  });

  it("uses the supplied trusted instant at the exact effective boundary", () => {
    const catalog = approvedCatalog("2030-01-01T00:00:00.000Z");

    expect(
      evaluateLegalApprovals(new Date("2029-12-31T23:59:59.999Z"), catalog)
        .documents.terms.effective,
    ).toBe(false);
    expect(
      evaluateLegalApprovals(new Date("2030-01-01T00:00:00.000Z"), catalog)
        .documents.terms.effective,
    ).toBe(true);
  });

  it("rejects non-canonical approved effective instants", () => {
    expect(() =>
      evaluateLegalApprovals(new Date(), approvedCatalog("2030-01-01")),
    ).toThrow("Legal approval catalog is invalid");
  });

  it("keeps quote requests closed until retention is effective", () => {
    const catalog = approvedCatalog("2030-01-01T00:00:00.000Z");
    const approvals = evaluateLegalApprovals(
      new Date("2030-01-01T00:00:00.000Z"),
      {
        ...catalog,
        documents: {
          ...catalog.documents,
          retention: legalApprovalCatalog.documents.retention,
        },
      },
    );

    expect(() =>
      assertEffectiveQuoteRequestLegalDocuments(approvals, false),
    ).toThrow("Legal approval metadata is unavailable or not yet effective");
  });
});

function approvedCatalog(effectiveAt: string): LegalApprovalCatalog {
  return {
    ...legalApprovalCatalog,
    policyRevision: "legal-policy-v1-test",
    documents: Object.fromEntries(
      Object.entries(legalApprovalCatalog.documents).map(([key, document]) => [
        key,
        {
          ...document,
          revision: `${key}-v1`,
          status: "approved",
          effectiveAt,
          approvalEvidence: "#38",
        },
      ]),
    ) as LegalApprovalCatalog["documents"],
  };
}
