import { describe, expect, it } from "vitest";
import { LEGAL_DRAFT_STATUS, legalDrafts } from "./legal-drafts";
import {
  LEGAL_PLACEHOLDER_BANNER,
  indexablePublicRoutes,
  legalDocuments,
  publicFooterNavigation,
  publicNavigation,
  publicSite,
} from "./public-site";

describe("public site launch boundaries", () => {
  it("identifies the approval record behind the public content", () => {
    expect(publicSite.contentRevision).toBe("launch-approvals-v0.1");
  });

  it("does not invent unapproved commercial values", () => {
    expect(publicSite.commercial.automaticQuotePubliclyEnabled).toBe(false);
    expect(publicSite.commercial.fromPrice).toBeNull();
    expect(publicSite.commercial.standardLeadTime).toBeNull();
    expect(publicSite.seller.vatId).toBe("CZ29508291");
    expect(publicSite).not.toHaveProperty("contact");
    expect(publicSite.portfolio.items).toHaveLength(0);
    expect(publicSite.analytics.provider).toBeNull();
  });

  it("keeps both customer journeys available from the public shell", () => {
    expect(publicNavigation).toContainEqual({
      index: "04",
      label: "Potřebuji model",
      to: "/poptavka",
    });
    expect(publicFooterNavigation).toContainEqual({
      label: "Kontakt",
      to: "/kontakt",
    });
  });

  it("keeps every legal draft visibly non-production and out of the sitemap", () => {
    expect(LEGAL_PLACEHOLDER_BANNER).toBe(
      "NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI",
    );

    const legalDocumentKeys = [
      "terms",
      "claims",
      "privacy",
      "prohibitedContent",
      "retention",
      "photoConsent",
    ];

    expect(Object.keys(legalDocuments)).toEqual(legalDocumentKeys);
    expect(Object.keys(legalDrafts)).toEqual(legalDocumentKeys);

    for (const document of Object.values(legalDocuments)) {
      expect(document.id).toMatch(/-pending$/);
      expect(indexablePublicRoutes).not.toContain(document.path);
      expect(document).not.toHaveProperty("effectiveDate");
      expect(document).not.toHaveProperty("draft");
    }

    for (const draft of Object.values(legalDrafts)) {
      expect(draft.status).toBe(LEGAL_DRAFT_STATUS);
      expect(draft.sections.length).toBeGreaterThan(0);
      expect(draft).not.toHaveProperty("effectiveDate");

      for (const section of draft.sections) {
        expect(section.title).not.toHaveLength(0);
        expect(
          (section.paragraphs?.length ?? 0) +
            (section.items?.length ?? 0) +
            (section.note ? 1 : 0),
        ).toBeGreaterThan(0);
      }
    }
  });

  it("keeps manual review and sensitive source formats explicit in the drafts", () => {
    const manualReview = legalDrafts.prohibitedContent.sections.find(
      (section) => section.title === "6. Manuální kontrola",
    );
    expect(manualReview?.paragraphs).toContain(
      "Ve verzi v0 prochází manuální kontrolou náhledu každá objednávka.",
    );

    for (const draft of [legalDrafts.retention, legalDrafts.photoConsent]) {
      const content = JSON.stringify(draft.sections);
      expect(content).toContain("Zdrojová CAD data jsou citlivější");
      expect(content).toContain("STL");
      expect(content).toContain("3MF");
      expect(content).toContain("STEP");
    }
  });
});
