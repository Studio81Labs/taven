import type { Prisma } from "@prisma/client";

type OrcaPreset = Record<string, Prisma.JsonValue>;

const deniedKeys = new Set(["post_process", "print_host", "bbl_use_printhost"]);

export class PresetBundleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetBundleValidationError";
  }
}

function invalid(message: string): never {
  throw new PresetBundleValidationError(message);
}

function isPreset(value: Prisma.JsonValue): value is OrcaPreset {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSafe(value: Prisma.JsonValue): void {
  if (Array.isArray(value)) {
    value.forEach(assertSafe);
    return;
  }
  if (!isPreset(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (deniedKeys.has(normalized) || normalized.startsWith("printhost_")) {
      invalid(`Orca preset key ${key} is not permitted`);
    }
    assertSafe(child);
  }
}

function kind(
  preset: OrcaPreset,
): "machine" | "process" | "filament" | "override" {
  if (preset.type === "machine") return "machine";
  if (preset.type === "process") return "process";
  if (preset.type === "filament" || "filament_settings_id" in preset)
    return "filament";
  if (preset.type !== undefined) invalid("Orca preset has an unsupported type");
  return "override";
}

function presets(value: Prisma.JsonValue): OrcaPreset[] {
  if (!isPreset(value) || !Array.isArray(value.presets)) {
    invalid("Slicer revision settings must be a version 1 preset bundle");
  }
  if (!value.presets.every(isPreset)) {
    invalid("Slicer preset bundle must contain preset objects");
  }
  return value.presets;
}

export function assertRevisionPresetBundle(
  value: Prisma.JsonValue,
  revision: "reference" | "machine" | "print" | "calibration",
): void {
  if (
    !isPreset(value) ||
    value.bundleVersion !== 1 ||
    !Array.isArray(value.presets)
  ) {
    invalid("Slicer revision settings must be a version 1 preset bundle");
  }
  if (value.presets.length === 0 || !value.presets.every(isPreset)) {
    invalid("Slicer preset bundle must contain preset objects");
  }
  assertSafe(value);
  const kinds = value.presets.map(kind);
  if (revision === "reference" || revision === "machine") {
    if (
      kinds.length < 3 ||
      kinds[0] !== "machine" ||
      kinds[1] !== "process" ||
      !kinds.slice(2).every((entry) => entry === "filament")
    ) {
      invalid(
        "Machine and reference bundles must order machine, process, then filament presets",
      );
    }
  } else if (!kinds.every((entry) => entry === "override")) {
    invalid(`${revision} bundles may contain override presets only`);
  }
}

/** Matches the worker's single-digit sidecar filename limit before dispatch. */
export function assertPresetBundleAggregateLimits(
  values: readonly Prisma.JsonValue[],
): void {
  let settings = 0;
  let filaments = 0;
  for (const value of values) {
    for (const preset of presets(value)) {
      if (kind(preset) === "filament") filaments += 1;
      else settings += 1;
    }
  }
  if (settings === 0 || settings >= 10 || filaments >= 10) {
    invalid(
      "Slicer preset bundle must contain one through nine settings and filament presets",
    );
  }
}
