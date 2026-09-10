import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { buildProfileBundle, fixtureRoot, stableJson } from "./profile-lib.mjs";
import { writeStoredZip } from "./zip-store.mjs";

const recordArgument = process.argv.indexOf("--record");
const recordDirectory =
  recordArgument === -1
    ? undefined
    : path.resolve(process.argv[recordArgument + 1]);
if (recordArgument !== -1 && !process.argv[recordArgument + 1]) {
  throw new Error("--record requires an output directory");
}

const lock = JSON.parse(
  await readFile(path.join(fixtureRoot, "runtime.lock.json"), "utf8"),
);
const { manifest } = await buildProfileBundle();
if (manifest.bundleSha256 !== lock.profiles.bundleSha256) {
  throw new Error(
    "Runtime lock profile digest does not match the resolved bundle",
  );
}
if (manifest.upstream.revision !== lock.profiles.upstreamRevision) {
  throw new Error(
    "Runtime lock profile revision does not match the resolved bundle",
  );
}
if (lock.profiles.upstreamRevision !== lock.engine.sourceRevision) {
  throw new Error(
    "Runtime lock engine and profile source revisions do not match",
  );
}

const profileDirectory = path.join(fixtureRoot, "profiles", "resolved");
const catalogProfileDirectory = path.resolve(
  fixtureRoot,
  "../catalog-profiles/resolved",
);
const fixtureDirectory = path.join(fixtureRoot, "fixtures");
const cases = [
  {
    name: "single-pla",
    fixture: "cube.stl",
    operation: "slice",
    cloneCount: 1,
    trianglesPerObject: 12,
  },
  {
    name: "quantity-pla",
    fixture: "cube.stl",
    operation: "slice",
    cloneCount: 2,
    trianglesPerObject: 12,
  },
  {
    name: "painted-multimaterial",
    fixture: "painted-multimaterial.3mf",
    operation: "slice",
    cloneCount: 1,
    filamentCount: 2,
  },
  {
    name: "invalid-geometry",
    fixture: "open-triangle.stl",
    operation: "slice",
    cloneCount: 1,
    invalid: true,
    expectedFailure: {
      exitCode: 250,
      returnCode: -6,
      error: "The input model file to the slicer can not be parsed.",
    },
  },
  {
    name: "worker-reference-gcode",
    fixture: "cube.stl",
    operation: "worker",
    cloneCount: 1,
    trianglesPerObject: 12,
  },
  {
    name: "worker-cloned-gcode",
    fixture: "cube.stl",
    operation: "worker",
    cloneCount: 2,
    trianglesPerObject: 12,
  },
  {
    name: "worker-production-gcode-3mf",
    fixture: "cube.stl",
    operation: "worker",
    cloneCount: 3,
    trianglesPerObject: 12,
    platePlan: [2, 1],
    artifactFormat: "gcode_3mf",
  },
];

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const runtimeProfileDirectory = "/opt/taven/profiles";
const filamentPath = `${runtimeProfileDirectory}/filament.json`;

function slicerArguments(fixtureCase) {
  if (fixtureCase.operation === "worker") {
    const arguments_ = [
      "--debug",
      "2",
      "--slice",
      "0",
      "--outputdir",
      "/output",
      "--datadir",
      "/tmp/data",
      "--load-settings",
      "/input/profiles/settings/0.json;/input/profiles/settings/1.json",
      "--load-filaments",
      "/input/profiles/filaments/0.json",
    ];
    if (fixtureCase.platePlan) {
      arguments_.push("--load-assemble-list", "/input/assembly.json");
    } else if (fixtureCase.cloneCount > 1) {
      arguments_.push(
        "--arrange",
        "1",
        "--clone-objects",
        String(fixtureCase.cloneCount),
      );
    }
    if (fixtureCase.artifactFormat === "gcode_3mf") {
      arguments_.push("--export-3mf", "toolpath.gcode.3mf", "--min-save");
    }
    if (!fixtureCase.platePlan) arguments_.push("/input/geometry.stl");
    return arguments_;
  }
  const arguments_ = [
    "--debug",
    "2",
    "--slice",
    "0",
    "--outputdir",
    "/output",
    "--datadir",
    "/tmp/data",
    "--load-settings",
    `${runtimeProfileDirectory}/process.json;${runtimeProfileDirectory}/machine.json`,
    "--load-filaments",
    fixtureCase.filamentCount === 2
      ? `${filamentPath};/input/filament-secondary.json`
      : filamentPath,
  ];
  if (fixtureCase.cloneCount > 1) {
    arguments_.push(
      "--arrange",
      "1",
      "--clone-objects",
      String(fixtureCase.cloneCount),
    );
  }
  if (fixtureCase.name === "painted-multimaterial") {
    arguments_.push("--allow-multicolor-oneplate");
  }
  arguments_.push(`/input/${fixtureCase.fixture}`);
  return arguments_;
}

async function assertWorkerInvocationContract() {
  const runner = await readFile(
    path.resolve(fixtureRoot, "../../apps/slicer-worker/orca-runner.sh"),
    "utf8",
  );
  const invocationStart = runner.indexOf("    set -- \\\n      --debug 2 \\\n");
  const invocationEnd = runner.indexOf(
    "\n\n    diagnostics_fifo",
    invocationStart,
  );
  const normalize = (value) => value.replace(/\\s+/gu, " ").trim();
  const actual = normalize(runner.slice(invocationStart, invocationEnd));
  const expected = normalize(`
    set -- \\
      --debug 2 \\
      --slice 0 \\
      --outputdir /work/output \\
      --datadir /tmp/data \\
      --load-settings "$settings"
    if [ -n "$filaments" ]; then
      set -- "$@" --load-filaments "$filaments"
    fi
    if [ -f "$request/assembly.json" ]; then
      set -- "$@" --load-assemble-list /work/assembly.json
    elif [ "$copies" -gt 1 ]; then
      set -- "$@" --arrange 1 --clone-objects "$copies"
    fi
    if [ "$artifact_format" = gcode_3mf ]; then
      set -- "$@" --export-3mf toolpath.gcode.3mf --min-save
    fi
    if [ ! -f "$request/assembly.json" ]; then
      set -- "$@" /work/geometry.stl
    fi
  `);
  if (actual !== expected) {
    throw new Error(
      "Worker argument construction no longer matches corpus vectors",
    );
  }
}

await assertWorkerInvocationContract();

const invocationCases = cases.map((fixtureCase) => ({
  case: fixtureCase.name,
  arguments: slicerArguments(fixtureCase),
}));
const invocationBundleSha256 = digest(
  stableJson({ schemaVersion: 1, cases: invocationCases }),
);
if (invocationBundleSha256 !== lock.invocation?.bundleSha256) {
  throw new Error(
    `Runtime lock invocation digest does not match the corpus commands: expected ${lock.invocation?.bundleSha256 ?? "none"}, built ${invocationBundleSha256}`,
  );
}

function normalizedResult(result) {
  if (!result) {
    return null;
  }
  return {
    returnCode: result.return_code,
    error: result.error_string,
    layerHeight: result.layer_height,
    plateIndex: result.plate_index,
    sparseInfillDensity: result.sparse_infill_density,
    wallLoops: result.wall_loops,
    slicedPlates: (result.sliced_plates ?? []).map((plate) => ({
      id: plate.id,
      triangleCount: plate.triangle_count,
      warning: plate.warning_message,
    })),
  };
}

function secondsFromDuration(value) {
  const hours = Number(value.match(/(\d+)h/)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+)m/)?.[1] ?? 0);
  const seconds = Number(value.match(/(\d+)s/)?.[1] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function normalizeDiagnostics(value) {
  return value
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) =>
      line.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g, "<timestamp>"),
    );
}

function filamentValues(source, unit) {
  const patterns = {
    cubicCentimeters: /^; filament used \[cm3\] = ([\d., ]+)$/m,
    grams: /^; filament used \[g\] = ([\d., ]+)$/m,
    millimeters: /^; filament used \[mm\] = ([\d., ]+)$/m,
  };
  const values = source.match(patterns[unit])?.[1];
  return values?.split(",").map((value) => Number(value.trim())) ?? [];
}

function parseGcode(source) {
  const generationHeader = source.match(
    /^; generated by OrcaSlicer (\S+) on \d{4}-\d{2}-\d{2} at \d{2}:\d{2}:\d{2}$/m,
  );
  if (!generationHeader) {
    throw new Error(
      "G-code does not contain a valid OrcaSlicer version header",
    );
  }
  if (generationHeader[1] !== lock.engine.version) {
    throw new Error(
      `G-code engine version ${generationHeader[1]} does not match runtime lock ${lock.engine.version}`,
    );
  }
  const lines = source.split(/\r?\n/u);
  const executableStart = lines.findIndex(
    (line) => line.trim() === "; EXECUTABLE_BLOCK_START",
  );
  const firstLayer = lines.findIndex(
    (line, index) =>
      index > executableStart &&
      /^;\s*(?:CHANGE_LAYER|LAYER_CHANGE)\s*$/u.test(line),
  );
  const executableEnd = lines.findIndex(
    (line, index) =>
      index > firstLayer && line.trim() === "; EXECUTABLE_BLOCK_END",
  );
  const hasStartupCommand = lines
    .slice(executableStart + 1, firstLayer)
    .some((line) => /^\s*[GMT]\d+(?:\.\d+)?(?:\s|$)/iu.test(line));
  if (
    executableStart < 0 ||
    firstLayer < 0 ||
    executableEnd < 0 ||
    !hasStartupCommand
  ) {
    throw new Error("G-code does not contain a complete executable program");
  }
  const normalized = source.replace(
    generationHeader[0],
    `; generated by OrcaSlicer ${lock.engine.version} on <timestamp>`,
  );
  const estimate = source.match(/total estimated time: ([^\n]+)/)?.[1];
  const filamentSlots = source
    .match(/^; filament: ([\d,]+)$/m)?.[1]
    ?.split(",")
    .map(Number);
  const millimeters = filamentValues(source, "millimeters");
  const cubicCentimeters = filamentValues(source, "cubicCentimeters");
  const grams = filamentValues(source, "grams");
  const usageCount = Math.max(
    filamentSlots?.length ?? 0,
    millimeters.length,
    cubicCentimeters.length,
    grams.length,
  );
  return {
    normalizedSha256: digest(normalized),
    estimatedSeconds: estimate ? secondsFromDuration(estimate) : null,
    filamentUsage: Array.from({ length: usageCount }, (_, index) => ({
      slot: filamentSlots?.[index],
      millimeters: millimeters[index],
      cubicCentimeters: cubicCentimeters[index],
      grams: grams[index],
    })),
  };
}

function usesExpectedFilaments(output, filamentCount = 1) {
  const usage = output.filamentUsage;
  return (
    usage.length === filamentCount &&
    usage.every(
      (filament, index) =>
        filament.slot === index + 1 &&
        Number.isFinite(filament.millimeters) &&
        filament.millimeters > 0 &&
        Number.isFinite(filament.cubicCentimeters) &&
        filament.cubicCentimeters > 0 &&
        Number.isFinite(filament.grams) &&
        filament.grams > 0,
    )
  );
}

function hasExpectedCloneEvidence(fixtureCase, resultFile) {
  if (fixtureCase.trianglesPerObject === undefined) {
    return true;
  }
  const slicedPlates = resultFile?.sliced_plates;
  return (
    Array.isArray(slicedPlates) &&
    slicedPlates.length > 0 &&
    slicedPlates.every(
      (plate) =>
        Number.isInteger(plate.triangle_count) && plate.triangle_count > 0,
    ) &&
    slicedPlates.reduce((total, plate) => total + plate.triangle_count, 0) ===
      fixtureCase.trianglesPerObject * fixtureCase.cloneCount
  );
}

function validateExecution(fixtureCase, execution, resultFile, outputs) {
  if (execution.error) {
    throw new Error(
      `Could not execute ${fixtureCase.name}: ${execution.error.message}`,
      { cause: execution.error },
    );
  }
  if (execution.status === null || execution.signal !== null) {
    throw new Error(
      `OrcaSlicer did not exit normally for ${fixtureCase.name} (status ${execution.status}, signal ${execution.signal ?? "none"})`,
    );
  }

  if (fixtureCase.invalid) {
    const expectedFailure = fixtureCase.expectedFailure;
    if (
      execution.status !== expectedFailure.exitCode ||
      !resultFile ||
      resultFile.return_code !== expectedFailure.returnCode ||
      resultFile.error_string !== expectedFailure.error ||
      (resultFile.sliced_plates?.length ?? 0) !== 0 ||
      outputs.length !== 0
    ) {
      throw new Error(
        `Invalid fixture ${fixtureCase.name} did not produce the expected failure`,
      );
    }
    return;
  }

  if (
    execution.status !== 0 ||
    resultFile?.return_code !== 0 ||
    !hasExpectedCloneEvidence(fixtureCase, resultFile) ||
    outputs.length === 0 ||
    outputs.some(
      (output) =>
        !Number.isFinite(output.estimatedSeconds) ||
        output.estimatedSeconds <= 0 ||
        !usesExpectedFilaments(output, fixtureCase.filamentCount),
    )
  ) {
    throw new Error(
      `Fixture ${fixtureCase.name} did not produce a successful slice: exit ${execution.status}, return ${resultFile?.return_code ?? "none"}, error ${resultFile?.error_string ?? "none"}`,
    );
  }
}

async function prepareInput(directory, fixtureCase) {
  const destination = path.join(directory, fixtureCase.fixture);
  if (fixtureCase.name === "painted-multimaterial") {
    const source = path.join(
      fixtureDirectory,
      "painted-multimaterial",
      "source",
    );
    await writeStoredZip(destination, source, [
      "[Content_Types].xml",
      "_rels/.rels",
      "3D/3dmodel.model",
    ]);
  } else {
    const source = path.join(
      fixtureDirectory,
      fixtureCase.name === "invalid-geometry"
        ? "invalid-geometry"
        : "single-pla",
      fixtureCase.fixture,
    );
    await copyFile(source, destination);
  }
  return destination;
}

async function prepareWorkerInput(directory, fixtureCase) {
  const geometry = path.join(directory, "geometry.stl");
  const settings = path.join(directory, "profiles", "settings");
  const filaments = path.join(directory, "profiles", "filaments");
  await Promise.all([
    mkdir(settings, { recursive: true }),
    mkdir(filaments, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(
      path.join(fixtureDirectory, "single-pla", fixtureCase.fixture),
      geometry,
    ),
    copyFile(
      path.join(catalogProfileDirectory, "machine.json"),
      path.join(settings, "0.json"),
    ),
    copyFile(
      path.join(catalogProfileDirectory, "filament-pla.json"),
      path.join(filaments, "0.json"),
    ),
  ]);
  const processPreset = JSON.parse(
    await readFile(path.join(catalogProfileDirectory, "process.json"), "utf8"),
  );
  // This is the complete active 10% print and calibration override set seeded
  // by apps/backend/scripts/seed.ts, merged in the worker's precedence order.
  Object.assign(
    processPreset,
    {
      brim_width: "0",
      enable_support: "0",
      layer_height: "0.2",
      sparse_infill_density: "10%",
    },
    {
      elefant_foot_compensation: "0",
      xy_contour_compensation: "0",
      xy_hole_compensation: "0",
    },
  );
  await writeFile(path.join(settings, "1.json"), stableJson(processPreset));
  if (fixtureCase.platePlan) {
    await writeFile(
      path.join(directory, "assembly.json"),
      JSON.stringify({
        plates: fixtureCase.platePlan.map((count, index) => ({
          plate_name: `Plate ${index + 1}`,
          need_arrange: true,
          objects: [{ path: "/input/geometry.stl", count, filaments: [1] }],
        })),
      }),
    );
  }
  return geometry;
}

async function gcode3mfOutput(outputDirectory, fixtureCase) {
  const archive = path.join(outputDirectory, "toolpath.gcode.3mf");
  const listing = spawnSync("unzip", ["-Z1", archive], { encoding: "utf8" });
  if (listing.status !== 0)
    throw new Error(
      `Worker ${fixtureCase.name} did not emit a readable G-code 3MF`,
    );
  const entries = listing.stdout.split("\n").filter(Boolean);
  if (!entries.includes("Metadata/slice_info.config"))
    throw new Error(`Worker ${fixtureCase.name} did not emit slice metadata`);
  const plates = entries
    .filter((entry) => /^Metadata\/plate_\d+\.gcode$/u.test(entry))
    .sort();
  if (plates.length !== fixtureCase.platePlan.length)
    throw new Error(`Worker ${fixtureCase.name} emitted the wrong plate count`);
  const output = [];
  for (const plate of plates) {
    const gcode = spawnSync("unzip", ["-p", archive, plate], {
      encoding: "utf8",
    });
    const checksum = spawnSync("unzip", ["-p", archive, `${plate}.md5`], {
      encoding: "utf8",
    });
    const observed = createHash("md5")
      .update(gcode.stdout)
      .digest("hex")
      .toUpperCase();
    if (
      gcode.status !== 0 ||
      checksum.status !== 0 ||
      checksum.stdout.trim() !== observed
    ) {
      throw new Error(
        `Worker ${fixtureCase.name} emitted an invalid plate checksum`,
      );
    }
    output.push({ file: plate, ...parseGcode(gcode.stdout) });
  }
  return { file: "toolpath.gcode.3mf", plates: output };
}

async function runCase(runRoot, fixtureCase) {
  const inputDirectory = path.join(runRoot, fixtureCase.name, "input");
  const outputDirectory = path.join(runRoot, fixtureCase.name, "output");
  await mkdir(inputDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await chmod(outputDirectory, 0o777);
  const input =
    fixtureCase.operation === "worker"
      ? await prepareWorkerInput(inputDirectory, fixtureCase)
      : await prepareInput(inputDirectory, fixtureCase);
  let secondaryFilamentDigest = null;
  if (fixtureCase.name === "painted-multimaterial") {
    const secondaryFilament = JSON.parse(
      await readFile(path.join(profileDirectory, "filament.json"), "utf8"),
    );
    secondaryFilament.name = "Taven fixture blue PLA";
    secondaryFilament.setting_id = "TAVEN_FIXTURE_BLUE";
    secondaryFilament.filament_id = "TAVEN_FIXTURE_BLUE";
    secondaryFilament.filament_settings_id = ["Taven fixture blue PLA"];
    secondaryFilament.filament_colour = ["#0066CC"];
    const secondaryContents = stableJson(secondaryFilament);
    await writeFile(
      path.join(inputDirectory, "filament-secondary.json"),
      secondaryContents,
    );
    secondaryFilamentDigest = digest(secondaryContents);
  }

  const command = slicerArguments(fixtureCase);

  const execution = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      lock.platform,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=536870912,mode=1777",
      "--tmpfs",
      "/work:rw,nosuid,nodev,size=67108864,mode=0700,uid=10001,gid=10001",
      "--mount",
      `type=bind,src=${inputDirectory},dst=/input,readonly`,
      "--mount",
      `type=bind,src=${outputDirectory},dst=/output`,
      lock.image.tag,
      ...command,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );

  const files = await readdir(outputDirectory);
  const resultFile = files.includes("result.json")
    ? JSON.parse(
        await readFile(path.join(outputDirectory, "result.json"), "utf8"),
      )
    : null;
  const gcodeFiles = files.filter((file) => file.endsWith(".gcode")).sort();
  const outputs = await Promise.all(
    gcodeFiles.map(async (file) => {
      const source = await readFile(path.join(outputDirectory, file), "utf8");
      if (source.trim().length === 0) {
        throw new Error(`Fixture ${fixtureCase.name} produced empty ${file}`);
      }
      return { file, ...parseGcode(source) };
    }),
  );
  const packagedOutput =
    fixtureCase.artifactFormat === "gcode_3mf"
      ? await gcode3mfOutput(outputDirectory, fixtureCase)
      : null;
  validateExecution(
    fixtureCase,
    execution,
    resultFile,
    packagedOutput ? packagedOutput.plates : outputs,
  );
  const inputContents = await readFile(input);
  const paintedSource =
    fixtureCase.name === "painted-multimaterial"
      ? await readFile(
          path.join(
            fixtureDirectory,
            "painted-multimaterial",
            "source",
            "3D",
            "3dmodel.model",
          ),
          "utf8",
        )
      : "";
  const paintCodes = [
    ...paintedSource.matchAll(/mmu_segmentation="([0-9a-f]+)"/g),
  ].map((match) => Number.parseInt(match[1], 16) >> 2);

  return {
    schemaVersion: 1,
    case: fixtureCase.name,
    engine: {
      name: lock.engine.name,
      version: lock.engine.version,
      imageDigest: lock.image.ociDigest,
      invocationBundleSha256,
    },
    invocation: {
      arguments: command,
      sha256: digest(stableJson(command)),
    },
    profiles: {
      upstreamRevision: manifest.upstream.revision,
      bundleSha256: manifest.bundleSha256,
    },
    input: {
      file: fixtureCase.fixture,
      sha256: digest(inputContents),
      secondaryFilamentSha256: secondaryFilamentDigest,
      cloneCount: fixtureCase.cloneCount,
      paintedExtruders: [...new Set(paintCodes)].sort(
        (left, right) => left - right,
      ),
      expectedInvalidGeometry: fixtureCase.invalid ?? false,
    },
    execution: {
      exitCode: execution.status,
      signal: execution.signal,
      stdout: normalizeDiagnostics(execution.stdout ?? ""),
      stderr: normalizeDiagnostics(execution.stderr ?? ""),
      result: normalizedResult(resultFile),
    },
    outputs: packagedOutput ? [packagedOutput] : outputs,
  };
}

const firstRoot = await mkdtemp(path.join(os.tmpdir(), "taven-orca-corpus-a-"));
const secondRoot = await mkdtemp(
  path.join(os.tmpdir(), "taven-orca-corpus-b-"),
);
const first = [];
const second = [];
for (const fixtureCase of cases) {
  first.push(await runCase(firstRoot, fixtureCase));
  second.push(await runCase(secondRoot, fixtureCase));
}

const instability = cases.filter(
  (_fixtureCase, index) =>
    stableJson(first[index]) !== stableJson(second[index]),
);
if (instability.length > 0) {
  throw new Error(
    `Corpus is not stable across two clean runs: ${instability.map(({ name }) => name).join(", ")}`,
  );
}

const destinationDirectory =
  recordDirectory ?? path.join(fixtureRoot, "expected");
if (recordDirectory) {
  await mkdir(recordDirectory, { recursive: true });
}
const drift = [];
for (const [index, fixtureCase] of cases.entries()) {
  const expectedPath = path.join(
    destinationDirectory,
    `${fixtureCase.name}.json`,
  );
  const actual = stableJson(first[index]);
  if (recordDirectory) {
    await writeFile(expectedPath, actual);
    continue;
  }
  let expected;
  try {
    expected = await readFile(expectedPath, "utf8");
  } catch {
    drift.push(fixtureCase.name);
    continue;
  }
  if (expected !== actual) {
    drift.push(fixtureCase.name);
  }
}
if (drift.length > 0) {
  throw new Error(
    `Corpus output changed for ${drift.join(", ")}. Build old and new runtimes and review the expected JSON diff before updating.`,
  );
}
console.log(
  `${recordDirectory ? "Recorded" : "Verified"} ${cases.length} fixtures across two clean runs with profile ${manifest.bundleSha256}.`,
);
