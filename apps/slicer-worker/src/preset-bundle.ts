import { SlicingWorkerError } from "./failures.js";

export type OrcaPreset = Record<string, unknown>;
export type PresetBundle = {
  bundleVersion: 1;
  presets: readonly OrcaPreset[];
};

export type RevisionPresetBundle = {
  kind: "reference" | "machine" | "print" | "calibration";
  presets: readonly OrcaPreset[];
};

export type MaterializedPresetBundle = {
  settings: readonly [OrcaPreset, OrcaPreset];
  filaments: readonly OrcaPreset[];
};

const deniedKeys = new Set(["post_process", "print_host", "bbl_use_printhost"]);

function invalid(message: string): never {
  throw new SlicingWorkerError(
    "deterministic_invalid",
    "INVALID_PROFILE",
    message,
  );
}

function isPreset(value: unknown): value is OrcaPreset {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertSafe(value: unknown): void {
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
  if (
    "filament_settings_id" in preset &&
    preset.type !== undefined &&
    preset.type !== "filament"
  ) {
    invalid("Orca preset has conflicting type and filament settings markers");
  }
  if (preset.type === "machine") return "machine";
  if (preset.type === "process") return "process";
  if (preset.type === "filament" || "filament_settings_id" in preset) {
    return "filament";
  }
  if (preset.type !== undefined) invalid("Orca preset has an unsupported type");
  return "override";
}

export function parsePresetBundle(value: unknown): PresetBundle {
  if (
    !isPreset(value) ||
    value.bundleVersion !== 1 ||
    !Array.isArray(value.presets)
  ) {
    invalid("Slicer revision settings must be a version 1 preset bundle");
  }
  if (value.presets.length === 0)
    invalid("Slicer preset bundle must not be empty");
  const presets = value.presets;
  if (!presets.every(isPreset))
    invalid("Slicer preset bundle contains a non-object preset");
  assertSafe(value);
  return { bundleVersion: 1, presets };
}

export function classifyPreset(preset: OrcaPreset) {
  return kind(preset);
}

export function validateRevisionBundle(
  value: unknown,
  revision: "reference" | "machine" | "print" | "calibration",
): PresetBundle {
  const bundle = parsePresetBundle(value);
  const kinds = bundle.presets.map(kind);
  if (revision === "reference" || revision === "machine") {
    if (
      kinds.length < 3 ||
      kinds[0] !== "machine" ||
      kinds[1] !== "process" ||
      !kinds.slice(2).every((value) => value === "filament")
    ) {
      invalid(
        "Machine and reference bundles must order machine, process, then filament presets",
      );
    }
  } else if (!kinds.every((value) => value === "override")) {
    invalid(`${revision} bundles may contain override presets only`);
  }
  return bundle;
}

/**
 * OrcaSlicer accepts one typed machine preset and one typed process preset.
 * Print and calibration revisions are deliberately stored as overrides, so the
 * worker applies them to the process preset immediately before invocation.
 */
export function materializePresetBundles(
  revisions: readonly RevisionPresetBundle[],
): MaterializedPresetBundle {
  const base = revisions.find(
    (revision) => revision.kind === "reference" || revision.kind === "machine",
  );
  if (!base) {
    invalid(
      "Slicer preset materialization requires a machine or reference bundle",
    );
  }
  const machine = base.presets[0]!;
  const process = base.presets[1]!;
  const filaments = base.presets.slice(2);
  const mergedProcess: OrcaPreset = { ...process };

  for (const revision of revisions) {
    if (revision.kind !== "print" && revision.kind !== "calibration") {
      continue;
    }
    for (const override of revision.presets) {
      for (const [key, value] of Object.entries(override)) {
        if (!(key in mergedProcess)) {
          invalid(
            `Orca ${revision.kind} override key ${key} is absent from the process preset`,
          );
        }
        mergedProcess[key] = value;
      }
    }
  }

  return { settings: [machine, mergedProcess], filaments };
}
