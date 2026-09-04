export const LEGAL_PLACEHOLDER_BANNER =
  "NÁVRH — NEPLATÍ / NEPOUŽÍVAT V PRODUKCI";

export const publicSite = {
  contentRevision: "launch-approvals-v0.1",
  brand: {
    name: "Taven",
    wordmark: "TAVEN.",
    compactMark: "TV.",
    status: "working-name" as const,
  },
  seller: {
    legalName: "Studio81 Labs, s.r.o.",
    address: ["Nové sady 988/2", "602 00 Brno", "Česká republika"],
    companyId: "29508291",
  },
  contact: {
    email: null,
    phone: null,
    status: "pending-approval" as const,
  },
  commercial: {
    fromPrice: null,
    standardLeadTime: null,
    status: "pending-approval" as const,
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
  { label: "Jak to funguje", to: "/jak-to-funguje" },
  { label: "Ceník", to: "/cenik" },
  { label: "Ukázky", to: "/ukazky" },
  { label: "Potřebuji model", to: "/poptavka" },
] as const;

export const publicFooterNavigation = [
  { label: "Kontakt", to: "/kontakt" },
] as const;

export const indexablePublicRoutes = [
  "/",
  "/jak-to-funguje",
  "/cenik",
  "/ukazky",
  "/kontakt",
] as const;

export const legalDocuments = {
  terms: {
    id: "terms-pending",
    path: "/vop",
    title: "Všeobecné obchodní podmínky",
    summary: "Schválené všeobecné obchodní podmínky zatím nejsou k dispozici.",
  },
  claims: {
    id: "claims-pending",
    path: "/reklamace",
    title: "Reklamační řád",
    summary: "Schválený reklamační řád zatím není k dispozici.",
  },
  privacy: {
    id: "privacy-pending",
    path: "/ochrana-soukromi",
    title: "Zásady zpracování osobních údajů",
    summary:
      "Schválené zásady zpracování osobních údajů zatím nejsou k dispozici.",
  },
} as const;

export type LegalDocument =
  (typeof legalDocuments)[keyof typeof legalDocuments];
