import { commercialContentApproval } from "../content/launch-approvals";
import { legalDocuments } from "../content/launch-manifest";
import {
  hasEffectiveAutomaticQuoteDocuments,
  isAutomaticQuoteEnabled,
} from "../utils/automatic-quote-launch";
import { useLegalAvailability } from "./useLegalAvailability";

export function useAutomaticQuoteEnabled() {
  const config = useRuntimeConfig();
  const { availability, refresh } = useLegalAvailability();
  onMounted(() => void refresh());
  return computed(() =>
    isAutomaticQuoteEnabled({
      runtimeEnabled: config.public.automaticQuoteEnabled,
      hasApprovedAcquisitionDocuments: hasEffectiveAutomaticQuoteDocuments(
        legalDocuments,
        availability.value,
      ),
      hasApprovedCommercialContent:
        commercialContentApproval.status === "approved",
    }),
  );
}
