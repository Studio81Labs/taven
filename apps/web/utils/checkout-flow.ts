import type { components } from "@taven/openapi-client";
import type { LegalDocument } from "../content/launch-manifest";
import { isEffectiveApprovedLegalDocument } from "../content/launch-approvals";

type PaymentCapabilities = components["schemas"]["PaymentCapabilitiesDto"];
type CheckoutLegalDocuments = Readonly<{
  terms: LegalDocument;
  claims: LegalDocument;
  photoConsent: LegalDocument;
}>;

export function approvedCheckoutDocuments(
  capabilities: PaymentCapabilities | undefined,
  local: CheckoutLegalDocuments,
) {
  const documents = capabilities?.legalDocuments;
  if (
    !capabilities?.available ||
    capabilities.methods.length === 0 ||
    !documents ||
    documents.termsRevision !== local.terms.id ||
    documents.claimPolicyRevision !== local.claims.id ||
    !isEffectiveApprovedLegalDocument(local.terms) ||
    !isEffectiveApprovedLegalDocument(local.claims)
  ) {
    return null;
  }
  return {
    termsRevision: documents.termsRevision,
    claimPolicyRevision: documents.claimPolicyRevision,
    photoConsentRevision:
      documents.photoConsentRevision === local.photoConsent.id &&
      isEffectiveApprovedLegalDocument(local.photoConsent)
        ? documents.photoConsentRevision
        : null,
  } as const;
}

export function checkoutErrorMessage(status: number): string {
  if (status === 409) {
    return "Cena, doprava nebo předchozí platební pokus se změnily. Načetli jsme aktuální objednávku; údaje ve formuláři zůstaly uložené.";
  }
  if (status === 410) {
    return "Platnost závazné ceny nebo rezervace vypršela. Pro další objednání začněte novou kalkulaci; údaje z tohoto formuláře se z bezpečnostních důvodů nepřenášejí.";
  }
  if (status === 503) {
    return "Platba teď není dostupná. Údaje zůstaly uložené a pokus můžete bezpečně zopakovat.";
  }
  if (status === 400) {
    return "Zkontrolujte povinné fakturační údaje a potvrzení.";
  }
  return "Platební krok se nepodařilo dokončit. Údaje zůstaly uložené; zkuste to znovu.";
}

export function paymentStatusPath(
  kind: "success" | "cancelled" | "pending",
  sessionId: string,
  paymentId: string,
): string {
  const query = new URLSearchParams({ sessionId, paymentId });
  return `/checkout/payment/${kind}?${query.toString()}`;
}

export function paymentReturnMatchesHandoff(
  expectedPaymentId: string | undefined,
  requestedPaymentId: string,
): boolean {
  return Boolean(expectedPaymentId && expectedPaymentId === requestedPaymentId);
}
