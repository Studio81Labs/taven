import { describe, expect, it } from "vitest";
import {
  assertEffectiveLegalDocuments,
  LEGAL_DOCUMENT_KEYS,
} from "./legal-approvals.catalog";

describe("legal approval availability contract", () => {
  it("keeps the six stable public document keys", () => {
    expect(LEGAL_DOCUMENT_KEYS).toEqual([
      "terms",
      "claims",
      "privacy",
      "prohibitedContent",
      "retention",
      "photoConsent",
    ]);
  });

  it("fails closed when a database projection is not effective", () => {
    const approvals = {
      documents: Object.fromEntries(
        LEGAL_DOCUMENT_KEYS.map((key) => [
          key,
          {
            revision: `draft:${key}`,
            revisionId: null,
            status: "draft",
            effectiveAt: null,
            contentHash: null,
            effective: false,
          },
        ]),
      ),
    } as never;
    expect(() => assertEffectiveLegalDocuments(approvals, ["terms"])).toThrow(
      "Legal approval metadata is unavailable or not yet effective",
    );
  });
});
