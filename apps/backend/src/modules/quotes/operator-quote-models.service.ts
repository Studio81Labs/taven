import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  IdempotencyStatus,
  ModelFileFormat,
  Prisma,
  QuoteRequestStatus,
  RetentionHold,
  RevisionState,
  SliceKind,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { AuditService } from "../audit/audit.service";
import {
  DELIVERY_CAPABILITY,
  type DeliveryCapabilityPort,
} from "../automatic-quotes/delivery-capability.port";
import { parseSellerTaxPolicy } from "../../pricing/seller-tax-policy";
import { parseIndividualPaymentPolicy } from "../resources/price-list-validation";
import { databaseNow } from "../legal-approvals/legal-approvals.service";
import { slicerSettingsSnapshot } from "../slicing/slicer-profile-snapshot.service";
import {
  enqueueModelInspection,
  modelInspectionInput,
} from "../slicing/model-inspection-dispatch";
import type {
  QuoteRequestModelAttachedDto,
  QuoteRequestModelDto,
  QuoteRequestModelSelectedDto,
  QuoteRequestModelsDto,
  SelectQuoteRequestModelDto,
  PrepareQuoteRequestReferenceDto,
  QuoteRequestReferencePreparationDto,
  QuoteComposerChoicesDto,
} from "./operator-quote-models.dto";

type Transaction = Prisma.TransactionClient;
type Database = PrismaService | Transaction;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_DAYS = 7;
const MAX_SLICING_JOB_ATTEMPTS = 100;

@Injectable()
export class OperatorQuoteModelsService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(AuditService)
    private readonly audit: AuditService,
    @Inject(DELIVERY_CAPABILITY)
    private readonly delivery: DeliveryCapabilityPort,
  ) {}

  async composerChoices(
    operator: OperatorContext,
    requestId: string,
  ): Promise<QuoteComposerChoicesDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    operatorNode(operator);
    requestId = uuid(requestId, "requestId");
    const [models, printConfigs, referenceProfiles, selection] =
      await Promise.all([
        this.list(operator, requestId),
        this.prisma.printConfigRevision.findMany({
          orderBy: { createdAt: "desc" },
        }),
        this.prisma.referenceProfile.findMany({
          where: { state: RevisionState.ACTIVE },
          orderBy: { createdAt: "desc" },
        }),
        this.prisma.commercialPolicySelection.findUnique({
          where: { currency: "CZK" },
          include: { priceList: true },
        }),
      ]);
    if (!selection)
      throw new ConflictException("Commercial policy selection is unavailable");
    const tax = parseSellerTaxPolicy(selection.priceList.parameters);
    const deliverySelector = this.delivery.selectionPolicy();
    return {
      models,
      printConfigs: printConfigs.map((config) => ({
        id: config.id,
        quality: config.quality,
        infillPercent: config.infillPercent,
        layerHeightMicrometers: config.layerHeightMicrometers,
      })),
      referenceProfiles: referenceProfiles.map((profile) => ({
        id: profile.id,
        material: profile.material,
        quality: profile.quality,
        slicerVersion: profile.slicerVersion,
      })),
      policy: {
        priceListId: selection.priceListId,
        revision: selection.priceList.revision,
        selectionVersion: selection.selectionVersion,
        taxRegime: tax.regime,
        vatRateBasisPoints: tax.vatRateBasisPoints,
        individualPaymentPolicy: parseIndividualPaymentPolicy(
          selection.priceList.parameters,
        ),
      },
      deliveryOptions: [...this.delivery.configuredOptions()],
      deliverySelector: {
        mode: deliverySelector.mode,
        available: deliverySelector.available,
        allowedEndpointTypes: [...deliverySelector.allowedEndpointTypes],
        ...(deliverySelector.widget
          ? {
              widget: {
                accountId: deliverySelector.widget.accountId,
                options: deliverySelector.widget.options,
              },
            }
          : {}),
      },
    };
  }

  async list(
    operator: OperatorContext,
    requestId: string,
  ): Promise<QuoteRequestModelsDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    operatorNode(operator);
    requestId = uuid(requestId, "requestId");
    const request = await this.prisma.quoteRequest.findUnique({
      where: { id: requestId },
      select: { id: true },
    });
    if (!request) throw new NotFoundException("Quote request was not found");
    const models = await this.prisma.quoteRequestModel.findMany({
      where: { requestId },
      include: {
        modelFile: true,
        selections: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "asc" },
    });
    const geometryIds = models.flatMap((model) =>
      model.selections.map((selection) => selection.modelGeometryId),
    );
    const geometries = await this.prisma.modelGeometry.findMany({
      where: { id: { in: geometryIds }, deletedAt: null },
      select: { id: true, sourceModelFileId: true },
    });
    const readyGeometryIds = new Set(
      geometries.map(
        (geometry) => `${geometry.id}:${geometry.sourceModelFileId}`,
      ),
    );
    const now = await databaseNow(this.prisma);
    const items: QuoteRequestModelDto[] = await Promise.all(
      models.map(async (model) => {
        const inspection = await inspectionForJob(
          this.prisma,
          model.inspectionJobId,
        );
        const source = model.modelFile;
        return {
          modelFileId: source.id,
          format: source.format === ModelFileFormat.STL ? "STL" : "3MF",
          originalFilename: source.originalFilename,
          contentSha256: source.contentHash,
          sizeBytes: source.sizeBytes.toString(),
          inspectionJobId: model.inspectionJobId,
          inspectionStatus: inspection.status,
          availableBodyIds: inspection.bodyIds,
          inspectionFailureCode: inspection.failureCode,
          sourceAvailable: availableSource(source, now),
          sourceDeleteAfter: source.sourceDeleteAfter.toISOString(),
          selections: model.selections.map((selection) => ({
            id: selection.id,
            modelFileId: source.id,
            modelGeometryId: selection.modelGeometryId,
            bodyIds: selection.bodyIds,
            selectionSha256: selection.selectionSha256,
            sourceContentSha256: selection.sourceContentSha256,
            geometryReady: readyGeometryIds.has(
              `${selection.modelGeometryId}:${source.id}`,
            ),
            createdAt: selection.createdAt.toISOString(),
          })),
        };
      }),
    );
    return { items };
  }

  async importHandoffModel(
    operator: OperatorContext,
    requestId: string,
    modelFileId: string,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestModelAttachedDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.QUOTES_WRITE);
    const nodeId = operatorNode(operator);
    requestId = uuid(requestId, "requestId");
    modelFileId = uuid(modelFileId, "modelFileId");
    const key = commandKey(idempotencyKey);
    return this.command(
      "quote-request.import-model",
      key,
      fingerprint({ requestId, modelFileId }),
      async (transaction) => {
        await lockActiveRequest(transaction, requestId);
        const existing = await transaction.quoteRequestModel.findUnique({
          where: { requestId_modelFileId: { requestId, modelFileId } },
        });
        const handoff = existing
          ? null
          : await transaction.automaticQuoteRequestHandoff.findUnique({
              where: { quoteRequestId: requestId },
            });
        if (!existing && !handoff?.modelFileIds.includes(modelFileId)) {
          throw new NotFoundException("Handoff model was not found");
        }
        const source = await transaction.modelFile.findUnique({
          where: { id: modelFileId },
        });
        const now = await databaseNow(transaction);
        if (!source || !availableSource(source, now)) {
          throw new GoneException("Model source is no longer available");
        }
        if (!supportedSource(source.format)) {
          throw new BadRequestException("Model format is not supported");
        }
        if (existing) {
          const next = nextPreprocessingAttempt(
            await latestPreprocessingDispatch(
              transaction,
              existing.inspectionJobId,
              "slicing.model-inspection.requested",
            ),
          );
          if (next) {
            await enqueueModelInspection(transaction, {
              jobId: existing.inspectionJobId,
              correlationId: requestId,
              source,
              ...next,
              operation: { mode: "inspect_source" },
            });
            await this.audit.recordOperator(transaction, operator, {
              quoteRequestId: requestId,
              nodeId,
              eventType: "quote_request.model_inspection_retried",
              idempotencyKey: key,
              correlationId: existing.inspectionJobId,
              payload: {
                operation: "retry_inspection",
                modelFileId,
                attempt: next.attempt,
              },
            });
          }
          return { modelFileId, inspectionJobId: existing.inspectionJobId };
        }
        const inspectionJobId = randomUUID();
        await transaction.quoteRequestModel.create({
          data: {
            requestId,
            modelFileId,
            attachedByOperatorId: operator.operatorId,
            inspectionJobId,
          },
        });
        await enqueueModelInspection(transaction, {
          jobId: inspectionJobId,
          correlationId: requestId,
          source,
          operation: { mode: "inspect_source" },
        });
        await this.audit.recordOperator(transaction, operator, {
          quoteRequestId: requestId,
          nodeId,
          eventType: "quote_request.model_attached",
          idempotencyKey: key,
          correlationId: inspectionJobId,
          payload: {
            operation: "handoff_import",
            modelFileId,
            inspectionJobId,
          },
        });
        return { modelFileId, inspectionJobId };
      },
    );
  }

  async selectBodies(
    operator: OperatorContext,
    requestId: string,
    input: SelectQuoteRequestModelDto,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestModelSelectedDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.QUOTES_WRITE);
    const nodeId = operatorNode(operator);
    requestId = uuid(requestId, "requestId");
    const modelFileId = uuid(input?.modelFileId, "modelFileId");
    const bodyIds = await canonicalBodyIds(input?.bodyIds);
    const { geometrySelectionSha256 } = await import("@taven/slicer-contracts");
    const selectionSha256 = geometrySelectionSha256(bodyIds);
    const key = commandKey(idempotencyKey);
    return this.command(
      "quote-request.select-model-bodies",
      key,
      fingerprint({ requestId, modelFileId, bodyIds }),
      async (transaction) => {
        await lockActiveRequest(transaction, requestId);
        const attached = await transaction.quoteRequestModel.findUnique({
          where: { requestId_modelFileId: { requestId, modelFileId } },
          include: { modelFile: true },
        });
        if (!attached) {
          throw new NotFoundException("Request model was not found");
        }
        const source = attached.modelFile;
        const now = await databaseNow(transaction);
        if (!availableSource(source, now)) {
          throw new GoneException("Model source is no longer available");
        }
        const inspection = await inspectionForJob(
          transaction,
          attached.inspectionJobId,
        );
        if (
          inspection.status !== "SUCCEEDED" ||
          bodyIds.some((bodyId) => !inspection.bodyIds.includes(bodyId)) ||
          inspection.sourceContentSha256 !== source.contentHash
        ) {
          throw new ConflictException(
            "Selected bodies lack verified inspection evidence",
          );
        }
        const existing =
          await transaction.quoteRequestModelSelection.findUnique({
            where: {
              requestId_modelFileId_selectionSha256: {
                requestId,
                modelFileId,
                selectionSha256,
              },
            },
          });
        const selectionId = existing?.id ?? randomUUID();
        const modelGeometryId =
          existing?.modelGeometryId ??
          deterministicUuid(
            `automatic-geometry:${modelFileId}:${selectionSha256}`,
          );
        if (!existing) {
          await transaction.quoteRequestModelSelection.create({
            data: {
              id: selectionId,
              requestId,
              modelFileId,
              modelGeometryId,
              inspectionJobId: attached.inspectionJobId,
              sourceContentSha256: source.contentHash,
              bodyIds,
              selectionSha256,
              createdAt: now,
            },
          });
        }
        const geometry = await transaction.modelGeometry.findUnique({
          where: { id: modelGeometryId },
        });
        if (geometry) {
          if (
            geometry.sourceModelFileId !== source.id ||
            geometry.deletedAt !== null
          ) {
            throw new ConflictException("Selected geometry is unavailable");
          }
        } else {
          const { slicingInputFingerprint } =
            await import("@taven/slicer-contracts");
          const sourceInspectionFingerprintSha256 = slicingInputFingerprint(
            "model_inspection",
            modelInspectionInput(source, { mode: "inspect_source" }),
          );
          const jobId = deterministicUuid(
            `canonicalization:${selectionId}:${selectionSha256}`,
          );
          const next = nextPreprocessingAttempt(
            await latestPreprocessingDispatch(
              transaction,
              jobId,
              "slicing.model-inspection.requested",
            ),
          );
          if (next) {
            await enqueueModelInspection(transaction, {
              jobId,
              correlationId: requestId,
              source,
              ...next,
              operation: {
                mode: "canonicalize_selection",
                sourceInspectionFingerprintSha256,
                bodyIds,
                selectionSha256,
                confirmedUnitConversion: {
                  sourceUnit: "millimeter",
                  targetUnit: "millimeter",
                  scaleFactorPpm: 1_000_000,
                },
                targetGeometry: {
                  modelGeometryId,
                  canonicalObjectKey: `geometries/${modelGeometryId}/canonical`,
                },
              },
            });
            if (existing) {
              await this.audit.recordOperator(transaction, operator, {
                quoteRequestId: requestId,
                nodeId,
                eventType: "quote_request.model_canonicalization_retried",
                idempotencyKey: key,
                correlationId: selectionId,
                payload: {
                  operation: "retry_canonicalization",
                  modelFileId,
                  modelGeometryId,
                  attempt: next.attempt,
                },
              });
            }
          }
        }
        if (existing) return { selectionId, modelGeometryId };
        await this.audit.recordOperator(transaction, operator, {
          quoteRequestId: requestId,
          nodeId,
          eventType: "quote_request.model_bodies_selected",
          idempotencyKey: key,
          correlationId: selectionId,
          payload: {
            operation: "select_bodies",
            modelFileId,
            modelGeometryId,
            selectionSha256,
          },
        });
        return { selectionId, modelGeometryId };
      },
    );
  }

  async prepareReference(
    operator: OperatorContext,
    requestId: string,
    input: PrepareQuoteRequestReferenceDto,
    idempotencyKey: string | undefined,
  ): Promise<QuoteRequestReferencePreparationDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.QUOTES_WRITE);
    const nodeId = operatorNode(operator);
    requestId = uuid(requestId, "requestId");
    const prepared = referenceInput(input);
    const key = commandKey(idempotencyKey);
    return this.command(
      "quote-request.prepare-reference",
      key,
      fingerprint({ requestId, ...prepared }),
      async (transaction) => {
        await lockActiveRequest(transaction, requestId);
        const result = await prepareReferenceInTransaction(
          transaction,
          requestId,
          prepared,
          transaction,
        );
        await this.audit.recordOperator(transaction, operator, {
          quoteRequestId: requestId,
          nodeId,
          eventType: "quote_request.reference_prepared",
          idempotencyKey: key,
          correlationId: prepared.selectionId,
          payload: {
            operation: "prepare_reference",
            ...prepared,
            pendingJobIds: result.pendingJobIds,
          },
        });
        return result;
      },
    );
  }

  async referenceStatus(
    operator: OperatorContext,
    requestId: string,
    input: PrepareQuoteRequestReferenceDto,
  ): Promise<QuoteRequestReferencePreparationDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    operatorNode(operator);
    requestId = uuid(requestId, "requestId");
    return prepareReferenceInTransaction(
      this.prisma,
      requestId,
      referenceInput(input),
    );
  }

  private async command<T extends object>(
    namespace: string,
    key: string,
    requestFingerprint: string,
    operation: (transaction: Transaction) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (transaction) => {
      const lockKey = `${namespace}:${key}`;
      await transaction.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text
      `;
      const now = await databaseNow(transaction);
      const previous = await transaction.idempotencyRecord.findFirst({
        where: { namespace, idempotencyKey: key },
        orderBy: { generation: "desc" },
      });
      if (previous && previous.expiresAt > now) {
        if (previous.requestFingerprint !== requestFingerprint) {
          throw new ConflictException(
            "Idempotency key was used with other input",
          );
        }
        if (
          previous.status !== IdempotencyStatus.COMPLETED ||
          !previous.responseBody
        ) {
          throw new ConflictException("Idempotent command is incomplete");
        }
        return previous.responseBody as T;
      }
      const record = await transaction.idempotencyRecord.create({
        data: {
          namespace,
          idempotencyKey: key,
          generation: (previous?.generation ?? 0) + 1,
          requestFingerprint,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_DAYS * 86_400_000),
        },
      });
      const result = await operation(transaction);
      await transaction.idempotencyRecord.update({
        where: { id: record.id },
        data: {
          status: IdempotencyStatus.COMPLETED,
          responseStatusCode: 201,
          responseBody: result,
        },
      });
      return result;
    });
  }
}

type ReferenceInput = Readonly<{
  selectionId: string;
  printConfigRevisionId: string;
  referenceProfileId: string;
  quantity: number;
  partsPerPlate: number;
}>;

function referenceInput(
  input: PrepareQuoteRequestReferenceDto,
): ReferenceInput {
  const selectionId = uuid(input?.selectionId, "selectionId");
  const printConfigRevisionId = uuid(
    input?.printConfigRevisionId,
    "printConfigRevisionId",
  );
  const referenceProfileId = uuid(
    input?.referenceProfileId,
    "referenceProfileId",
  );
  const quantity = input?.quantity;
  const partsPerPlate = input?.partsPerPlate;
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 1_000 ||
    !Number.isInteger(partsPerPlate) ||
    partsPerPlate < 1 ||
    partsPerPlate > quantity
  ) {
    throw new BadRequestException(
      "Reference quantity and partsPerPlate are invalid",
    );
  }
  return {
    selectionId,
    printConfigRevisionId,
    referenceProfileId,
    quantity,
    partsPerPlate,
  };
}

async function prepareReferenceInTransaction(
  database: Database,
  requestId: string,
  input: ReferenceInput,
  enqueueTransaction?: Transaction,
): Promise<QuoteRequestReferencePreparationDto> {
  const selection = await database.quoteRequestModelSelection.findFirst({
    where: { id: input.selectionId, requestId },
  });
  if (!selection)
    throw new NotFoundException("Request model selection was not found");
  const source = await database.modelFile.findUnique({
    where: { id: selection.modelFileId },
  });
  const geometry = await database.modelGeometry.findUnique({
    where: { id: selection.modelGeometryId },
  });
  if (
    !geometry ||
    geometry.deletedAt ||
    geometry.sourceModelFileId !== selection.modelFileId
  ) {
    throw new ConflictException("Selected model geometry is not ready");
  }
  const now = await databaseNow(database);
  if (
    !source ||
    !availableSource(source, now) ||
    source.contentHash !== selection.sourceContentSha256
  ) {
    throw new GoneException("Selected model source is unavailable");
  }
  const [config, profile] = await Promise.all([
    database.printConfigRevision.findUnique({
      where: { id: input.printConfigRevisionId },
    }),
    database.referenceProfile.findUnique({
      where: { id: input.referenceProfileId },
    }),
  ]);
  if (
    !config ||
    !profile ||
    config.quality !== profile.quality ||
    (enqueueTransaction && profile.state !== RevisionState.ACTIVE)
  ) {
    throw new BadRequestException(
      "Reference profile and print configuration are incompatible",
    );
  }
  const { buildReferenceSliceCacheKey, RevisionRef, Sha256Digest } =
    await import("@taven/core");
  const occupancies = [
    input.partsPerPlate,
    input.quantity % input.partsPerPlate,
  ].filter((value) => value > 0);
  const results: Array<string | null> = [];
  const pendingJobIds: string[] = [];
  const failedJobIds: string[] = [];
  for (const occupancy of occupancies) {
    const cacheKey = buildReferenceSliceCacheKey({
      geometryHash: Sha256Digest.parse(geometry.geometryHash),
      modelGeometryId: geometry.id,
      geometrySelectionHash: Sha256Digest.parse(selection.selectionSha256),
      referenceProfileRevision: RevisionRef.create(
        "reference-profile",
        profile.id,
      ),
      printConfigRevision: RevisionRef.create("print-config", config.id),
      partsPerPlate: occupancy,
    });
    const cached = await database.sliceResult.findUnique({
      where: { cacheKey },
    });
    if (cached) {
      if (
        cached.kind !== SliceKind.REFERENCE ||
        cached.modelGeometryId !== geometry.id ||
        cached.printConfigRevisionId !== config.id ||
        cached.referenceProfileId !== profile.id ||
        cached.partsPerPlate !== occupancy
      ) {
        throw new ConflictException(
          "Reference slice cache evidence is incompatible",
        );
      }
      results.push(cached.id);
      continue;
    }
    results.push(null);
    const jobInput = {
      geometry: {
        sourceModelFileId: selection.modelFileId,
        sourceContentSha256: selection.sourceContentSha256,
        modelGeometryId: geometry.id,
        canonicalObjectKey: geometry.canonicalObjectKey,
        geometrySha256: geometry.geometryHash,
        bodyIds: selection.bodyIds,
        selectionSha256: selection.selectionSha256,
      },
      referenceProfile: {
        revisionId: profile.id,
        contentSha256: slicerSettingsSnapshot(profile.settings).contentSha256,
        slicerEngine: profile.slicerEngine,
        slicerVersion: profile.slicerVersion,
      },
      printConfig: {
        revisionId: config.id,
        contentSha256: slicerSettingsSnapshot(config.settings).contentSha256,
      },
      partsPerPlate: occupancy,
    };
    const {
      ReferenceSliceJobSchema,
      slicingInputFingerprint,
      slicingDispatchAttemptKey,
    } = await import("@taven/slicer-contracts");
    const jobId = deterministicUuid(
      `assisted-reference:${selection.id}:${config.id}:${profile.id}:${occupancy}`,
    );
    const latest = await latestPreprocessingDispatch(
      database,
      jobId,
      "slicing.reference-slice.requested",
    );
    const next = enqueueTransaction ? nextPreprocessingAttempt(latest) : null;
    if (!next || !enqueueTransaction) {
      if (latest?.deadLettered || latest?.status === "failed")
        failedJobIds.push(jobId);
      else pendingJobIds.push(jobId);
      continue;
    }
    pendingJobIds.push(jobId);
    const inputFingerprintSha256 = slicingInputFingerprint(
      "reference_slice",
      jobInput,
    );
    const job = ReferenceSliceJobSchema.parse({
      contractVersion: 2,
      kind: "reference_slice",
      jobId,
      correlationId: requestId,
      inputFingerprintSha256,
      idempotencyKey: `slicer:v2:reference_slice:${jobId}:${inputFingerprintSha256}`,
      attempt: next.attempt,
      input: jobInput,
    });
    const deduplicationKey = slicingDispatchAttemptKey(
      job.idempotencyKey,
      next.attempt,
    );
    await enqueueTransaction.outboxMessage.upsert({
      where: { deduplicationKey },
      create: {
        deduplicationKey,
        aggregateType: "ReferenceSliceDispatch",
        aggregateId: jobId,
        messageType: "slicing.reference-slice.requested",
        schemaVersion: 2,
        payload: { job } as unknown as Prisma.InputJsonObject,
        ...(next.availableAt ? { availableAt: next.availableAt } : {}),
      },
      update: {},
    });
  }
  return {
    ...input,
    primaryReferenceSliceResultId: results[0] ?? null,
    tailReferenceSliceResultId: results[1] ?? null,
    pendingJobIds,
    failedJobIds,
  };
}

type PreprocessingMessageType =
  "slicing.model-inspection.requested" | "slicing.reference-slice.requested";

type PreprocessingDispatchState = Readonly<{
  id: string;
  attempt: number;
  status: "succeeded" | "failed" | null;
  failureClass: string | null;
  retryAfterMilliseconds: number | null;
  receiptCreatedAt: Date | null;
  deadLettered: boolean;
}>;

async function latestPreprocessingDispatch(
  database: Database,
  jobId: string,
  messageType: PreprocessingMessageType,
): Promise<PreprocessingDispatchState | undefined> {
  const inspection = messageType === "slicing.model-inspection.requested";
  const aggregateType = inspection
    ? "ModelInspectionDispatch"
    : "ReferenceSliceDispatch";
  const resultMessageType = inspection
    ? "slicing.model_inspection.result-received"
    : "slicing.reference_slice.result-received";
  const deadLetterMessageType = inspection
    ? "slicing.model_inspection.dead-lettered"
    : "slicing.reference_slice.dead-lettered";
  const rows = await database.$queryRaw<PreprocessingDispatchState[]>`
    SELECT
      dispatch.id,
      (dispatch.payload #>> '{job,attempt}')::integer AS attempt,
      terminal.status,
      terminal.failure_class AS "failureClass",
      terminal.retry_after_milliseconds AS "retryAfterMilliseconds",
      terminal.created_at AS "receiptCreatedAt",
      EXISTS (
        SELECT 1
        FROM outbox_messages dead_letter
        WHERE dead_letter.aggregate_type = 'SlicingDispatchDeadLetter'
          AND dead_letter.aggregate_id = dispatch.id
          AND dead_letter.message_type = ${deadLetterMessageType}
      ) AS "deadLettered"
    FROM outbox_messages dispatch
    LEFT JOIN LATERAL (
      SELECT
        receipt.payload #>> '{result,outcome,status}' AS status,
        receipt.payload #>> '{result,outcome,failureClass}' AS failure_class,
        (receipt.payload #>> '{result,outcome,retryAfterMilliseconds}')::integer
          AS retry_after_milliseconds,
        receipt.created_at
      FROM outbox_messages receipt
      WHERE receipt.aggregate_type = 'SlicingDispatchResult'
        AND receipt.aggregate_id = dispatch.id
        AND receipt.message_type = ${resultMessageType}
      ORDER BY receipt.created_at DESC, receipt.id DESC
      LIMIT 1
    ) terminal ON TRUE
    WHERE dispatch.aggregate_type = ${aggregateType}
      AND dispatch.aggregate_id = ${jobId}::uuid
      AND dispatch.message_type = ${messageType}
    ORDER BY (dispatch.payload #>> '{job,attempt}')::integer DESC
    LIMIT 1
  `;
  return rows[0];
}

function nextPreprocessingAttempt(
  latest: PreprocessingDispatchState | undefined,
): { attempt: number; availableAt?: Date } | null {
  if (!latest) return { attempt: 1 };
  if (latest.attempt >= MAX_SLICING_JOB_ATTEMPTS) return null;
  if (latest.deadLettered) return { attempt: latest.attempt + 1 };
  if (
    latest.status !== "failed" ||
    latest.failureClass !== "retryable_infrastructure"
  ) {
    return null;
  }
  return {
    attempt: latest.attempt + 1,
    ...(latest.receiptCreatedAt && latest.retryAfterMilliseconds
      ? {
          availableAt: new Date(
            latest.receiptCreatedAt.getTime() + latest.retryAfterMilliseconds,
          ),
        }
      : {}),
  };
}

async function lockActiveRequest(
  transaction: Transaction,
  requestId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<
    Array<{ status: QuoteRequestStatus }>
  >`
    SELECT status FROM quote_requests WHERE id = ${requestId}::uuid FOR UPDATE
  `;
  const status = rows[0]?.status;
  if (!status) throw new NotFoundException("Quote request was not found");
  if (
    status !== QuoteRequestStatus.NEW &&
    status !== QuoteRequestStatus.IN_REVIEW &&
    status !== QuoteRequestStatus.QUOTED
  ) {
    throw new ConflictException(
      "Quote request cannot accept model preparation",
    );
  }
}

type InspectionEvidence = Readonly<{
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  bodyIds: string[];
  failureCode: string | null;
  sourceContentSha256: string | null;
}>;

async function inspectionForJob(
  database: Database,
  jobId: string,
): Promise<InspectionEvidence> {
  const dispatch = await latestPreprocessingDispatch(
    database,
    jobId,
    "slicing.model-inspection.requested",
  );
  if (!dispatch) {
    return {
      status: "PENDING",
      bodyIds: [],
      failureCode: null,
      sourceContentSha256: null,
    };
  }
  const receipt = await database.outboxMessage.findFirst({
    where: {
      aggregateType: "SlicingDispatchResult",
      aggregateId: dispatch.id,
      messageType: "slicing.model_inspection.result-received",
    },
  });
  if (!receipt) {
    const deadLetter = await database.outboxMessage.findFirst({
      where: {
        aggregateType: "SlicingDispatchDeadLetter",
        aggregateId: dispatch.id,
        messageType: "slicing.model_inspection.dead-lettered",
      },
      select: { id: true },
    });
    if (deadLetter) {
      return {
        status: "FAILED",
        bodyIds: [],
        failureCode: "INSPECTION_DISPATCH_FAILED",
        sourceContentSha256: null,
      };
    }
  }
  const payload = asRecord(receipt?.payload);
  const { ModelInspectionResultSchema } =
    await import("@taven/slicer-contracts");
  const parsed = ModelInspectionResultSchema.safeParse(payload?.result);
  if (!parsed.success) {
    return {
      status: receipt ? "FAILED" : "PENDING",
      bodyIds: [],
      failureCode: receipt ? "INVALID_INSPECTION_EVIDENCE" : null,
      sourceContentSha256: null,
    };
  }
  const result = parsed.data;
  if (result.jobId !== jobId) {
    return {
      status: "FAILED",
      bodyIds: [],
      failureCode: "INSPECTION_JOB_MISMATCH",
      sourceContentSha256: null,
    };
  }
  if (result.outcome.status === "failed") {
    return {
      status: "FAILED",
      bodyIds: [],
      failureCode: result.outcome.code,
      sourceContentSha256: result.input.source.contentSha256,
    };
  }
  return {
    status: "SUCCEEDED",
    bodyIds: result.outcome.bodies.map((body) => body.bodyId).sort(),
    failureCode: null,
    sourceContentSha256: result.input.source.contentSha256,
  };
}

function availableSource(
  source: Readonly<{
    deletedAt: Date | null;
    retentionHold: RetentionHold;
    sourceDeleteAfter: Date;
  }>,
  now: Date,
): boolean {
  return (
    source.deletedAt === null &&
    (source.retentionHold !== RetentionHold.NONE ||
      source.sourceDeleteAfter > now)
  );
}

function supportedSource(format: ModelFileFormat): boolean {
  return format === ModelFileFormat.STL || format === ModelFileFormat.THREE_MF;
}

async function canonicalBodyIds(value: unknown): Promise<string[]> {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256 ||
    value.some((item) => typeof item !== "string")
  ) {
    throw new BadRequestException(
      "bodyIds must be a nonempty array of identifiers",
    );
  }
  const ids = value as string[];
  if (new Set(ids).size !== ids.length) {
    throw new BadRequestException("bodyIds must be unique");
  }
  const sorted = [...ids].sort();
  try {
    const { geometrySelectionSha256 } = await import("@taven/slicer-contracts");
    geometrySelectionSha256(sorted);
  } catch {
    throw new BadRequestException("bodyIds are invalid");
  }
  return sorted;
}

function commandKey(value: string | undefined): string {
  if (typeof value !== "string" || !/^\S.{6,252}\S$/.test(value.trim())) {
    throw new BadRequestException("Idempotency-Key is invalid");
  }
  return value.trim();
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
