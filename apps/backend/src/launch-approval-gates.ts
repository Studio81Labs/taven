import { ServiceUnavailableException } from "@nestjs/common";

export const BINDING_QUOTE_FLOWS_ENV =
  "TAVEN_BINDING_QUOTE_FLOWS_ENABLED" as const;
export const QUOTE_PHOTO_UPLOADS_ENV =
  "TAVEN_QUOTE_PHOTO_UPLOADS_ENABLED" as const;
export const CHECKOUT_PAYMENT_FLOWS_ENV =
  "TAVEN_CHECKOUT_PAYMENT_FLOWS_ENABLED" as const;
export const CHECKOUT_CLAIM_POLICY_REVISION_ENV =
  "TAVEN_CLAIM_POLICY_REVISION" as const;

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
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (!isExplicitlyEnabled(env, CHECKOUT_PAYMENT_FLOWS_ENV)) {
    throw launchApprovalRequired(
      "Checkout payment flows are unavailable until legal documents and provider launch inputs are approved",
    );
  }
  return approvedCheckoutClaimPolicyRevision(env);
}

export function approvedCheckoutClaimPolicyRevision(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const revision = env[CHECKOUT_CLAIM_POLICY_REVISION_ENV]?.trim();
  if (
    !revision ||
    revision.length > 100 ||
    /(?:^|[-_.\s])(draft|pending)(?:$|[-_.\s])/i.test(revision)
  ) {
    throw launchApprovalRequired(
      "Checkout payment flows require an explicit approved claim-policy revision",
    );
  }
  return revision;
}
