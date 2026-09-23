import { ServiceUnavailableException } from "@nestjs/common";
import {
  Prisma,
  type CommercialPolicySelection,
  type PriceList,
} from "@prisma/client";

type Database = Prisma.TransactionClient;
export type SelectedCommercialPolicy = CommercialPolicySelection & {
  priceList: PriceList;
};

/** Advisory reads use one selector-to-immutable-list snapshot. */
export async function currentCommercialPolicy(
  database: Database,
  currency = "CZK",
): Promise<SelectedCommercialPolicy> {
  const selection = await database.commercialPolicySelection.findUnique({
    where: { currency },
    include: { priceList: true },
  });
  if (!selection) {
    throw new ServiceUnavailableException(
      "Commercial policy selection is unavailable",
    );
  }
  return selection;
}

/** Call after idempotency and legal locks, before any session/order lock. */
export async function lockCommercialPolicy(
  transaction: Database,
  currency = "CZK",
): Promise<SelectedCommercialPolicy> {
  const rows = await transaction.$queryRaw<Array<{ currency: string }>>`
    SELECT "currency" FROM "commercial_policy_selections"
    WHERE "currency" = ${currency} FOR SHARE
  `;
  if (rows.length !== 1) {
    throw new ServiceUnavailableException(
      "Commercial policy selection is unavailable",
    );
  }
  const selected = await currentCommercialPolicy(transaction, currency);
  await transaction.$queryRaw`
    SELECT set_config('taven.commercial_policy_selection_version',
      ${String(selected.selectionVersion)}, true)
  `;
  return selected;
}
