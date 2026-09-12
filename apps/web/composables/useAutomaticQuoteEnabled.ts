import {
  commercialContentApproval,
  legalDocumentApprovals,
} from "../content/launch-approvals";
import {
  hasEffectiveAutomaticQuoteDocuments,
  isAutomaticQuoteEnabled,
} from "../utils/automatic-quote-launch";

export function useAutomaticQuoteEnabled() {
  const config = useRuntimeConfig();
  return computed(() =>
    isAutomaticQuoteEnabled({
      runtimeEnabled: config.public.automaticQuoteEnabled,
      hasApprovedAcquisitionDocuments: hasEffectiveAutomaticQuoteDocuments(
        legalDocumentApprovals,
      ),
      hasApprovedCommercialContent:
        commercialContentApproval.status === "approved",
    }),
  );
}
