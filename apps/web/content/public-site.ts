import {
  isEffectiveApprovedLegalDocument,
  legalDocuments,
} from "./launch-manifest";
import { commercialContentApproval } from "./launch-approvals";

export type { CommercialContentStatus } from "./launch-approvals";

export const LEGAL_PLACEHOLDER_BANNER =
  "NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI";

export const publicSite = {
  contentRevision: "launch-approvals-v0.1",
  brand: {
    name: "Taven",
    wordmark: "TAVEN.",
    compactMark: "TV.",
    status: "final" as const,
  },
  seller: {
    legalName: "Studio81 Labs, s.r.o.",
    address: ["Nové sady 988/2", "602 00 Brno", "Česká republika"],
    companyId: "29508291",
    vatId: "CZ29508291",
  },
  commercial: {
    fromPrice: null,
    standardLeadTime: null,
    ...commercialContentApproval,
  },
  portfolio: {
    items: [],
    status: "waiting-for-approved-assets" as const,
  },
  analytics: {
    provider: null,
    status: "disabled-until-consent-boundary-exists" as const,
  },
} as const;

export const publicNavigation = [
  { index: "01", label: "Jak to funguje", to: "/jak-to-funguje" },
  { index: "02", label: "Ceník", to: "/cenik" },
  { index: "03", label: "Ukázky", to: "/ukazky" },
  { index: "04", label: "Potřebuji model", to: "/poptavka" },
] as const;

export const publicFooterNavigation = [
  { label: "Kontakt", to: "/kontakt" },
] as const;

const baseIndexablePublicRoutes = [
  "/",
  "/jak-to-funguje",
  "/cenik",
  "/ukazky",
  "/kontakt",
] as const;

export function indexablePublicRoutes(now = Date.now()): readonly string[] {
  return [
    ...baseIndexablePublicRoutes,
    ...Object.values(legalDocuments)
      .filter((document) => isEffectiveApprovedLegalDocument(document, now))
      .map((document) => document.path),
  ];
}

export { legalDocuments };
export type { LegalDocument } from "./launch-manifest";
