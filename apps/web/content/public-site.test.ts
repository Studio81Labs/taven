import { describe, expect, it } from "vitest";
import { LEGAL_DRAFT_STATUS } from "./legal-drafts";
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

    expect(Object.keys(legalDocuments)).toEqual([
      "terms",
      "claims",
      "privacy",
      "prohibitedContent",
      "retention",
      "photoConsent",
    ]);

    for (const document of Object.values(legalDocuments)) {
      expect(document.id).toMatch(/-pending$/);
      expect(indexablePublicRoutes).not.toContain(document.path);
      expect(document).not.toHaveProperty("effectiveDate");
      expect(document.draft.status).toBe(LEGAL_DRAFT_STATUS);
      expect(document.draft.sections.length).toBeGreaterThan(0);
      expect(document.draft).not.toHaveProperty("effectiveDate");

      for (const section of document.draft.sections) {
        expect(section.title).not.toHaveLength(0);
        expect(
          (section.paragraphs?.length ?? 0) +
            (section.items?.length ?? 0) +
            (section.note ? 1 : 0),
        ).toBeGreaterThan(0);
      }
    }
  });
});
