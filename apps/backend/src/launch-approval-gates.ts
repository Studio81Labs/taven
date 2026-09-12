import { ServiceUnavailableException } from "@nestjs/common";
import {
  assertEffectiveLegalDocuments,
  type EvaluatedLegalApprovals,
} from "./modules/legal-approvals/legal-approvals.catalog";

export const BINDING_QUOTE_FLOWS_ENV =
  "TAVEN_BINDING_QUOTE_FLOWS_ENABLED" as const;
export const QUOTE_PHOTO_UPLOADS_ENV =
  "TAVEN_QUOTE_PHOTO_UPLOADS_ENABLED" as const;
export const CHECKOUT_PAYMENT_FLOWS_ENV =
  "TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED" as const;
export const CHECKOUT_CLAIM_POLICY_REVISION_ENV =
  "TAVEN_CLAIM_POLICY_REVISION" as const;
export const CHECKOUT_CLAIM_WINDOW_DAYS_ENV =
  "TAVEN_CLAIM_WINDOW_DAYS" as const;
export const CHECKOUT_TERMS_REVISION_ENV = "TAVEN_TERMS_REVISION" as const;
export const CHECKOUT_PHOTO_CONSENT_REVISION_ENV =
  "TAVEN_PHOTO_CONSENT_REVISION" as const;

const LAUNCH_APPROVAL_REQUIRED = "LAUNCH_APPROVAL_REQUIRED";

function isExplicitlyEnabled(
  env: NodeJS.ProcessEnv,
  name:
    | typeof BINDING_QUOTE_FLOWS_ENV
    | typeof QUOTE_PHOTO_UPLOADS_ENV
    | typeof CHECKOUT_PAYMENT_FLOWS_ENV,
): boolean {
  return env[name] === "true";
}

function launchApprovalRequired(message: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: LAUNCH_APPROVAL_REQUIRED,
    message,
  });
}

export function assertBindingQuoteFlowsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isExplicitlyEnabled(env, BINDING_QUOTE_FLOWS_ENV)) {
    throw launchApprovalRequired(
      "Binding quote and offer flows are unavailable until launch inputs are approved",
    );
  }
}

export function assertQuotePhotoUploadsEnabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isExplicitlyEnabled(env, QUOTE_PHOTO_UPLOADS_ENV)) {
    throw launchApprovalRequired(
      "Quote photo uploads are unavailable until their retention policy is approved",
    );
  }
}

export function assertCheckoutPaymentFlowsEnabled(
  boundTermsRevision: string,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<{
  claimPolicyRevision: string;
  claimWindowDays: number;
  termsRevision: string;
}> {
  if (!isExplicitlyEnabled(env, CHECKOUT_PAYMENT_FLOWS_ENV)) {
    throw launchApprovalRequired(
      "Checkout payment flows are unavailable until legal documents and provider launch inputs are approved",
    );
  }
  const termsRevision = approvedCheckoutTermsRevision(env);
  if (boundTermsRevision !== termsRevision) {
    throw launchApprovalRequired(
      "Checkout price binding does not use the approved terms revision",
    );
  }
  return {
    claimPolicyRevision: approvedCheckoutClaimPolicyRevision(env),
    claimWindowDays: approvedCheckoutClaimWindowDays(env),
    termsRevision,
  };
}

export function assertCheckoutAcceptanceRevisionsCurrent(
  accepted: Readonly<{
    termsRevision: string | null;
    claimPolicyRevision: string | null;
    claimWindowDays: number | null;
  }>,
  approved: Readonly<{
    termsRevision: string;
    claimPolicyRevision: string;
    claimWindowDays: number;
  }>,
): void {
  const hasAcceptedLegalSnapshot =
    accepted.termsRevision !== null ||
    accepted.claimPolicyRevision !== null ||
    accepted.claimWindowDays !== null;
  if (
    (hasAcceptedLegalSnapshot &&
      (accepted.termsRevision === null ||
        accepted.claimPolicyRevision === null ||
        accepted.claimWindowDays === null)) ||
    (accepted.termsRevision !== null &&
      accepted.termsRevision !== approved.termsRevision) ||
    (accepted.claimPolicyRevision !== null &&
      accepted.claimPolicyRevision !== approved.claimPolicyRevision) ||
    (accepted.claimWindowDays !== null &&
      accepted.claimWindowDays !== approved.claimWindowDays)
  ) {
    throw launchApprovalRequired(
      "Checkout acceptance does not use the currently approved legal revisions",
    );
  }
}

export function assertCheckoutClaimPolicyRevisionCurrent(
  requestedRevision: string,
  approvedRevision: string,
): void {
  if (requestedRevision !== approvedRevision) {
    throw launchApprovalRequired(
      "Checkout request does not use the currently approved claim-policy revision",
    );
  }
}

export function assertCheckoutTermsRevisionCurrent(
  requestedRevision: string,
  approvedRevision: string,
): void {
  if (requestedRevision !== approvedRevision) {
    throw launchApprovalRequired(
      "Checkout request does not use the currently approved terms revision",
    );
  }
}

export function assertCheckoutPaymentMethodsAvailable(
  availableMethods: readonly string[],
): void {
  if (
    !availableMethods.includes("CARD") ||
    !availableMethods.includes("BANK_TRANSFER")
  ) {
    throw launchApprovalRequired(
      "Checkout payment flows require card and bank-transfer provider capabilities",
    );
  }
}

export function checkoutPaymentLaunchInputsApproved(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    isExplicitlyEnabled(env, CHECKOUT_PAYMENT_FLOWS_ENV) &&
    approvedCheckoutRevision(env[CHECKOUT_TERMS_REVISION_ENV]) !== null &&
    approvedCheckoutRevision(env[CHECKOUT_CLAIM_POLICY_REVISION_ENV]) !==
      null &&
    approvedCheckoutClaimWindowDaysOrNull(env) !== null
  );
}

export function checkoutPaymentLegalDocuments(
  env: NodeJS.ProcessEnv = process.env,
  approvals?: EvaluatedLegalApprovals,
): Readonly<{
  termsRevision: string;
  claimPolicyRevision: string;
  photoConsentRevision: string | null;
}> | null {
  if (!checkoutPaymentLaunchInputsApproved(env) || !approvals) return null;
  try {
    assertEffectiveLegalDocuments(approvals, [
      "terms",
      "claims",
      "privacy",
      "prohibitedContent",
      "retention",
    ]);
  } catch {
    return null;
  }
  const termsRevision = approvedCheckoutTermsRevision(env);
  const claimPolicyRevision = approvedCheckoutClaimPolicyRevision(env);
  if (
    approvals.documents.terms.revision !== termsRevision ||
    approvals.documents.claims.revision !== claimPolicyRevision
  )
    return null;
  return {
    termsRevision,
    claimPolicyRevision,
    photoConsentRevision:
      approvals.documents.photoConsent.effective &&
      approvals.documents.photoConsent.revision ===
        approvedCheckoutRevision(env[CHECKOUT_PHOTO_CONSENT_REVISION_ENV])
        ? approvals.documents.photoConsent.revision
        : null,
  };
}

export function assertEffectiveCheckoutLegalDocuments(
  approvals: EvaluatedLegalApprovals,
  env: NodeJS.ProcessEnv = process.env,
): Readonly<{
  termsRevision: string;
  claimPolicyRevision: string;
  claimWindowDays: number;
}> {
  const documents = checkoutPaymentLegalDocuments(env, approvals);
  if (!documents) {
    throw launchApprovalRequired(
      "Checkout payment flows require effective legal approval metadata",
    );
  }
  return {
    termsRevision: documents.termsRevision,
    claimPolicyRevision: documents.claimPolicyRevision,
    claimWindowDays: approvedCheckoutClaimWindowDays(env),
  };
}

export function assertEffectiveQuoteRequestLegalDocuments(
  approvals: EvaluatedLegalApprovals,
  photoPublicationConsent: boolean,
): void {
  assertEffectiveLegalDocuments(approvals, ["privacy", "retention"]);
  if (photoPublicationConsent)
    assertEffectiveLegalDocuments(approvals, ["photoConsent"]);
}

export function assertEffectiveCheckoutPhotoConsent(
  approvals: EvaluatedLegalApprovals,
  requestedRevision: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertEffectiveLegalDocuments(approvals, ["photoConsent"]);
  assertCheckoutPhotoConsentRevisionCurrent(requestedRevision, env);
  if (approvals.documents.photoConsent.revision !== requestedRevision) {
    throw launchApprovalRequired(
      "Checkout request does not use the effective photo-consent revision",
    );
  }
}

export function assertCheckoutPhotoConsentRevisionCurrent(
  requestedRevision: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const approvedRevision = approvedCheckoutRevision(
    env[CHECKOUT_PHOTO_CONSENT_REVISION_ENV],
  );
  if (!approvedRevision || requestedRevision !== approvedRevision) {
    throw launchApprovalRequired(
      "Checkout request does not use the currently approved photo-consent revision",
    );
  }
}

export function approvedCheckoutTermsRevision(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const revision = approvedCheckoutRevision(env[CHECKOUT_TERMS_REVISION_ENV]);
  if (!revision) {
    throw launchApprovalRequired(
      "Checkout payment flows require an explicit approved terms revision",
    );
  }
  return revision;
}

export function approvedCheckoutClaimPolicyRevision(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const revision = approvedCheckoutRevision(
    env[CHECKOUT_CLAIM_POLICY_REVISION_ENV],
  );
  if (!revision) {
    throw launchApprovalRequired(
      "Checkout payment flows require an explicit approved claim-policy revision",
    );
  }
  return revision;
}

export function approvedCheckoutClaimWindowDays(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const days = approvedCheckoutClaimWindowDaysOrNull(env);
  if (days === null) {
    throw launchApprovalRequired(
      "Checkout payment flows require an explicit approved Claim window",
    );
  }
  return days;
}

function approvedCheckoutClaimWindowDaysOrNull(
  env: NodeJS.ProcessEnv,
): number | null {
  const raw = env[CHECKOUT_CLAIM_WINDOW_DAYS_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const days = Number(raw);
  return Number.isSafeInteger(days) && days > 0 && days <= 3_650 ? days : null;
}

function approvedCheckoutRevision(value: string | undefined): string | null {
  const revision = value?.trim();
  if (
    !revision ||
    revision.length > 100 ||
    /(?:^|[-_.\s])(draft|pending)(?:$|[-_.\s])/i.test(revision)
  ) {
    return null;
  }
  return revision;
}
