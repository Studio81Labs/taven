import type { components } from "@taven/openapi-client";
import {
  isLegalAvailability,
  type LegalAvailability,
} from "../utils/legal-availability";

type AvailabilityResponse =
  components["schemas"]["LegalDocumentAvailabilityDto"];

export function useLegalAvailability() {
  const { $api } = useNuxtApp();
  const availability = useState<LegalAvailability | null>(
    "legal-document-availability",
    () => null,
  );
  const pending = useState("legal-document-availability-pending", () => false);
  const refreshGeneration = useState(
    "legal-document-availability-refresh-generation",
    () => 0,
  );

  async function refresh(): Promise<LegalAvailability | null> {
    const generation = ++refreshGeneration.value;
    pending.value = true;
    try {
      const response = await Promise.race([
        $api.GET("/legal-documents/availability"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1_000),
        ),
      ]);
      const value = isLegalAvailability(response.data)
        ? (response.data as AvailabilityResponse)
        : null;
      if (generation === refreshGeneration.value)
        availability.value = value ?? null;
      return generation === refreshGeneration.value ? availability.value : null;
    } catch {
      if (generation === refreshGeneration.value) availability.value = null;
      return null;
    } finally {
      if (generation === refreshGeneration.value) pending.value = false;
    }
  }

  return {
    availability: readonly(availability),
    pending: readonly(pending),
    refresh,
  };
}
