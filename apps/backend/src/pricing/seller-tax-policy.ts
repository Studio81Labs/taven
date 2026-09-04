import type { Prisma } from "@prisma/client";
import type { SellerTaxPolicy } from "@taven/core" with {
  "resolution-mode": "import",
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown, name: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as JsonRecord;
}

function basisPoints(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 10_000
  ) {
    throw new Error(
      "sellerTaxPolicy.vatRateBasisPoints must be an integer between 0 and 10000",
    );
  }
  return value;
}

export function parseSellerTaxPolicy(
  parameters: Prisma.JsonValue,
): SellerTaxPolicy {
  const root = record(parameters, "priceList.parameters");
  const configured = record(root.sellerTaxPolicy, "parameters.sellerTaxPolicy");
  const regime = configured.regime;
  const vatRateBasisPoints = basisPoints(configured.vatRateBasisPoints);
  if (regime === "NON_VAT_PAYER" && vatRateBasisPoints === 0) {
    return { regime, vatRateBasisPoints };
  }
  if (regime === "VAT_PAYER" && vatRateBasisPoints > 0) {
    return { regime, vatRateBasisPoints };
  }
  throw new Error("parameters.sellerTaxPolicy is inconsistent");
}
