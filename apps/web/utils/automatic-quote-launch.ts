export function isAutomaticQuoteEnabled(input: {
  runtimeEnabled: unknown;
  hasApprovedCheckoutDocuments: boolean;
  hasApprovedCommercialContent: boolean;
}): boolean {
  return (
    (input.runtimeEnabled === true || input.runtimeEnabled === "true") &&
    input.hasApprovedCheckoutDocuments &&
    input.hasApprovedCommercialContent
  );
}
