import { ProductionArtifactFormat as PersistedProductionArtifactFormat } from "@prisma/client";
import type { ProductionArtifactFormat } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};

export function toSlicerProductionArtifactFormat(
  format: PersistedProductionArtifactFormat,
): ProductionArtifactFormat {
  switch (format) {
    case PersistedProductionArtifactFormat.GCODE_3MF:
      return "gcode_3mf";
    case PersistedProductionArtifactFormat.BGCODE:
      return "bgcode";
    case PersistedProductionArtifactFormat.GCODE:
      return "gcode";
  }
}
