import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { PrismaPg } from "../../apps/backend/node_modules/@prisma/adapter-pg/dist/index.mjs";
import { PrismaClient } from "../../apps/backend/node_modules/@prisma/client/default.js";
import { prepareAutomaticQuote } from "../../apps/backend/src/modules/automatic-quotes/automatic-quote-pricing";

type CorpusCase = {
  fixture: string;
  geometrySha256: string;
  dimensionsMm: { width: number; depth: number; height: number };
  volumeMm3: number;
  material: string;
  quality: string;
  infillPreset: string;
  sparseInfillDensityPercent: number;
  quantity: number;
  estimatedSeconds: number;
  filamentUsageGrams: number;
  normalizedGcodeSha256: string;
  slicer: string;
  runtimeImageDigest: string;
  profileBundleSha256: string;
  printConfigRevisionId: string;
  referenceProfileId: string;
};

type EstimateResponse = {
  price: { totalMinor: number };
  priceListRevision: string;
  assumptions: Record<string, unknown>;
};

const endpoint =
  process.env.TAVEN_ESTIMATE_URL ??
  "https://api-staging.taven.cz/automatic-quote-estimates";
const sampleCount = Number(process.env.TAVEN_BENCHMARK_SAMPLES ?? 4);
const request = {
  volumeMm3: 8_000,
  dimensionsMm: { width: 20, depth: 20, height: 20 },
  material: "PLA",
  quality: "STANDARD",
  infillPreset: "STANDARD",
  quantity: 1,
};

if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 4) {
  throw new Error("TAVEN_BENCHMARK_SAMPLES must be an integer between 1 and 4");
}

const corpus = JSON.parse(
  await readFile(
    new URL("./standard-cube-slice.json", import.meta.url),
    "utf8",
  ),
) as CorpusCase;
if (
  corpus.material !== request.material ||
  corpus.quality !== request.quality ||
  corpus.infillPreset !== request.infillPreset ||
  corpus.sparseInfillDensityPercent !== 20
) {
  throw new Error("benchmark slice does not match the STANDARD request");
}

const samples: number[] = [];
let estimate: EstimateResponse;
await fetchEstimate();
for (let index = 0; index < sampleCount; index += 1) {
  const started = performance.now();
  estimate = await fetchEstimate();
  samples.push(performance.now() - started);
}

if (estimate.assumptions.referenceProfileId !== corpus.referenceProfileId) {
  throw new Error("estimate selected an unexpected reference profile");
}
if (
  estimate.assumptions.printConfigRevisionId !== corpus.printConfigRevisionId
) {
  throw new Error("estimate selected an unexpected print configuration");
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error("DATABASE_URL is required for slice comparison");
process.env.DATABASE_URL = databaseUrl;
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
try {
  const priceList = await prisma.priceList.findUniqueOrThrow({
    where: {
      currency_revision: { currency: "CZK", revision: "automatic-v0-czk" },
    },
  });
  const prepared = await prepareAutomaticQuote({
    priceList,
    items: [
      {
        id: "single-pla-cube",
        referenceProfileId: estimate.assumptions.referenceProfileId,
        material: "PLA",
        quantity: 1,
        referencePartsPerPlate: 1,
        primary: {
          estimatedPrintSeconds: BigInt(corpus.estimatedSeconds),
          estimatedMaterialMilligrams: BigInt(
            Math.round(corpus.filamentUsageGrams * 1_000),
          ),
        },
        tail: null,
        boundsXMicrometers: 20_000n,
        boundsYMicrometers: 20_000n,
        boundsZMicrometers: 20_000n,
        fulfilmentSlots: [{ packingUnitKey: "single-pla-cube:1" }],
      },
    ],
    expressRequested: false,
    materialAndColorAvailable: true,
    withinBuildLimits: true,
    riskAcknowledgementsComplete: true,
    hasBlockingPreflightFinding: false,
  });
  const estimateMinor = Number(estimate.price.totalMinor);
  const sliceMinor = Number(prepared.prepared.price.customerTotal.minorUnits);
  const deltaPercent = ((estimateMinor - sliceMinor) / sliceMinor) * 100;
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (value: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))]!;

  console.log(
    JSON.stringify(
      {
        endpoint,
        fixture: {
          file: corpus.fixture,
          geometrySha256: corpus.geometrySha256,
          dimensionsMm: corpus.dimensionsMm,
          volumeMm3: corpus.volumeMm3,
          material: corpus.material,
          quality: corpus.quality,
          infillPreset: corpus.infillPreset,
          sparseInfillDensityPercent: corpus.sparseInfillDensityPercent,
          quantity: corpus.quantity,
          slicerEstimatedSeconds: corpus.estimatedSeconds,
          slicerFilamentGrams: corpus.filamentUsageGrams,
          normalizedGcodeSha256: corpus.normalizedGcodeSha256,
          slicerEngine: corpus.slicer,
          runtimeImageDigest: corpus.runtimeImageDigest,
          profileBundleSha256: corpus.profileBundleSha256,
        },
        assumptions: estimate.assumptions,
        priceListRevision: estimate.priceListRevision,
        estimateTotalMinor: estimateMinor,
        sliceDerivedTotalMinor: sliceMinor,
        deltaPercent: Number(deltaPercent.toFixed(2)),
        latencyMs: {
          samples: samples.map((value) => Number(value.toFixed(2))),
          median: Number(percentile(0.5).toFixed(2)),
          p95: Number(percentile(0.95).toFixed(2)),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await prisma.$disconnect();
}

async function fetchEstimate(): Promise<EstimateResponse> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `Estimate request failed (${response.status}): ${JSON.stringify(body)}`,
    );
  }
  return body;
}
