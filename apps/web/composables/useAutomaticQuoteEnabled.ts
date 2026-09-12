import {
  commercialContentApproval,
  legalDocumentApprovals,
} from "../content/launch-approvals";
import { isAutomaticQuoteEnabled } from "../utils/automatic-quote-launch";

export function useAutomaticQuoteEnabled() {
  const config = useRuntimeConfig();
  return computed(() =>
    isAutomaticQuoteEnabled({
      runtimeEnabled: config.public.automaticQuoteEnabled,
      hasApprovedCheckoutDocuments:
        legalDocumentApprovals.terms.status === "approved" &&
        legalDocumentApprovals.claims.status === "approved",
      hasApprovedCommercialContent:
        commercialContentApproval.status === "approved",
    }),
  );
}
