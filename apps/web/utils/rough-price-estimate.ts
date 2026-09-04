export const CLIENT_ROUGH_ESTIMATE_REVISION = "automatic-v0-czk";

const parameters = {
  materialDensity: { numerator: 124n, denominator: 100n },
  materialVolumeRatio: { numerator: 20n, denominator: 100n },
  extrusionMilligramsPerSecond: { numerator: 5n, denominator: 1n },
  materialRateMinorPerMilligram: { numerator: 1n, denominator: 20n },
  machineRateMinorPerSecond: { numerator: 1n, denominator: 2n },
  laborRateMinorPerSecond: { numerator: 25n, denominator: 3n },
  handlingOrderFixedSeconds: 180n,
  handlingPlateSeconds: 120n,
  handlingPieceSeconds: 30n,
  reprintRate: { numerator: 5n, denominator: 100n },
  marginRate: { numerator: 30n, denominator: 100n },
  minimumPrintPriceMinor: 25_000n,
  smallOrderWeightThresholdMilligrams: 100_000n,
  smallOrderSurchargeMinor: 5_000n,
  uncertainty: { numerator: 20n, denominator: 100n },
} as const;

export interface ClientRoughPriceEstimate {
  currency: "CZK";
  lowerMinor: number;
  revision: typeof CLIENT_ROUGH_ESTIMATE_REVISION;
  upperMinor: number;
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function rational(
  value: bigint,
  rate: { numerator: bigint; denominator: bigint },
): bigint {
  return ceilDivide(value * rate.numerator, rate.denominator);
}

/**
 * Replays the default one-piece PLA/standard-infill proxy from the versioned
 * automatic price list. It deliberately excludes delivery and remains a range;
 * only the server-side reference slice can produce the precise price.
 */
export function clientRoughPriceEstimate(
  volumeCubicMillimeters: number,
): ClientRoughPriceEstimate | null {
  const scaledVolume = volumeCubicMillimeters * 1_000;
  if (
    !Number.isFinite(scaledVolume) ||
    scaledVolume <= 0 ||
    !Number.isSafeInteger(Math.ceil(scaledVolume))
  ) {
    return null;
  }

  const volumeThousandths = BigInt(Math.ceil(scaledVolume));
  const materialMilligrams = ceilDivide(
    volumeThousandths *
      parameters.materialDensity.numerator *
      parameters.materialVolumeRatio.numerator,
    1_000n *
      parameters.materialDensity.denominator *
      parameters.materialVolumeRatio.denominator,
  );
  const printSeconds = ceilDivide(
    materialMilligrams * parameters.extrusionMilligramsPerSecond.denominator,
    parameters.extrusionMilligramsPerSecond.numerator,
  );
  const materialCost = rational(
    materialMilligrams,
    parameters.materialRateMinorPerMilligram,
  );
  const machineCost = rational(
    printSeconds,
    parameters.machineRateMinorPerSecond,
  );
  const itemHandling = rational(
    parameters.handlingPlateSeconds + parameters.handlingPieceSeconds,
    parameters.laborRateMinorPerSecond,
  );
  const directCost = materialCost + machineCost + itemHandling;
  const reprintReserve = rational(directCost, parameters.reprintRate);
  const orderHandling = rational(
    parameters.handlingOrderFixedSeconds,
    parameters.laborRateMinorPerSecond,
  );
  const printBeforeMinimum = rational(
    directCost + reprintReserve + orderHandling,
    {
      numerator:
        parameters.marginRate.denominator + parameters.marginRate.numerator,
      denominator: parameters.marginRate.denominator,
    },
  );
  const basePrintPrice =
    printBeforeMinimum > parameters.minimumPrintPriceMinor
      ? printBeforeMinimum
      : parameters.minimumPrintPriceMinor;
  const smallOrderSurcharge =
    materialMilligrams < parameters.smallOrderWeightThresholdMilligrams
      ? parameters.smallOrderSurchargeMinor
      : 0n;
  const midpoint = basePrintPrice + smallOrderSurcharge;
  const uncertainty = rational(midpoint, parameters.uncertainty);
  const lower = midpoint > uncertainty ? midpoint - uncertainty : 0n;
  const upper = midpoint + uncertainty;

  if (
    lower > BigInt(Number.MAX_SAFE_INTEGER) ||
    upper > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }

  return {
    currency: "CZK",
    lowerMinor: Number(lower),
    revision: CLIENT_ROUGH_ESTIMATE_REVISION,
    upperMinor: Number(upper),
  };
}
