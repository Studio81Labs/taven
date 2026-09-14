import { SetMetadata } from "@nestjs/common";

export const TRANSLATE_DATASTORE_AVAILABILITY_KEY =
  "translate-datastore-availability";

/**
 * Maps authentication datastore failures to 503 for routes whose contract
 * explicitly advertises legal datastore availability.
 */
export const TranslateDatastoreAvailability = () =>
  SetMetadata(TRANSLATE_DATASTORE_AVAILABILITY_KEY, true);
