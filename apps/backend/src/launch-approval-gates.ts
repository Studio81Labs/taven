import { ServiceUnavailableException } from "@nestjs/common";

export const BINDING_QUOTE_FLOWS_ENV =
  "TAVEN_BINDING_QUOTE_FLOWS_ENABLED" as const;
export const QUOTE_PHOTO_UPLOADS_ENV =
  "TAVEN_QUOTE_PHOTO_UPLOADS_ENABLED" as const;

const LAUNCH_APPROVAL_REQUIRED = "LAUNCH_APPROVAL_REQUIRED";

function isExplicitlyEnabled(
  env: NodeJS.ProcessEnv,
  name: typeof BINDING_QUOTE_FLOWS_ENV | typeof QUOTE_PHOTO_UPLOADS_ENV,
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
