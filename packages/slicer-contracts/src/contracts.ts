import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Deprecated v1 exports exist only while the legacy queue drains. New
 * producers must publish v2 messages to SLICING_QUEUE_NAME.
 */
export const LEGACY_V1_SLICING_CONTRACT_VERSION = 1 as const;
export const LEGACY_V1_SLICING_QUEUE_NAME = "taven:slicing:v1" as const;

const LegacyV1Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

// Keep these schemas shape-compatible with the original v1 payload
// shape. Tightening them would make already-enqueued jobs impossible to drain.
export const LegacyV1SlicingJobSchema = z.object({
  contractVersion: z.literal(LEGACY_V1_SLICING_CONTRACT_VERSION),
  jobId: z.uuid(),
  inputObjectKey: z.string().min(1),
  inputSha256: LegacyV1Sha256Schema,
  profileVersion: z.string().min(1),
  profileSha256: LegacyV1Sha256Schema,
});

export const LegacyV1SlicingResultSchema = z.object({
  contractVersion: z.literal(LEGACY_V1_SLICING_CONTRACT_VERSION),
  jobId: z.uuid(),
  engine: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    profileSha256: LegacyV1Sha256Schema,
  }),
  output: z.object({
    kind: z.literal("fixture"),
    metadataSha256: LegacyV1Sha256Schema,
  }),
});

export const SLICING_CONTRACT_VERSION = 2 as const;
export const SLICING_QUEUE_NAME = "taven:slicing:v2" as const;
export const SLICING_MESSAGE_MAX_BYTES = 64 * 1024;

const MAX_BODY_COUNT = 256;
const MAX_FINDING_COUNT = 256;
const MAX_PLATE_COUNT = 128;
const MAX_QUANTITY = 100_000;
const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const LOWERCASE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GENERATED_OBJECT_KEY_PATTERN =
  /^(?:models|geometries|reference-slices|gcode)\/[a-z0-9][a-z0-9:-]*(?:\/[a-z0-9][a-z0-9._:-]*)*$/;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/;
const SAFE_FAILURE_MESSAGE_PATTERN =
  /^(?!.*(?:[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)(?:\/|[a-z]:\\)|\b(?:authorization|bearer|password|secret|token)\b)).+$/iu;

function hasNoControlCharacters(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint >= 32 && !(codePoint >= 127 && codePoint <= 159);
  });
}

export const UuidSchema = z
  .string()
  .regex(LOWERCASE_UUID_PATTERN, "must be a lowercase RFC 9562 UUID");

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");

export const NonnegativeInt64StringSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/, "must be a canonical decimal integer")
  .refine(
    (value) => BigInt(value) <= MAX_SIGNED_BIGINT,
    "must fit a signed 64-bit integer",
  );

export const PositiveInt64StringSchema = NonnegativeInt64StringSchema.refine(
  (value) => value !== "0",
  "must be positive",
);

export const StorageObjectKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    GENERATED_OBJECT_KEY_PATTERN,
    "must be a generated Taven object key in an allowed namespace",
  )
  .refine(
    (value) =>
      !value.includes("..") && !value.includes("\\") && !value.startsWith("/"),
    "must not contain path traversal or an absolute path",
  );

const ModelSourceObjectKeySchema = StorageObjectKeySchema.regex(
  /^models\/[0-9a-f-]{36}\/source$/,
  "must identify a persisted model source",
);
const GeometryObjectKeySchema = StorageObjectKeySchema.regex(
  /^geometries\/[0-9a-f-]{36}\/canonical$/,
  "must identify canonical model geometry",
);
const ReferenceArtifactObjectKeySchema = StorageObjectKeySchema.regex(
  /^reference-slices\/[a-z0-9][a-z0-9:-]*\/[a-z0-9][a-z0-9._:-]*$/,
  "must identify a reference-slice artifact",
);
const ProductionArtifactObjectKeySchema = StorageObjectKeySchema.regex(
  /^gcode\/[a-z0-9][a-z0-9:-]*\/occupancy-[1-9][0-9]{0,5}\/[a-z0-9][a-z0-9._:-]*$/,
  "must identify a production G-code artifact",
);

const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SAFE_IDENTIFIER_PATTERN, "must be a generated identifier");
const RevisionNameSchema = SafeIdentifierSchema.max(64);
const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9][a-z0-9:|_-]*$/, "must be a canonical queue key");
const SafeFailureMessageSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(
    SAFE_FAILURE_MESSAGE_PATTERN,
    "must not contain URLs, filesystem paths, credentials, or control characters",
  )
  .refine(
    hasNoControlCharacters,
    "must not contain URLs, filesystem paths, credentials, or control characters",
  )
  .refine(
    (value) => !value.includes("/") && !value.includes("\\"),
    "must not contain path separators, URLs, or filesystem paths",
  )
  .refine(
    (value) => value === value.trim(),
    "must not contain surrounding whitespace",
  );

const boundedPositiveInteger = (maximum: number) =>
  z.number().int().min(1).max(maximum);
const boundedNonnegativeInteger = (maximum: number) =>
  z.number().int().min(0).max(maximum);

const sortedUniqueIdentifiers = (maximum: number, minimum = 1) =>
  z
    .array(SafeIdentifierSchema)
    .min(minimum)
    .max(maximum)
    .superRefine((values, context) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "identifiers must be unique",
        });
      }
      if (
        values.some((value, index) => index > 0 && value < values[index - 1]!)
      ) {
        context.addIssue({
          code: "custom",
          message: "identifiers must use canonical lexical order",
        });
      }
    });

export const ModelFileIdentitySchema = z
  .strictObject({
    modelFileId: UuidSchema,
    format: z.enum(["stl", "3mf", "step"]),
    objectKey: ModelSourceObjectKeySchema,
    contentSha256: Sha256Schema,
  })
  .superRefine((value, context) => {
    if (value.objectKey !== `models/${value.modelFileId}/source`) {
      context.addIssue({
        code: "custom",
        path: ["objectKey"],
        message: "must belong to modelFileId",
      });
    }
  });

export const GeometrySelectionSchema = z
  .strictObject({
    sourceModelFileId: UuidSchema,
    sourceContentSha256: Sha256Schema,
    modelGeometryId: UuidSchema,
    canonicalObjectKey: GeometryObjectKeySchema,
    geometrySha256: Sha256Schema,
    bodyIds: sortedUniqueIdentifiers(MAX_BODY_COUNT),
    selectionSha256: Sha256Schema,
  })
  .superRefine((value, context) => {
    if (
      value.canonicalObjectKey !==
      `geometries/${value.modelGeometryId}/canonical`
    ) {
      context.addIssue({
        code: "custom",
        path: ["canonicalObjectKey"],
        message: "must belong to modelGeometryId",
      });
    }
  });

export const RevisionSnapshotSchema = z.strictObject({
  revisionId: UuidSchema,
  contentSha256: Sha256Schema,
});

export const BoundingBoxSchema = z.strictObject({
  xMicrometers: NonnegativeInt64StringSchema,
  yMicrometers: NonnegativeInt64StringSchema,
  zMicrometers: NonnegativeInt64StringSchema,
});

export const TopologyMetricsSchema = z.strictObject({
  watertight: z.boolean(),
  manifold: z.boolean(),
  normals: z.enum(["consistent", "inconsistent", "unknown"]),
});

export const PreflightFindingSchema = z
  .strictObject({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/, "must be a stable finding code"),
    severity: z.enum(["info", "warning", "blocking"]),
    phase: z.enum(["inspection", "reference_slice"]),
    message: SafeFailureMessageSchema,
    acknowledgementKey: SafeIdentifierSchema.nullable(),
  })
  .superRefine((value, context) => {
    if (
      (value.severity === "warning") !==
      (value.acknowledgementKey !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgementKey"],
        message: "is required exactly for warning findings",
      });
    }
  });

export const EngineIdentitySchema = z.strictObject({
  name: SafeIdentifierSchema,
  version: z
    .string()
    .min(1)
    .max(100)
    .refine(
      (value) => value === value.trim(),
      "must not contain surrounding whitespace",
    ),
  imageSha256: Sha256Schema,
});

const InspectionInputSchema = z.strictObject({
  source: ModelFileIdentitySchema,
  inspectionRevision: RevisionNameSchema,
  inspectionConfigSha256: Sha256Schema,
  canonicalizerRevision: RevisionNameSchema,
  canonicalizerConfigSha256: Sha256Schema,
});

const ReferenceSliceInputSchema = z.strictObject({
  geometry: GeometrySelectionSchema,
  referenceProfile: RevisionSnapshotSchema,
  printConfig: RevisionSnapshotSchema,
  partsPerPlate: boundedPositiveInteger(MAX_QUANTITY),
});

const MachineSliceInputShape = {
  geometry: GeometrySelectionSchema,
  machineId: UuidSchema,
  machineProfile: RevisionSnapshotSchema,
  machineCalibration: RevisionSnapshotSchema,
  printConfig: RevisionSnapshotSchema,
  partsPerPlate: boundedPositiveInteger(MAX_QUANTITY),
} as const;

function requireRepresentablePlateCount(
  value: { quantity: number; partsPerPlate: number },
  context: z.RefinementCtx,
): void {
  if (Math.ceil(value.quantity / value.partsPerPlate) > MAX_PLATE_COUNT) {
    context.addIssue({
      code: "custom",
      path: ["quantity"],
      message: `must fit within ${MAX_PLATE_COUNT} result plates`,
    });
  }
}

const CandidateEstimateInputSchema = z
  .strictObject({
    ...MachineSliceInputShape,
    quantity: boundedPositiveInteger(MAX_QUANTITY),
    shipmentPlanId: UuidSchema,
    arrangementRevision: RevisionSnapshotSchema,
  })
  .superRefine(requireRepresentablePlateCount);

const ProductionSliceInputSchema = z
  .strictObject({
    ...MachineSliceInputShape,
    quantity: boundedPositiveInteger(MAX_QUANTITY),
    acceptedJobId: UuidSchema,
    productionReservationId: UuidSchema,
  })
  .superRefine((value, context) => {
    if (value.quantity !== value.partsPerPlate) {
      context.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "must equal the exact occupancy of this one-plate dispatch",
      });
    }
  });

const JobEnvelopeShape = {
  contractVersion: z.literal(SLICING_CONTRACT_VERSION),
  jobId: UuidSchema,
  correlationId: UuidSchema,
  inputFingerprintSha256: Sha256Schema,
  idempotencyKey: IdempotencyKeySchema,
  attempt: boundedPositiveInteger(100),
} as const;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("contract numbers must be safe integers");
    }
    return value.toString(10);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new TypeError("contract identity contains an unsupported value");
}

export type SlicingJobKind =
  | "model_inspection"
  | "reference_slice"
  | "candidate_estimate"
  | "production_slice";

/** Computes the v2 identity digest over strict, immutable job input fields. */
export function slicingInputFingerprint(
  kind: SlicingJobKind,
  input: unknown,
): string {
  return createHash("sha256")
    .update(canonicalJson({ kind, input }))
    .digest("hex");
}

function requireCanonicalJobIdentity(
  value: {
    kind: SlicingJobKind;
    input: unknown;
    inputFingerprintSha256: string;
    idempotencyKey: string;
  },
  context: z.RefinementCtx,
): void {
  const fingerprint = slicingInputFingerprint(value.kind, value.input);
  if (value.inputFingerprintSha256 !== fingerprint) {
    context.addIssue({
      code: "custom",
      path: ["inputFingerprintSha256"],
      message: "must be the canonical SHA-256 of kind and input",
    });
  }
  const expected = `slicer:v${SLICING_CONTRACT_VERSION}:${value.kind}:${value.inputFingerprintSha256}`;
  if (value.idempotencyKey !== expected) {
    context.addIssue({
      code: "custom",
      path: ["idempotencyKey"],
      message: "must be derived from kind and inputFingerprintSha256",
    });
  }
}

const ModelInspectionJobBase = z.strictObject({
  ...JobEnvelopeShape,
  kind: z.literal("model_inspection"),
  input: InspectionInputSchema,
});
const ReferenceSliceJobBase = z.strictObject({
  ...JobEnvelopeShape,
  kind: z.literal("reference_slice"),
  input: ReferenceSliceInputSchema,
});
const CandidateEstimateJobBase = z.strictObject({
  ...JobEnvelopeShape,
  kind: z.literal("candidate_estimate"),
  input: CandidateEstimateInputSchema,
});
const ProductionSliceJobBase = z.strictObject({
  ...JobEnvelopeShape,
  kind: z.literal("production_slice"),
  input: ProductionSliceInputSchema,
});

export const ModelInspectionJobSchema = ModelInspectionJobBase.superRefine(
  requireCanonicalJobIdentity,
).superRefine(enforceMessageSize);
export const ReferenceSliceJobSchema = ReferenceSliceJobBase.superRefine(
  requireCanonicalJobIdentity,
).superRefine(enforceMessageSize);
export const CandidateEstimateJobSchema = CandidateEstimateJobBase.superRefine(
  requireCanonicalJobIdentity,
).superRefine(enforceMessageSize);

function enforceMessageSize(value: unknown, context: z.RefinementCtx): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > SLICING_MESSAGE_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      message: `message must not exceed ${SLICING_MESSAGE_MAX_BYTES} bytes`,
    });
  }
}

function requireAcceptedProductionJob(
  value: { jobId: string; input: { acceptedJobId: string } },
  context: z.RefinementCtx,
): void {
  if (value.input.acceptedJobId !== value.jobId) {
    context.addIssue({
      code: "custom",
      path: ["input", "acceptedJobId"],
      message: "must equal the accepted production job dispatch ID",
    });
  }
}

export const ProductionSliceJobSchema = ProductionSliceJobBase.superRefine(
  requireCanonicalJobIdentity,
)
  .superRefine(requireAcceptedProductionJob)
  .superRefine(enforceMessageSize);

export const SlicingJobSchema = z
  .discriminatedUnion("kind", [
    ModelInspectionJobBase,
    ReferenceSliceJobBase,
    CandidateEstimateJobBase,
    ProductionSliceJobBase,
  ])
  .superRefine((value, context) => {
    requireCanonicalJobIdentity(value, context);
    if (value.kind === "production_slice") {
      requireAcceptedProductionJob(value, context);
    }
    enforceMessageSize(value, context);
  });

const BodyInspectionSchema = z.strictObject({
  bodyId: SafeIdentifierSchema,
  bodySha256: Sha256Schema,
  boundingBox: BoundingBoxSchema,
  volumeCubicMicrometers: NonnegativeInt64StringSchema,
  triangleCount: boundedNonnegativeInteger(1_000_000_000),
  topology: TopologyMetricsSchema,
  hasPaintAssignments: z.boolean(),
  materialAssignmentIds: sortedUniqueIdentifiers(MAX_BODY_COUNT, 0),
  extruderAssignmentIds: sortedUniqueIdentifiers(MAX_BODY_COUNT, 0),
});

const InspectionMetricsSchema = z.strictObject({
  boundingBox: BoundingBoxSchema,
  objectCount: boundedPositiveInteger(MAX_BODY_COUNT),
  bodyCount: boundedPositiveInteger(MAX_BODY_COUNT),
  unitHint: z.enum(["millimeter", "inch", "meter", "unknown"]),
  scaleAssessment: z.enum(["trusted", "converted", "confirmation_required"]),
  suggestedScaleFactorPpm: boundedPositiveInteger(1_000_000_000).nullable(),
  thinWallFeatureCount: boundedNonnegativeInteger(1_000_000),
  hasPaintAssignments: z.boolean(),
  materialAssignmentCount: boundedNonnegativeInteger(MAX_BODY_COUNT),
  extruderAssignmentCount: boundedNonnegativeInteger(MAX_BODY_COUNT),
});

const SliceMetricsShape = {
  boundingBox: BoundingBoxSchema,
  objectCount: boundedPositiveInteger(MAX_BODY_COUNT),
  bodyCount: boundedPositiveInteger(MAX_BODY_COUNT),
  topology: TopologyMetricsSchema,
  thinWallFeatureCount: boundedNonnegativeInteger(1_000_000),
  supportVolumeRatioPpm: boundedNonnegativeInteger(1_000_000),
  hasPaintAssignments: z.boolean(),
  materialAssignmentCount: boundedNonnegativeInteger(MAX_BODY_COUNT),
  estimatedPrintSeconds: PositiveInt64StringSchema,
  estimatedMaterialMilligrams: PositiveInt64StringSchema,
} as const;

export const SliceMetricsSchema = z.strictObject({
  ...SliceMetricsShape,
  plateCount: boundedPositiveInteger(MAX_PLATE_COUNT),
});

const RetryableFailureSchema = z.strictObject({
  status: z.literal("failed"),
  failureClass: z.literal("retryable_infrastructure"),
  code: z.enum([
    "OBJECT_STORE_UNAVAILABLE",
    "ENGINE_UNAVAILABLE",
    "ENGINE_TIMEOUT",
    "TEMPORARY_CAPACITY",
  ]),
  retryable: z.literal(true),
  message: SafeFailureMessageSchema,
  retryAfterMilliseconds: boundedPositiveInteger(86_400_000).nullable(),
});

const DeterministicFailureSchema = z.strictObject({
  status: z.literal("failed"),
  failureClass: z.literal("deterministic_invalid"),
  code: z.enum([
    "INVALID_MODEL",
    "INVALID_GEOMETRY",
    "INVALID_PROFILE",
    "RESOURCE_LIMIT_EXCEEDED",
  ]),
  retryable: z.literal(false),
  message: SafeFailureMessageSchema,
  retryAfterMilliseconds: z.null(),
});

const UnsupportedFailureSchema = z.strictObject({
  status: z.literal("failed"),
  failureClass: z.literal("unsupported_input"),
  code: z.enum([
    "UNSUPPORTED_FORMAT",
    "UNSUPPORTED_FEATURE",
    "PAINTED_OR_MULTIMATERIAL",
  ]),
  retryable: z.literal(false),
  message: SafeFailureMessageSchema,
  retryAfterMilliseconds: z.null(),
});

export const SlicingFailureSchema = z.discriminatedUnion("failureClass", [
  RetryableFailureSchema,
  DeterministicFailureSchema,
  UnsupportedFailureSchema,
]);

const InspectionSuccessSchema = z
  .strictObject({
    status: z.literal("succeeded"),
    metrics: InspectionMetricsSchema,
    bodies: z.array(BodyInspectionSchema).min(1).max(MAX_BODY_COUNT),
    findings: z.array(PreflightFindingSchema).max(MAX_FINDING_COUNT),
  })
  .superRefine((value, context) => {
    const bodyIds = value.bodies.map(({ bodyId }) => bodyId);
    if (new Set(bodyIds).size !== bodyIds.length) {
      context.addIssue({
        code: "custom",
        path: ["bodies"],
        message: "bodyId values must be unique",
      });
    }
    if (value.metrics.bodyCount !== value.bodies.length) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "bodyCount"],
        message: "must equal the number of body results",
      });
    }
    const materialAssignments = new Set(
      value.bodies.flatMap(
        ({ materialAssignmentIds }) => materialAssignmentIds,
      ),
    );
    const extruderAssignments = new Set(
      value.bodies.flatMap(
        ({ extruderAssignmentIds }) => extruderAssignmentIds,
      ),
    );
    if (
      value.metrics.materialAssignmentCount !== materialAssignments.size ||
      value.metrics.extruderAssignmentCount !== extruderAssignments.size ||
      value.metrics.hasPaintAssignments !==
        value.bodies.some(({ hasPaintAssignments }) => hasPaintAssignments)
    ) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "assignment summaries must reconcile to inspected bodies",
      });
    }
  });

const ReferenceSliceSuccessSchema = z.strictObject({
  status: z.literal("succeeded"),
  metrics: z.strictObject({
    ...SliceMetricsShape,
    plateCount: z.literal(1),
  }),
  findings: z.array(PreflightFindingSchema).max(MAX_FINDING_COUNT),
  artifact: z.strictObject({
    objectKey: ReferenceArtifactObjectKeySchema,
    sha256: Sha256Schema,
  }),
});

const PlateEstimateSchema = z.strictObject({
  plateOrdinal: boundedPositiveInteger(MAX_PLATE_COUNT),
  partsOnPlate: boundedPositiveInteger(MAX_QUANTITY),
  estimatedPrintSeconds: PositiveInt64StringSchema,
  estimatedMaterialMilligrams: PositiveInt64StringSchema,
});

const CandidateEstimateSuccessSchema = z
  .strictObject({
    status: z.literal("succeeded"),
    metrics: SliceMetricsSchema,
    plates: z.array(PlateEstimateSchema).min(1).max(MAX_PLATE_COUNT),
  })
  .superRefine((value, context) => {
    const ordinals = value.plates.map(({ plateOrdinal }) => plateOrdinal);
    if (
      ordinals.some((ordinal, index) => ordinal !== index + 1) ||
      value.metrics.plateCount !== value.plates.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["plates"],
        message: "plates must be complete and ordered from ordinal 1",
      });
    }
  });

const ProductionArtifactSchema = z.strictObject({
  format: z.enum(["gcode_3mf", "bgcode", "gcode"]),
  objectKey: ProductionArtifactObjectKeySchema,
  sha256: Sha256Schema,
});

const ProductionSliceSuccessSchema = z.strictObject({
  status: z.literal("succeeded"),
  metrics: z.strictObject({
    ...SliceMetricsShape,
    plateCount: z.literal(1),
  }),
  artifact: ProductionArtifactSchema,
});

const ResultEnvelopeShape = {
  contractVersion: z.literal(SLICING_CONTRACT_VERSION),
  jobId: UuidSchema,
  correlationId: UuidSchema,
  inputFingerprintSha256: Sha256Schema,
  idempotencyKey: IdempotencyKeySchema,
  attempt: boundedPositiveInteger(100),
  engine: EngineIdentitySchema,
} as const;

function requireSelectedBodyCount(
  value: {
    input: { geometry: { bodyIds: string[] } };
    outcome:
      | { status: "failed" }
      | { status: "succeeded"; metrics: { bodyCount: number } };
  },
  context: z.RefinementCtx,
): void {
  if (
    value.outcome.status === "succeeded" &&
    value.outcome.metrics.bodyCount !== value.input.geometry.bodyIds.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["outcome", "metrics", "bodyCount"],
      message: "must equal the number of selected geometry bodies",
    });
  }
}

const ModelInspectionResultBase = z.strictObject({
  ...ResultEnvelopeShape,
  kind: z.literal("model_inspection"),
  input: InspectionInputSchema,
  outcome: z.union([InspectionSuccessSchema, SlicingFailureSchema]),
});
const ReferenceSliceResultBase = z
  .strictObject({
    ...ResultEnvelopeShape,
    kind: z.literal("reference_slice"),
    input: ReferenceSliceInputSchema,
    outcome: z.union([ReferenceSliceSuccessSchema, SlicingFailureSchema]),
  })
  .superRefine((value, context) => {
    requireSelectedBodyCount(value, context);
    if (
      value.outcome.status === "succeeded" &&
      value.outcome.artifact.objectKey !==
        `reference-slices/${value.jobId}/toolpath.gcode`
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "artifact", "objectKey"],
        message: "must be the deterministic artifact key for jobId",
      });
    }
  });
const CandidateEstimateResultBase = z
  .strictObject({
    ...ResultEnvelopeShape,
    kind: z.literal("candidate_estimate"),
    input: CandidateEstimateInputSchema,
    outcome: z.union([CandidateEstimateSuccessSchema, SlicingFailureSchema]),
  })
  .superRefine((value, context) => {
    requireSelectedBodyCount(value, context);
    if (value.outcome.status !== "succeeded") return;
    const quantity = value.outcome.plates.reduce(
      (sum, plate) => sum + plate.partsOnPlate,
      0,
    );
    if (quantity !== value.input.quantity) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "plates"],
        message: "plate quantities must reconcile to input quantity",
      });
    }
    if (
      value.outcome.plates.some(
        ({ partsOnPlate }) => partsOnPlate > value.input.partsPerPlate,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "plates"],
        message: "a plate cannot exceed partsPerPlate",
      });
    }
    const printSeconds = value.outcome.plates.reduce(
      (sum, plate) => sum + BigInt(plate.estimatedPrintSeconds),
      0n,
    );
    const materialMilligrams = value.outcome.plates.reduce(
      (sum, plate) => sum + BigInt(plate.estimatedMaterialMilligrams),
      0n,
    );
    if (
      printSeconds !== BigInt(value.outcome.metrics.estimatedPrintSeconds) ||
      materialMilligrams !==
        BigInt(value.outcome.metrics.estimatedMaterialMilligrams)
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "metrics"],
        message: "time and material totals must equal the plate estimates",
      });
    }
  });
const ProductionSliceResultBase = z
  .strictObject({
    ...ResultEnvelopeShape,
    kind: z.literal("production_slice"),
    input: ProductionSliceInputSchema,
    outcome: z.union([ProductionSliceSuccessSchema, SlicingFailureSchema]),
  })
  .superRefine((value, context) => {
    requireAcceptedProductionJob(value, context);
    requireSelectedBodyCount(value, context);
    if (value.outcome.status !== "succeeded") return;
    const extension = {
      gcode_3mf: "gcode.3mf",
      bgcode: "bgcode",
      gcode: "gcode",
    }[value.outcome.artifact.format];
    const expected = `gcode/${value.input.acceptedJobId}/occupancy-${value.input.quantity}/toolpath.${extension}`;
    if (value.outcome.artifact.objectKey !== expected) {
      context.addIssue({
        code: "custom",
        path: ["outcome", "artifact", "objectKey"],
        message: "must be the deterministic artifact key for the plate",
      });
    }
  });

const ModelInspectionResultObject = ModelInspectionResultBase.superRefine(
  requireCanonicalJobIdentity,
).superRefine(enforceMessageSize);
const ReferenceSliceResultObject = ReferenceSliceResultBase.superRefine(
  requireCanonicalJobIdentity,
).superRefine(enforceMessageSize);

export const ModelInspectionResultSchema = ModelInspectionResultObject;
export const ReferenceSliceResultSchema = ReferenceSliceResultObject;
export const CandidateEstimateResultSchema =
  CandidateEstimateResultBase.superRefine(
    requireCanonicalJobIdentity,
  ).superRefine(enforceMessageSize);
export const ProductionSliceResultSchema =
  ProductionSliceResultBase.superRefine(
    requireCanonicalJobIdentity,
  ).superRefine(enforceMessageSize);

// Refined result objects use a regular union; every option still has a literal
// kind and rejects fields from the other kinds.
export const SlicingResultSchema = z
  .union([
    ModelInspectionResultObject,
    ReferenceSliceResultObject,
    CandidateEstimateResultSchema,
    ProductionSliceResultSchema,
  ])
  .superRefine(enforceMessageSize);

export type SlicingJob = z.infer<typeof SlicingJobSchema>;
export type SlicingResult = z.infer<typeof SlicingResultSchema>;
export type LegacyV1SlicingJob = z.infer<typeof LegacyV1SlicingJobSchema>;
export type LegacyV1SlicingResult = z.infer<typeof LegacyV1SlicingResultSchema>;
export type ModelInspectionJob = z.infer<typeof ModelInspectionJobSchema>;
export type ReferenceSliceJob = z.infer<typeof ReferenceSliceJobSchema>;
export type CandidateEstimateJob = z.infer<typeof CandidateEstimateJobSchema>;
export type ProductionSliceJob = z.infer<typeof ProductionSliceJobSchema>;
export type ModelInspectionResult = z.infer<typeof ModelInspectionResultSchema>;
export type ReferenceSliceResult = z.infer<typeof ReferenceSliceResultSchema>;
export type CandidateEstimateResult = z.infer<
  typeof CandidateEstimateResultSchema
>;
export type ProductionSliceResult = z.infer<typeof ProductionSliceResultSchema>;
export type SlicingFailure = z.infer<typeof SlicingFailureSchema>;

/**
 * Binds result validation to one persisted dispatch. This rejects a valid but
 * stale, replayed, or cross-geometry result before an adapter can persist it.
 */
export function slicingResultForJobSchema(jobInput: SlicingJob) {
  const job = SlicingJobSchema.parse(jobInput);
  return SlicingResultSchema.superRefine((result, context) => {
    const matchingEnvelope =
      result.contractVersion === job.contractVersion &&
      result.kind === job.kind &&
      result.jobId === job.jobId &&
      result.correlationId === job.correlationId &&
      result.inputFingerprintSha256 === job.inputFingerprintSha256 &&
      result.idempotencyKey === job.idempotencyKey &&
      result.attempt === job.attempt;
    const matchingInput =
      slicingInputFingerprint(result.kind, result.input) ===
      slicingInputFingerprint(job.kind, job.input);

    if (!matchingEnvelope || !matchingInput) {
      context.addIssue({
        code: "custom",
        message: "result does not belong to the dispatched job",
      });
    }
  });
}
