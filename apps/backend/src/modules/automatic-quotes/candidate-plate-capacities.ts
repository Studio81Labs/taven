import type { ProductionArtifactFormat } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};

const MAX_CANDIDATE_PLATE_COUNT = 36;

export function candidatePlateCapacities(
  quantity: number,
  artifactFormat: ProductionArtifactFormat,
): number[] {
  if (artifactFormat === "bgcode") return [];
  if (artifactFormat === "gcode") return [quantity];
  // Probe logarithmically spaced plate counts plus the contract ceiling. The
  // final capacity guarantees that any monotonic Orca arrangement representable
  // within 36 plates has at least one feasible candidate.
  const maximumPlateCount = Math.min(quantity, MAX_CANDIDATE_PLATE_COUNT);
  const plateCounts = new Set<number>([maximumPlateCount]);
  for (let plateCount = 1; plateCount < maximumPlateCount; plateCount *= 2) {
    plateCounts.add(plateCount);
  }
  return [
    ...new Set(
      [...plateCounts].map((plateCount) => Math.ceil(quantity / plateCount)),
    ),
  ].sort((left, right) => right - left);
}
