import { describe, expect, it } from "vitest";
import {
  LEGAL_PLACEHOLDER_BANNER,
  indexablePublicRoutes,
  legalDocuments,
  publicSite,
} from "./public-site";

describe("public site launch boundaries", () => {
  it("identifies the approval record behind the public content", () => {
    expect(publicSite.contentRevision).toBe("launch-approvals-v0.1");
  });

  it("does not invent unapproved commercial or contact values", () => {
    expect(publicSite.commercial.fromPrice).toBeNull();
    expect(publicSite.commercial.standardLeadTime).toBeNull();
    expect(publicSite.contact.email).toBeNull();
    expect(publicSite.contact.phone).toBeNull();
    expect(publicSite.portfolio.items).toHaveLength(0);
    expect(publicSite.analytics.provider).toBeNull();
  });

  it("keeps every legal draft visibly non-production and out of the sitemap", () => {
    expect(LEGAL_PLACEHOLDER_BANNER).toBe(
      "NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI",
    );

    for (const document of Object.values(legalDocuments)) {
      expect(document.id).toMatch(/-pending$/);
      expect(indexablePublicRoutes).not.toContain(document.path);
      expect(document).not.toHaveProperty("effectiveDate");
    }
  });
});
