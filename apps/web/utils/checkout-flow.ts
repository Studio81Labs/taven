import type { components } from "@taven/openapi-client";
import type { LegalDocument } from "../content/launch-manifest";
import {
  hasServerVerifiedLegalDocuments,
  isServerVerifiedLegalDocument,
  type LegalAvailability,
} from "./legal-availability";

type PaymentCapabilities = components["schemas"]["PaymentCapabilitiesDto"];
type CheckoutLegalDocuments = Readonly<
  Record<
    | "terms"
    | "claims"
    | "privacy"
    | "prohibitedContent"
    | "retention"
    | "photoConsent",
    LegalDocument
  >
>;
type VerifiedCheckoutLegalDocuments = Readonly<
  Record<keyof CheckoutLegalDocuments, boolean>
>;

export function approvedCheckoutDocuments(
  capabilities: PaymentCapabilities | undefined,
  local: CheckoutLegalDocuments,
  availability: LegalAvailability | null | undefined,
  verified: VerifiedCheckoutLegalDocuments,
) {
  const documents = capabilities?.legalDocuments;
  if (
    !capabilities?.available ||
    capabilities.methods.length === 0 ||
    !documents ||
    documents.termsRevision !== availability?.documents.terms.revision ||
    documents.claimPolicyRevision !== availability?.documents.claims.revision ||
    !hasServerVerifiedLegalDocuments(
      local,
      ["terms", "claims", "privacy", "prohibitedContent", "retention"],
      availability,
    ) ||
    !["terms", "claims", "privacy", "prohibitedContent", "retention"].every(
      (key) => verified[key as keyof CheckoutLegalDocuments],
    )
  ) {
    return null;
  }
  return {
    termsRevision: documents.termsRevision,
    claimPolicyRevision: documents.claimPolicyRevision,
    photoConsentRevision:
      documents.photoConsentRevision ===
        availability?.documents.photoConsent.revision &&
      isServerVerifiedLegalDocument(
        "photoConsent",
        local.photoConsent,
        availability,
      ) &&
      verified.photoConsent
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
