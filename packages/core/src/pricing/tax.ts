import { DomainError } from "../primitives/errors.js";
import { Money } from "../primitives/money.js";

const BASIS_POINTS = 10_000;

export type SellerTaxRegime = "NON_VAT_PAYER" | "VAT_PAYER";

export interface SellerTaxPolicy {
  readonly regime: SellerTaxRegime;
  readonly vatRateBasisPoints: number;
}

export interface CustomerTaxBreakdown {
  readonly regime: SellerTaxRegime;
  readonly vatRateBasisPoints: number;
  readonly net: Money;
  readonly vat: Money;
  readonly gross: Money;
}

export function validateSellerTaxPolicy(policy: SellerTaxPolicy): void {
  if (
    !Number.isSafeInteger(policy.vatRateBasisPoints) ||
    policy.vatRateBasisPoints < 0 ||
    policy.vatRateBasisPoints > BASIS_POINTS
  ) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "VAT rate must be an integer between 0 and 10000 basis points",
    );
  }
  if (
    (policy.regime === "NON_VAT_PAYER" && policy.vatRateBasisPoints !== 0) ||
    (policy.regime === "VAT_PAYER" && policy.vatRateBasisPoints === 0)
  ) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "a non-VAT payer requires a zero VAT rate and a VAT payer requires a positive VAT rate",
    );
  }
  if (policy.regime !== "NON_VAT_PAYER" && policy.regime !== "VAT_PAYER") {
    throw new DomainError("INVALID_ARGUMENT", "unsupported seller tax regime");
  }
}

/** Applies VAT to a known net amount using half-up minor-unit rounding. */
export function taxBreakdownFromNet(
  net: Money,
  policy: SellerTaxPolicy,
): CustomerTaxBreakdown {
  validateSellerTaxPolicy(policy);
  const vat = net.multiply(policy.vatRateBasisPoints, BASIS_POINTS, "half-up");
  return {
    regime: policy.regime,
    vatRateBasisPoints: policy.vatRateBasisPoints,
    net,
    vat,
    gross: net.add(vat),
  };
}

/** Extracts VAT from a known tax-inclusive amount using half-up rounding. */
export function taxBreakdownFromGross(
  gross: Money,
  policy: SellerTaxPolicy,
): CustomerTaxBreakdown {
  validateSellerTaxPolicy(policy);
  const vat = gross.multiply(
    policy.vatRateBasisPoints,
    BASIS_POINTS + policy.vatRateBasisPoints,
    "half-up",
  );
  return {
    regime: policy.regime,
    vatRateBasisPoints: policy.vatRateBasisPoints,
    net: gross.subtract(vat),
    vat,
    gross,
  };
}
