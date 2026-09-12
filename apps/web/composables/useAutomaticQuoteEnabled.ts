import { commercialContentApproval } from "../content/launch-approvals";
import { legalDocuments } from "../content/launch-manifest";
import {
  hasEffectiveAutomaticQuoteDocuments,
  isAutomaticQuoteEnabled,
} from "../utils/automatic-quote-launch";

export function useAutomaticQuoteEnabled() {
  const config = useRuntimeConfig();
  return computed(() =>
    isAutomaticQuoteEnabled({
      runtimeEnabled: config.public.automaticQuoteEnabled,
      hasApprovedAcquisitionDocuments:
        hasEffectiveAutomaticQuoteDocuments(legalDocuments),
      hasApprovedCommercialContent:
        commercialContentApproval.status === "approved",
    }),
  );
}
