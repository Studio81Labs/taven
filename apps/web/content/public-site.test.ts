import { describe, expect, it } from "vitest";
import { LEGAL_DRAFT_STATUS, legalDrafts } from "./legal-drafts";
import {
  approvedLegalDocument,
  isEffectiveApprovedLegalDocument,
} from "./launch-manifest";
import {
  LEGAL_PLACEHOLDER_BANNER,
  indexablePublicRoutes,
  legalDocuments,
  publicFooterNavigation,
  publicNavigation,
  publicSite,
} from "./public-site";

describe("public site launch boundaries", () => {
  it("requires evidence and an effective date for approved legal content", () => {
    const base = {
      id: "terms-v1",
      path: "/vop",
      title: "VOP",
      summary: "Schválené znění",
      sections: [{ title: "Schválený obsah", paragraphs: ["Text"] }],
    };
    expect(() =>
      approvedLegalDocument({
        ...base,
        effectiveAt: "",
        approvalEvidence: "#38",
      }),
    ).toThrow("require an ID");
    expect(() =>
      approvedLegalDocument({
        ...base,
        sections: [],
        effectiveAt: "2026-01-01T00:00:00.000Z",
        approvalEvidence: "#38",
      }),
    ).toThrow("require an ID");
    expect(
      approvedLegalDocument({
        ...base,
        effectiveAt: "2026-01-01T00:00:00.000Z",
        approvalEvidence: "#38",
      }),
    ).toMatchObject({ status: "approved", id: "terms-v1" });
    expect(() =>
      approvedLegalDocument({
        ...base,
        id: "terms-pending",
        effectiveAt: "2026-01-01T00:00:00.000Z",
        approvalEvidence: "#38",
      }),
    ).toThrow("require an ID");
    expect(() =>
      approvedLegalDocument({
        ...base,
        effectiveAt: "2026-02-30T00:00:00.000Z",
        approvalEvidence: "#38",
      }),
    ).toThrow("require an ID");
    expect(() =>
      approvedLegalDocument({
        ...base,
        effectiveAt: "2026-01-01T00:00:00Z",
        approvalEvidence: "#38",
      }),
    ).toThrow("require an ID");
  });

  it("does not activate approvals before their effective date", () => {
    const document = approvedLegalDocument({
      id: "terms-v2",
      path: "/vop",
      title: "VOP",
      summary: "Schválené znění",
      sections: [{ title: "Schválený obsah", paragraphs: ["Text"] }],
      effectiveAt: "2030-01-01T00:00:00.000Z",
      approvalEvidence: "#38",
    });

    expect(
      isEffectiveApprovedLegalDocument(
        document,
        Date.parse("2029-12-31T23:59:59.999Z"),
      ),
    ).toBe(false);
    expect(
      isEffectiveApprovedLegalDocument(
        document,
        Date.parse("2030-01-01T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("identifies the approval record behind the public content", () => {
    expect(publicSite.contentRevision).toBe("launch-approvals-v0.1");
  });

  it("does not invent unapproved commercial values", () => {
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

    for (const [key, document] of Object.entries(legalDocuments)) {
      expect(
        legalDrafts[key as keyof typeof legalDrafts].sourceDocumentId,
      ).toBe(document.id);
    }

    for (const document of Object.values(legalDocuments)) {
      expect(document.id).toMatch(/-pending$/);
      expect(document.status).toBe("draft");
      expect(document.effectiveAt).toBeNull();
      expect(document.approvalEvidence).toBeNull();
      expect(indexablePublicRoutes()).not.toContain(document.path);
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

  it("keeps legal drafts aligned with the owner-operated v0 service", () => {
    const allDrafts = JSON.stringify(legalDrafts);
    const terms = JSON.stringify(legalDrafts.terms.sections);
    const claims = JSON.stringify(legalDrafts.claims.sections);

    expect(allDrafts).not.toContain("Výrobce");
    expect(allDrafts).not.toContain("výrobní sítě");
    expect(terms).toContain("jako prodávající");
    expect(terms).toContain("není Provozovatel plátcem DPH");
    expect(terms).toContain("znovu ověřen");
    expect(terms).toContain("nenabízí katalog modelů");
    expect(terms).toContain("ani automatické generování modelů");
    expect(terms).toContain("výslovně potvrdit");
    expect(claims).toContain("věrnost");
    expect(claims).toContain("lícování");
  });

  it("keeps categorical safety bans and shipment remedies explicit", () => {
    const prohibitedOrders = legalDrafts.prohibitedContent.sections.find(
      (section) => section.title === "2. Zakázané zakázky",
    );
    const prohibitedOrdersContent = JSON.stringify(prohibitedOrders);
    const prohibitedContent = JSON.stringify(
      legalDrafts.prohibitedContent.sections,
    );
    const claims = JSON.stringify(legalDrafts.claims.sections);

    expect(prohibitedOrders?.paragraphs).toContain(
      "Ve verzi v0 jsou zakázány zejména zakázky zahrnující:",
    );
    expect(prohibitedOrdersContent).toContain(
      "střelné zbraně a jejich části, bez ohledu",
    );
    expect(prohibitedContent).toContain(
      "zdravotnické prostředky určené pro styk s tělem",
    );
    expect(prohibitedContent).toContain("ve verzi v0 zakázané");
    expect(claims).toContain("ztracené nebo vrácené zásilky");
    expect(claims).toContain("náhradní výrobě nebo zásilce");
    expect(claims).toContain("finančně vypořádanému zrušení");
  });

  it("documents full and staged payment settlement", () => {
    const payments = legalDrafts.terms.sections.find(
      (section) => section.title === "4. Cena a platba",
    );
    const content = JSON.stringify(payments);

    expect(content).toContain("automatické nabídce se hradí v plné výši");
    expect(content).toContain("zálohu a doplatek");
    expect(content).toContain("konkrétní zachycené platbě");
    expect(content).toContain("objednávku neobnoví");
  });

  it("separates source-file, physical-item, and photo retention", () => {
    const completedOrders = legalDrafts.retention.sections.find(
      (section) =>
        section.title === "3. Dokončené objednávky a reklamační podklad",
    );
    const unfinishedUploads = legalDrafts.retention.sections.find(
      (section) => section.title === "4. Nedokončené uploady a objednávky",
    );
    const abandonedPhysicalItems = legalDrafts.retention.sections.find(
      (section) => section.title === "5. Opuštěné fyzické výrobky",
    );
    const operationalPhotos = legalDrafts.retention.sections.find(
      (section) => section.title === "8. Fotografie",
    );
    const photoConsent = JSON.stringify(legalDrafts.photoConsent.sections);

    expect(JSON.stringify(completedOrders)).toContain(
      "alespoň do konce příslušné reklamační lhůty",
    );
    expect(JSON.stringify(completedOrders)).toContain(
      "nikoli jako skrytá dlouhodobá archivace",
    );
    expect(unfinishedUploads?.note).toContain("90 dní");
    expect(unfinishedUploads?.note).not.toContain("30 dní");
    expect(abandonedPhysicalItems?.note).toContain("30 dní");
    expect(abandonedPhysicalItems?.note).toContain("fyzický výrobek");
    expect(JSON.stringify(operationalPhotos)).toContain(
      "konečné plánované datum odstranění",
    );
    expect(operationalPhotos?.note).toContain("NENÍ SCHVÁLENO");
    expect(operationalPhotos?.note).toContain("ukládání");
    expect(operationalPhotos?.note).toContain("vypnuté");
    expect(photoConsent).toContain("neprodlužuje retenční lhůtu");
    expect(photoConsent).toContain("nejpozději při uplynutí lhůty");
  });
});
