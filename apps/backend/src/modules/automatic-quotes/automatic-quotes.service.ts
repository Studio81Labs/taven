import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AutomaticQuoteRiskDecision,
  AutomaticQuoteHandoffScope,
  IdempotencyStatus,
  InventoryStatus,
  MachineStatus,
  Material,
  ModelFileFormat,
  OrderPhaseKind,
  OrderPhaseStatus,
  OrderStatus,
  OutboxStatus,
  PaymentRole,
  PreflightSeverity,
  Prisma,
  PriceComponentKind,
  PriceComponentScope,
  QuoteSessionStatus,
  RetentionHold,
  RevisionState,
  UploadIntentStatus,
} from "@prisma/client";
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { assertBindingQuoteFlowsEnabled } from "../../launch-approval-gates";
import { PrismaService } from "../../prisma/prisma.service";
import { normalizeAttribution } from "../metrics/attribution";
import { CandidateEstimateService } from "../resources/candidate-estimate.service";
import { EligibilityPlanService } from "../resources/eligibility-plan.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
} from "../resources/resource-errors";
import { ResourceReservationService } from "../resources/resource-reservation.service";
import { slicerSettingsSnapshot } from "../slicing/slicer-profile-snapshot.service";
import { toSlicerProductionArtifactFormat } from "../slicing/production-artifact-format";
import { reserveAnonymousQuote } from "../quotes/anonymous-quote-limit";
import {
  parseAutomaticQuotePricingParameters,
  prepareAutomaticQuote,
  type AutomaticBindingQuote,
  type AutomaticQuotePricingItem,
  type AutomaticQuotePricingParameters,
} from "./automatic-quote-pricing";
import { candidatePlateCapacities } from "./candidate-plate-capacities";
import type {
  AttachAutomaticQuoteModelFileDto,
  AutomaticQuoteHandoffCapabilityDto,
  AutomaticQuoteSessionCreatedDto,
  AutomaticQuoteSessionDto,
  AutomaticQuoteRiskDecisionDto,
  ConfigureAutomaticQuoteItemDto,
  CreateAutomaticQuoteSessionDto,
  RecordAutomaticQuoteObservationDto,
  ReplaceAutomaticQuoteConfigurationDto,
  SelectAutomaticQuoteDestinationDto,
} from "./automatic-quotes.dto";
import {
  DELIVERY_CAPABILITY,
  type DeliveryCapabilityPort,
} from "./delivery-capability.port";
import {
  nextReferenceOccupancyProbe,
  recordReferenceOccupancyProbe,
  resolvedReferenceOccupancy,
} from "./reference-occupancy-probe";

const SESSION_DAYS = 30;
const HANDOFF_CAPABILITY_MINUTES = 15;
const IDEMPOTENCY_DAYS = 7;
const INSPECTION_REVISION = "inspection-v1";
const CANONICALIZER_REVISION = "canonical-v1";
const INSPECTION_CONFIG_SHA256 = createHash("sha256")
  .update("taven-inspection-v1")
  .digest("hex");
const CANONICALIZER_CONFIG_SHA256 = createHash("sha256")
  .update("taven-canonicalizer-v1")
  .digest("hex");
const MAX_ITEM_QUANTITY = 1_000;
const MAX_SLICING_JOB_ATTEMPTS = 100;
const AUTOMATIC_PRICE_LIST_REVISION =
  process.env.TAVEN_AUTOMATIC_PRICE_LIST_REVISION?.trim() || "automatic-v0-czk";
const CANDIDATE_UNUSABLE_DISPOSITION_TYPE =
  "automatic_quote.candidate-estimation.unusable";
const INFILL_PERCENT = {
  DECORATIVE: 10,
  STANDARD: 20,
  STRONG: 40,
} as const;

type Transaction = Prisma.TransactionClient;
type JsonRecord = Record<string, unknown>;
type AutomaticQuoteHandoffSnapshot = {
  reasons: string[];
  modelFileIds: string[];
  itemSelections: Array<{
    ordinal: number;
    modelFileId: string;
    bodyIds: string[];
    material: string;
    quantity: number;
    fitSensitive: boolean;
  }>;
};
type QuoteCapabilityKey = { id: string; key: string };
type AutomaticCandidateDispatchState = {
  attempt: number;
  outcome: "SUCCEEDED" | "FAILED" | null;
  failureClass: string | null;
  retryAfterMilliseconds: number | null;
  receiptCreatedAt: Date | null;
  expiresAt: Date | null;
  deadLettered: boolean;
};
type AutomaticCandidateFrontierRow = {
  shipmentPlanId: string;
  orderItemId: string;
  dispatchId: string | null;
  inputFingerprint: string | null;
  inventoryId: string | null;
  inventoryRemainingMilligrams: bigint | null;
  inventoryReservedMilligrams: bigint | null;
  inventoryStatus: string | null;
  inventoryUpdatedAt: Date | null;
  nodeId: string | null;
  attempt: number | null;
  outcome: "SUCCEEDED" | "FAILED" | null;
  failureClass: string | null;
  candidateId: string | null;
  expiresAt: Date | null;
  deadLettered: boolean | null;
};
type AutomaticCandidateCapacityFrontierRow = {
  id: string;
  nodeId: string;
  machineId: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  expiresAt: Date;
};
type AutomaticCandidateFrontier = {
  hash: string;
  quiescent: boolean;
  allFailedRequirement: boolean;
  missingOptionRequirement: boolean;
  successNodeIds: string[];
};
type PreprocessingDispatchState = {
  attempt: number;
  status: "succeeded" | "failed" | null;
  failureClass: string | null;
  failureCode: string | null;
  retryAfterMilliseconds: number | null;
  receiptCreatedAt: Date | null;
  deadLettered: boolean;
};
type PreprocessingDispatch = { attempt: number; availableAt?: Date };
type AutomaticQuoteCandidateDraftItem = {
  id: string;
  ordinal: number;
  sourceModelFileId: string;
  bodyIds: string[];
  selectionSha256: string;
  targetModelGeometryId: string;
  printConfigRevisionId: string;
  referenceProfileId: string;
  material: Material;
  color: string | null;
  infillPreset: string;
  quantity: number;
  referencePartsPerPlate: number | null;
  referenceProbeLowerBound: number;
  referenceProbeUpperBound: number;
};
type ProposedAutomaticQuoteDraftItem = AutomaticQuoteCandidateDraftItem & {
  fitSensitive: boolean;
  configurationFingerprint: string;
};
type ReferenceOccupancyResolution =
  | { kind: "resolved"; partsPerPlate: number }
  | { kind: "pending"; partsPerPlate: number }
  | { kind: "failed" };

@Injectable()
export class AutomaticQuotesService {
  constructor(
    @Inject(PrismaService)
    private readonly prisma: PrismaService,
    @Inject(CandidateEstimateService)
    private readonly candidateEstimates: CandidateEstimateService,
    @Inject(EligibilityPlanService)
    private readonly eligibilityPlans: EligibilityPlanService,
    @Inject(ResourceReservationService)
    private readonly resourceReservations: ResourceReservationService,
    @Inject(DELIVERY_CAPABILITY)
    private readonly deliveryCapabilities: DeliveryCapabilityPort,
  ) {}

  async createSession(
    input: CreateAutomaticQuoteSessionDto,
    clientAddress: string,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionCreatedDto> {
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const attribution = normalizeAttribution(input?.attribution);
    const capabilityRequests = quoteCapabilityKeyRing().all.map(
      (capabilityKey) => {
        const clientSubjectHash = automaticQuoteClientSubject(
          capabilityKey.key,
          clientAddress,
        );
        return {
          capabilityKey,
          clientSubjectHash,
          fingerprint: fingerprintOf({ attribution, clientSubjectHash }),
        };
      },
    );
    const currentCapabilityRequest = capabilityRequests[0]!;

    const created = await this.prisma.$transaction(async (transaction) => {
      const record = await lockIdempotency(
        transaction,
        "automatic-quote.create",
        commandKey,
        capabilityRequests.map(({ fingerprint }) => fingerprint),
      );
      if (record.replayed) {
        const stored = record.response as {
          sessionId: string;
          orderId: string;
        };
        const session = await transaction.quoteSession.findUniqueOrThrow({
          where: { id: stored.sessionId },
          select: { capabilityKeyId: true },
        });
        const replayRequest = capabilityRequests.find(
          ({ capabilityKey }) => capabilityKey.id === session.capabilityKeyId,
        );
        if (!replayRequest) {
          throw new Error(
            `Quote capability key ${session.capabilityKeyId || "<missing>"} is unavailable`,
          );
        }
        return {
          ...stored,
          sessionToken: sessionToken(
            replayRequest.capabilityKey.key,
            commandKey,
            replayRequest.fingerprint,
            record.generation,
          ),
        };
      }

      await reserveAnonymousQuote(
        transaction,
        currentCapabilityRequest.clientSubjectHash,
      );

      const observedAt = await databaseNow(transaction);
      const sessionId = randomUUID();
      const orderId = randomUUID();
      const publicReference = `A-${orderId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      const token = sessionToken(
        currentCapabilityRequest.capabilityKey.key,
        commandKey,
        currentCapabilityRequest.fingerprint,
        record.generation,
      );
      await transaction.quoteSession.create({
        data: {
          id: sessionId,
          publicTokenHash: hashToken(token),
          capabilityKeyId: currentCapabilityRequest.capabilityKey.id,
          attribution: jsonNullable(attribution ?? null),
          expiresAt: addDays(observedAt, SESSION_DAYS),
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      });
      await transaction.order.create({
        data: {
          id: orderId,
          publicReference,
          status: OrderStatus.DRAFT,
          createdAt: observedAt,
          updatedAt: observedAt,
        },
      });
      await transaction.automaticOrderOrigin.create({
        data: { orderId, quoteSessionId: sessionId },
      });
      await transaction.automaticQuoteDraft.create({
        data: { orderId, createdAt: observedAt, updatedAt: observedAt },
      });
      await completeIdempotency(transaction, record.id, {
        sessionId,
        orderId,
      });
      return { sessionId, orderId, sessionToken: token };
    });
    const view = await this.getSession(
      created.sessionId,
      `Bearer ${created.sessionToken}`,
    );
    return { ...view, sessionToken: created.sessionToken };
  }

  async getSession(
    sessionId: string,
    authorization: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const token = bearerCapability(authorization);
    const session = await this.loadSession(sessionId);
    assertSessionCapability(session, token);
    return this.readModel(session);
  }

  async recordObservation(
    sessionId: string,
    input: RecordAutomaticQuoteObservationDto,
    authorization: string | undefined,
  ): Promise<void> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const sessionCapability = bearerCapability(authorization);
    const eventType = input?.eventType;
    if (eventType !== "quote.viewed" && eventType !== "checkout.started") {
      throw new BadRequestException("eventType is invalid");
    }
    await this.prisma.$transaction(async (transaction) => {
      const session = await lockedSession(transaction, sessionId);
      assertOpenOrConvertedSession(session, sessionCapability);
      const origin = await transaction.automaticOrderOrigin.findUnique({
        where: { quoteSessionId: sessionId },
        select: { orderId: true },
      });
      if (!origin) throw new ConflictException("Automatic order is missing");
      const observedAt = await databaseNow(transaction);
      await transaction.businessEvent.upsert({
        where: {
          eventType_dedupeKey: {
            eventType,
            dedupeKey: `${sessionId}:${eventType}`,
          },
        },
        create: {
          eventType,
          dedupeKey: `${sessionId}:${eventType}`,
          observedAt,
          expiresAt: addDays(observedAt, 90),
          source: "CLIENT",
          quoteSessionId: sessionId,
          orderId: origin.orderId,
          payload: {},
        },
        update: {},
      });
    });
  }

  async createHandoffCapability(
    sessionId: string,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteHandoffCapabilityDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);

    return this.prisma.$transaction(async (transaction) => {
      const session = await lockedSession(transaction, sessionId);
      assertOpenSession(session, sessionCapability);
      const capabilityKey = quoteCapabilityKeyRing().byId.get(
        session.capabilityKeyId ?? "",
      );
      if (!capabilityKey) {
        throw new Error("Automatic quote capability key is unavailable");
      }
      const record = await lockIdempotency(
        transaction,
        `automatic-quote.handoff:${sessionId}`,
        commandKey,
        fingerprintOf({
          sessionId,
          sessionCapabilityHash: hashToken(sessionCapability),
        }),
      );
      if (record.replayed) {
        return handoffCapabilityResponse(
          capabilityKey.key,
          record.response as { handoffId: string; expiresAt: string },
        );
      }

      const source = await this.loadSession(sessionId);
      const snapshot = handoffSnapshot(await this.readModel(source));
      const observedAt = await databaseNow(transaction);
      const expiresAt = new Date(
        Math.min(
          session.expiresAt.getTime(),
          observedAt.getTime() + HANDOFF_CAPABILITY_MINUTES * 60_000,
        ),
      );
      if (expiresAt.getTime() <= observedAt.getTime()) {
        throw new GoneException(
          "Automatic quote session is no longer available",
        );
      }
      const handoffId = randomUUID();
      const response = {
        handoffId,
        expiresAt: expiresAt.toISOString(),
      };
      await transaction.automaticQuoteHandoffCapability.create({
        data: {
          id: handoffId,
          sourceQuoteSessionId: sessionId,
          tokenHash: hashToken(
            automaticQuoteHandoffToken(capabilityKey.key, handoffId),
          ),
          scope: AutomaticQuoteHandoffScope.ASSISTED_QUOTE_REQUEST,
          reasons: snapshot.reasons,
          modelFileIds: snapshot.modelFileIds,
          itemSelections: jsonSafe(snapshot.itemSelections),
          issuedAt: observedAt,
          expiresAt,
        },
      });
      await completeIdempotency(transaction, record.id, response);
      return handoffCapabilityResponse(capabilityKey.key, response);
    });
  }

  async attachModelFile(
    sessionId: string,
    input: AttachAutomaticQuoteModelFileDto,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const modelFileId = normalizedUuid(input?.modelFileId, "modelFileId");
    const uploadToken = bearerTokenValue(input?.uploadToken, "uploadToken");
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const fingerprint = fingerprintOf({ sessionId, modelFileId });

    await this.idempotentEffect(
      "automatic-quote.attach-model",
      commandKey,
      fingerprint,
      async (transaction) => {
        const locked = await lockedSession(transaction, sessionId);
        assertOpenSession(locked, sessionCapability);
        const intent = await transaction.uploadIntent.findFirst({
          where: {
            confirmedModelFileId: modelFileId,
            status: UploadIntentStatus.CONFIRMED,
          },
          include: { confirmedModelFile: true },
        });
        if (
          !intent?.confirmedModelFile ||
          !matchesTokenHash(uploadToken, intent.capabilityTokenHash)
        ) {
          throw new UnauthorizedException("Upload capability is invalid");
        }
        if (intent.confirmedModelFile.deletedAt) {
          throw new GoneException("Model source is no longer available");
        }
        const observedAt = await databaseNow(transaction);
        if (
          intent.confirmedModelFile.retentionHold === RetentionHold.NONE &&
          intent.confirmedModelFile.sourceDeleteAfter <= observedAt
        ) {
          throw new GoneException("Model source is no longer available");
        }
        const origin = await transaction.automaticOrderOrigin.findUnique({
          where: { quoteSessionId: sessionId },
        });
        if (!origin) throw new ConflictException("Automatic order is missing");
        const existing = await transaction.automaticQuoteModelFile.findUnique({
          where: {
            orderId_modelFileId: { orderId: origin.orderId, modelFileId },
          },
        });
        if (existing) return;
        if (
          (await transaction.orderItem.count({
            where: { orderId: origin.orderId },
          })) > 0
        ) {
          throw new ConflictException(
            "Model files cannot be attached after quote preparation starts",
          );
        }

        const inspectionJobId = deterministicUuid(
          `automatic-inspection:${modelFileId}:${INSPECTION_REVISION}:${INSPECTION_CONFIG_SHA256}`,
        );
        await transaction.automaticQuoteModelFile.create({
          data: {
            orderId: origin.orderId,
            modelFileId,
            inspectionJobId,
          },
        });
        if (intent.confirmedModelFile.format !== ModelFileFormat.STEP) {
          await enqueueInspection(transaction, {
            jobId: inspectionJobId,
            correlationId: origin.orderId,
            source: intent.confirmedModelFile,
            operation: { mode: "inspect_source" },
          });
        }
      },
    );
    return this.getSession(sessionId, authorization);
  }

  async configureItem(
    sessionId: string,
    ordinalValue: string,
    input: ConfigureAutomaticQuoteItemDto,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const ordinal = nonnegativeInteger(ordinalValue, "ordinal", 999);
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const configuration = await this.validateConfiguration(input);
    const fingerprint = fingerprintOf({ sessionId, ordinal, configuration });

    await this.idempotentEffect(
      "automatic-quote.configure-item",
      commandKey,
      fingerprint,
      async (transaction) => {
        const session = await lockedSession(transaction, sessionId);
        assertOpenSession(session, sessionCapability);
        const origin = await transaction.automaticOrderOrigin.findUnique({
          where: { quoteSessionId: sessionId },
        });
        if (!origin) throw new ConflictException("Automatic order is missing");
        if (
          (await transaction.orderItem.count({
            where: { orderId: origin.orderId },
          })) > 0
        ) {
          throw new ConflictException(
            "Configuration is frozen after quote preparation starts",
          );
        }
        const attached = await transaction.automaticQuoteModelFile.findUnique({
          where: {
            orderId_modelFileId: {
              orderId: origin.orderId,
              modelFileId: configuration.modelFileId,
            },
          },
          include: { modelFile: true },
        });
        if (!attached) {
          throw new BadRequestException("Model file is not attached");
        }
        const inspection = await terminalResultForJob(
          transaction,
          attached.inspectionJobId,
          "model_inspection",
        );
        const discoveredBodyIds = successfulInspectionBodies(inspection);
        if (
          discoveredBodyIds.length === 0 ||
          configuration.bodyIds.some(
            (bodyId) => !discoveredBodyIds.includes(bodyId),
          )
        ) {
          throw new ConflictException(
            "Selected bodies are not available in the completed inspection",
          );
        }
        const printConfig = await transaction.printConfigRevision.findUnique({
          where: { id: configuration.printConfigRevisionId },
        });
        if (
          !printConfig ||
          printConfig.infillPercent !==
            INFILL_PERCENT[configuration.infillPreset]
        ) {
          throw new BadRequestException(
            "Print configuration does not match the named infill preset",
          );
        }
        const selectedOption = (
          await this.configurationCapabilities(transaction)
        ).find(
          (option) =>
            option.printConfigRevisionId ===
              configuration.printConfigRevisionId &&
            option.material === configuration.material &&
            option.color === configuration.color &&
            option.quality === printConfig.quality &&
            option.infillPreset === configuration.infillPreset,
        );
        if (!selectedOption) {
          throw new BadRequestException(
            "Selected automatic quote configuration is unavailable",
          );
        }
        const { geometrySelectionSha256 } =
          await import("@taven/slicer-contracts");
        const selectionSha256 = geometrySelectionSha256(configuration.bodyIds);
        const targetModelGeometryId = deterministicUuid(
          `automatic-geometry:${configuration.modelFileId}:${selectionSha256}`,
        );
        const configurationFingerprint = fingerprintOf({
          ...configuration,
          referenceProfileId: selectedOption.referenceProfileId,
          selectionSha256,
          targetModelGeometryId,
        });
        const current = await transaction.automaticQuoteItemDraft.findUnique({
          where: { orderId_ordinal: { orderId: origin.orderId, ordinal } },
        });
        const priceList = await transaction.priceList.findUnique({
          where: {
            currency_revision: {
              currency: "CZK",
              revision: AUTOMATIC_PRICE_LIST_REVISION,
            },
          },
        });
        if (!priceList) {
          throw new ConflictException("Automatic quote pricing is unavailable");
        }
        const proposedItem = {
          id:
            current?.id ??
            deterministicUuid(`automatic-draft:${origin.orderId}:${ordinal}`),
          ordinal,
          sourceModelFileId: configuration.modelFileId,
          bodyIds: configuration.bodyIds,
          selectionSha256,
          targetModelGeometryId,
          printConfigRevisionId: configuration.printConfigRevisionId,
          referenceProfileId: selectedOption.referenceProfileId,
          material: configuration.material,
          color: configuration.color,
          infillPreset: configuration.infillPreset,
          quantity: configuration.quantity,
          referencePartsPerPlate: null,
          referenceProbeLowerBound: 0,
          referenceProbeUpperBound: configuration.quantity + 1,
        } satisfies AutomaticQuoteCandidateDraftItem;
        const proposedItems: AutomaticQuoteCandidateDraftItem[] = [
          ...(await transaction.automaticQuoteItemDraft.findMany({
            where: { orderId: origin.orderId, ordinal: { not: ordinal } },
          })),
          proposedItem,
        ].sort((left, right) => left.ordinal - right.ordinal);
        const proposedPricing = await this.pricingItemsFromDraft(
          transaction,
          origin.orderId,
          proposedItems,
          parseAutomaticQuotePricingParameters(priceList.parameters),
        );
        if (
          !proposedPricing ||
          !(await this.draftInventoryAvailable(
            transaction,
            proposedItems,
            proposedPricing.items,
          ))
        ) {
          throw new BadRequestException(
            "Selected automatic quote configuration lacks sufficient inventory",
          );
        }
        if (current?.configurationFingerprint === configurationFingerprint) {
          return;
        }
        await transaction.automaticQuoteItemDraft.upsert({
          where: { orderId_ordinal: { orderId: origin.orderId, ordinal } },
          create: {
            orderId: origin.orderId,
            ordinal,
            sourceModelFileId: configuration.modelFileId,
            bodyIds: configuration.bodyIds,
            selectionSha256,
            targetModelGeometryId,
            printConfigRevisionId: configuration.printConfigRevisionId,
            referenceProfileId: selectedOption.referenceProfileId,
            material: configuration.material,
            color: configuration.color,
            infillPreset: configuration.infillPreset,
            quantity: configuration.quantity,
            fitSensitive: configuration.fitSensitive,
            referencePartsPerPlate: null,
            referenceProbeLowerBound: 0,
            referenceProbeUpperBound: configuration.quantity + 1,
            configurationFingerprint,
          },
          update: {
            sourceModelFileId: configuration.modelFileId,
            bodyIds: configuration.bodyIds,
            selectionSha256,
            targetModelGeometryId,
            printConfigRevisionId: configuration.printConfigRevisionId,
            referenceProfileId: selectedOption.referenceProfileId,
            material: configuration.material,
            color: configuration.color,
            infillPreset: configuration.infillPreset,
            quantity: configuration.quantity,
            fitSensitive: configuration.fitSensitive,
            referencePartsPerPlate: null,
            referenceProbeLowerBound: 0,
            referenceProbeUpperBound: configuration.quantity + 1,
            configurationFingerprint,
          },
        });
        await transaction.automaticQuoteDraft.update({
          where: { orderId: origin.orderId },
          data: { configurationRevision: { increment: 1 } },
        });
      },
    );
    return this.getSession(sessionId, authorization);
  }

  async replaceConfiguration(
    sessionId: string,
    input: ReplaceAutomaticQuoteConfigurationDto,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    if (
      !Array.isArray(input?.items) ||
      input.items.length === 0 ||
      input.items.length > 256
    ) {
      throw new BadRequestException("items must contain 1 through 256 groups");
    }
    const configurations = await Promise.all(
      input.items.map(async (item) => ({
        ordinal: nonnegativeInteger(item?.ordinal, "ordinal", 999),
        configuration: await this.validateConfiguration(item),
      })),
    );
    if (
      new Set(configurations.map(({ ordinal }) => ordinal)).size !==
      configurations.length
    ) {
      throw new BadRequestException("item ordinals must be unique");
    }
    const selectedBodies = configurations.flatMap(({ configuration }) =>
      configuration.bodyIds.map(
        (bodyId) => `${configuration.modelFileId}\0${bodyId}`,
      ),
    );
    if (new Set(selectedBodies).size !== selectedBodies.length) {
      throw new BadRequestException(
        "selected bodies cannot appear in more than one item",
      );
    }
    configurations.sort((left, right) => left.ordinal - right.ordinal);
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const fingerprint = fingerprintOf({ sessionId, configurations });
    const { geometrySelectionSha256 } = await import("@taven/slicer-contracts");

    await this.idempotentEffect(
      "automatic-quote.replace-configuration",
      commandKey,
      fingerprint,
      async (transaction) => {
        const session = await lockedSession(transaction, sessionId);
        assertOpenSession(session, sessionCapability);
        const origin = await transaction.automaticOrderOrigin.findUnique({
          where: { quoteSessionId: sessionId },
        });
        if (!origin) throw new ConflictException("Automatic order is missing");
        if (
          (await transaction.orderItem.count({
            where: { orderId: origin.orderId },
          })) > 0
        ) {
          throw new ConflictException(
            "Configuration is frozen after quote preparation starts",
          );
        }
        const currentItems = await transaction.automaticQuoteItemDraft.findMany(
          {
            where: { orderId: origin.orderId },
          },
        );
        const currentByOrdinal = new Map(
          currentItems.map((item) => [item.ordinal, item]),
        );
        const capabilities = await this.configurationCapabilities(transaction);
        const proposedItems: ProposedAutomaticQuoteDraftItem[] = [];
        for (const { ordinal, configuration } of configurations) {
          const attached = await transaction.automaticQuoteModelFile.findUnique(
            {
              where: {
                orderId_modelFileId: {
                  orderId: origin.orderId,
                  modelFileId: configuration.modelFileId,
                },
              },
            },
          );
          if (!attached) {
            throw new BadRequestException("Model file is not attached");
          }
          const inspection = await terminalResultForJob(
            transaction,
            attached.inspectionJobId,
            "model_inspection",
          );
          const discoveredBodyIds = successfulInspectionBodies(inspection);
          if (
            discoveredBodyIds.length === 0 ||
            configuration.bodyIds.some(
              (bodyId) => !discoveredBodyIds.includes(bodyId),
            )
          ) {
            throw new ConflictException(
              "Selected bodies are not available in the completed inspection",
            );
          }
          const printConfig = await transaction.printConfigRevision.findUnique({
            where: { id: configuration.printConfigRevisionId },
          });
          if (
            !printConfig ||
            printConfig.infillPercent !==
              INFILL_PERCENT[configuration.infillPreset]
          ) {
            throw new BadRequestException(
              "Print configuration does not match the named infill preset",
            );
          }
          const selectedOption = capabilities.find(
            (option) =>
              option.printConfigRevisionId ===
                configuration.printConfigRevisionId &&
              option.material === configuration.material &&
              option.color === configuration.color &&
              option.quality === printConfig.quality &&
              option.infillPreset === configuration.infillPreset,
          );
          if (!selectedOption) {
            throw new BadRequestException(
              "Selected automatic quote configuration is unavailable",
            );
          }
          const selectionSha256 = geometrySelectionSha256(
            configuration.bodyIds,
          );
          const targetModelGeometryId = deterministicUuid(
            `automatic-geometry:${configuration.modelFileId}:${selectionSha256}`,
          );
          const configurationFingerprint = fingerprintOf({
            ...configuration,
            referenceProfileId: selectedOption.referenceProfileId,
            selectionSha256,
            targetModelGeometryId,
          });
          proposedItems.push({
            id:
              currentByOrdinal.get(ordinal)?.id ??
              deterministicUuid(`automatic-draft:${origin.orderId}:${ordinal}`),
            ordinal,
            sourceModelFileId: configuration.modelFileId,
            bodyIds: configuration.bodyIds,
            selectionSha256,
            targetModelGeometryId,
            printConfigRevisionId: configuration.printConfigRevisionId,
            referenceProfileId: selectedOption.referenceProfileId,
            material: configuration.material,
            color: configuration.color,
            infillPreset: configuration.infillPreset,
            quantity: configuration.quantity,
            fitSensitive: configuration.fitSensitive,
            referencePartsPerPlate: null,
            referenceProbeLowerBound: 0,
            referenceProbeUpperBound: configuration.quantity + 1,
            configurationFingerprint,
          });
        }
        const priceList = await transaction.priceList.findUnique({
          where: {
            currency_revision: {
              currency: "CZK",
              revision: AUTOMATIC_PRICE_LIST_REVISION,
            },
          },
        });
        if (!priceList) {
          throw new ConflictException("Automatic quote pricing is unavailable");
        }
        const proposedPricing = await this.pricingItemsFromDraft(
          transaction,
          origin.orderId,
          proposedItems,
          parseAutomaticQuotePricingParameters(priceList.parameters),
        );
        if (
          !proposedPricing ||
          !(await this.draftInventoryAvailable(
            transaction,
            proposedItems,
            proposedPricing.items,
          ))
        ) {
          throw new BadRequestException(
            "Selected automatic quote configuration lacks sufficient inventory",
          );
        }
        const unchanged =
          currentItems.length === proposedItems.length &&
          proposedItems.every(
            (item) =>
              currentByOrdinal.get(item.ordinal)?.configurationFingerprint ===
              item.configurationFingerprint,
          );
        if (unchanged) return;

        await transaction.automaticQuoteRiskDecisionRecord.deleteMany({
          where: { orderId: origin.orderId },
        });
        await transaction.automaticQuoteItemDraft.deleteMany({
          where: { orderId: origin.orderId },
        });
        await transaction.automaticQuoteItemDraft.createMany({
          data: proposedItems.map((item) => ({
            id: item.id,
            orderId: origin.orderId,
            ordinal: item.ordinal,
            sourceModelFileId: item.sourceModelFileId,
            bodyIds: item.bodyIds,
            selectionSha256: item.selectionSha256,
            targetModelGeometryId: item.targetModelGeometryId,
            printConfigRevisionId: item.printConfigRevisionId,
            referenceProfileId: item.referenceProfileId,
            material: item.material,
            color: item.color,
            infillPreset: item.infillPreset,
            quantity: item.quantity,
            fitSensitive: item.fitSensitive,
            referencePartsPerPlate: item.referencePartsPerPlate,
            referenceProbeLowerBound: item.referenceProbeLowerBound,
            referenceProbeUpperBound: item.referenceProbeUpperBound,
            configurationFingerprint: item.configurationFingerprint,
          })),
        });
        await transaction.automaticQuoteDraft.update({
          where: { orderId: origin.orderId },
          data: { configurationRevision: { increment: 1 } },
        });
      },
    );
    return this.getSession(sessionId, authorization);
  }

  async removeItem(
    sessionId: string,
    ordinalValue: string,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const ordinal = nonnegativeInteger(ordinalValue, "ordinal", 999);
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const fingerprint = fingerprintOf({ sessionId, ordinal });

    await this.idempotentEffect(
      "automatic-quote.remove-item",
      commandKey,
      fingerprint,
      async (transaction) => {
        const session = await lockedSession(transaction, sessionId);
        assertOpenSession(session, sessionCapability);
        const origin = await transaction.automaticOrderOrigin.findUnique({
          where: { quoteSessionId: sessionId },
        });
        if (!origin) throw new ConflictException("Automatic order is missing");
        if (
          (await transaction.orderItem.count({
            where: { orderId: origin.orderId },
          })) > 0
        ) {
          throw new ConflictException(
            "Configuration is frozen after quote preparation starts",
          );
        }
        const current = await transaction.automaticQuoteItemDraft.findUnique({
          where: { orderId_ordinal: { orderId: origin.orderId, ordinal } },
        });
        if (!current) return;
        await transaction.automaticQuoteRiskDecisionRecord.deleteMany({
          where: { automaticQuoteItemId: current.id },
        });
        await transaction.automaticQuoteItemDraft.delete({
          where: { id: current.id },
        });
        await transaction.automaticQuoteDraft.update({
          where: { orderId: origin.orderId },
          data: { configurationRevision: { increment: 1 } },
        });
      },
    );
    return this.getSession(sessionId, authorization);
  }

  async decideRisk(
    sessionId: string,
    input: AutomaticQuoteRiskDecisionDto,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const itemOrdinal = nonnegativeInteger(
      input?.itemOrdinal,
      "itemOrdinal",
      999,
    );
    const findingId = normalizedUuid(input?.findingId, "findingId");
    const acknowledgementKey = safeIdentifier(
      input?.acknowledgementKey,
      "acknowledgementKey",
    );
    if (!Object.values(AutomaticQuoteRiskDecision).includes(input?.decision)) {
      throw new BadRequestException("decision is invalid");
    }
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const fingerprint = fingerprintOf({
      sessionId,
      itemOrdinal,
      findingId,
      acknowledgementKey,
      decision: input.decision,
    });
    await this.idempotentEffect(
      "automatic-quote.risk-decision",
      commandKey,
      fingerprint,
      async (transaction) => {
        const session = await lockedSession(transaction, sessionId);
        assertOpenSession(session, sessionCapability);
        const item = await transaction.automaticQuoteItemDraft.findFirst({
          where: {
            draft: {
              order: { automaticOrigin: { quoteSessionId: sessionId } },
            },
            ordinal: itemOrdinal,
          },
        });
        if (!item)
          throw new NotFoundException("Automatic quote item was not found");
        const decisionIdentity = {
          automaticQuoteItemId: item.id,
          preflightFindingId: findingId,
          configurationFingerprint: item.configurationFingerprint,
        };
        const current =
          await transaction.automaticQuoteRiskDecisionRecord.findUnique({
            where: {
              automaticQuoteItemId_preflightFindingId_configurationFingerprint:
                decisionIdentity,
            },
          });
        if (
          current?.acknowledgementKey === acknowledgementKey &&
          current.decision === input.decision
        ) {
          return;
        }
        await transaction.automaticQuoteRiskDecisionRecord.upsert({
          where: {
            automaticQuoteItemId_preflightFindingId_configurationFingerprint:
              decisionIdentity,
          },
          create: {
            orderId: item.orderId,
            ...decisionIdentity,
            acknowledgementKey,
            decision: input.decision,
          },
          update: { acknowledgementKey, decision: input.decision },
        });
        await transaction.automaticQuoteDraft.update({
          where: { orderId: item.orderId },
          data: { configurationRevision: { increment: 1 } },
        });
      },
    );
    await this.releaseSupersededReservations(sessionId);
    return this.getSession(sessionId, authorization);
  }

  async selectDestination(
    sessionId: string,
    input: SelectAutomaticQuoteDestinationDto,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const providerEndpointId = requiredText(
      input?.providerEndpointId,
      "providerEndpointId",
      255,
    );
    const endpointType = requiredText(input?.endpointType, "endpointType", 100);
    const fingerprint = fingerprintOf({
      sessionId,
      providerEndpointId,
      endpointType,
    });
    await this.idempotentEffect(
      "automatic-quote.select-destination",
      commandKey,
      fingerprint,
      async (transaction) => {
        const session = await lockedSession(transaction, sessionId);
        assertOpenOrConvertedSession(session, sessionCapability);
        const resolved = await this.deliveryCapabilities.resolve({
          providerEndpointId,
          endpointType,
        });
        const origin = await transaction.automaticOrderOrigin.findUnique({
          where: { quoteSessionId: sessionId },
        });
        if (!origin) throw new ConflictException("Automatic order is missing");
        const draft = await transaction.automaticQuoteDraft.findUniqueOrThrow({
          where: { orderId: origin.orderId },
          include: {
            order: { select: { acceptedOrderPriceBindingId: true } },
            selectedDeliveryDestination: true,
          },
        });
        const current = draft.selectedDeliveryDestination;
        if (
          current &&
          current.providerEndpointId === resolved.providerEndpointId &&
          current.endpointType === resolved.endpointType &&
          fingerprintOf(current.addressSnapshot) ===
            fingerprintOf(resolved.addressSnapshot) &&
          fingerprintOf(current.capabilitySnapshot) ===
            fingerprintOf(resolved.capabilitySnapshot)
        ) {
          return;
        }
        if (draft.order.acceptedOrderPriceBindingId) {
          throw new ConflictException(
            "Delivery destination is immutable after checkout acceptance",
          );
        }
        const destination = await transaction.deliveryDestination.create({
          data: {
            orderId: origin.orderId,
            providerEndpointId: resolved.providerEndpointId,
            endpointType: resolved.endpointType,
            addressSnapshot: resolved.addressSnapshot,
            capabilitySnapshot: resolved.capabilitySnapshot,
          },
        });
        await transaction.automaticQuoteDraft.update({
          where: { orderId: origin.orderId },
          data: {
            selectedDeliveryDestinationId: destination.id,
            configurationRevision: { increment: 1 },
          },
        });
      },
    );
    await this.releaseSupersededReservations(sessionId);
    return this.getSession(sessionId, authorization);
  }

  async setExpress(
    sessionId: string,
    requested: boolean,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    if (typeof requested !== "boolean") {
      throw new BadRequestException("requested must be boolean");
    }
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const fingerprint = fingerprintOf({ sessionId, requested });
    await this.idempotentEffect(
      "automatic-quote.set-express",
      commandKey,
      fingerprint,
      async (transaction) => {
        const session = await lockedSession(transaction, sessionId);
        assertOpenSession(session, sessionCapability);
        const origin = await transaction.automaticOrderOrigin.findUnique({
          where: { quoteSessionId: sessionId },
        });
        if (!origin) throw new ConflictException("Automatic order is missing");
        const draft = await transaction.automaticQuoteDraft.findUniqueOrThrow({
          where: { orderId: origin.orderId },
        });
        if (draft.expressRequested === requested) return;
        if (
          requested &&
          (await transaction.orderPriceBinding.findFirst({
            where: { orderId: origin.orderId },
          }))
        ) {
          throw new ConflictException(
            "Express cannot be enabled after quote preparation starts",
          );
        }
        await transaction.automaticQuoteDraft.update({
          where: { orderId: origin.orderId },
          data: {
            expressRequested: requested,
            configurationRevision: { increment: 1 },
          },
        });
      },
    );
    await this.releaseSupersededReservations(sessionId);
    return this.getSession(sessionId, authorization);
  }

  async prepare(
    sessionId: string,
    authorization: string | undefined,
    idempotencyKey: string | undefined,
  ): Promise<AutomaticQuoteSessionDto> {
    sessionId = normalizedUuid(sessionId, "sessionId");
    const sessionCapability = bearerCapability(authorization);
    const commandKey = requireIdempotencyKey(idempotencyKey);
    const session = await this.loadSession(sessionId);
    assertSessionCapability(session, sessionCapability);
    assertBindingQuoteFlowsEnabled();
    await this.idempotentEffect(
      "automatic-quote.prepare",
      commandKey,
      async (transaction) => {
        const locked = await lockedSession(transaction, sessionId);
        assertOpenOrConvertedSession(locked, sessionCapability);
        const draft = await transaction.automaticQuoteDraft.findFirst({
          where: { order: { automaticOrigin: { quoteSessionId: sessionId } } },
          select: { configurationRevision: true },
        });
        if (!draft) throw new ConflictException("Automatic order is missing");
        return fingerprintOf({
          sessionId,
          configurationRevision: draft.configurationRevision,
        });
      },
      async (transaction) => {
        const locked = await lockedSession(transaction, sessionId);
        assertOpenOrConvertedSession(locked, sessionCapability);
        const order = await transaction.order.findFirst({
          where: { automaticOrigin: { quoteSessionId: sessionId } },
          include: {
            automaticQuoteDraft: {
              include: { items: { orderBy: { ordinal: "asc" } } },
            },
          },
        });
        const draft = order?.automaticQuoteDraft;
        if (!order || !draft)
          throw new ConflictException("Automatic order is missing");
        if (draft.items.length === 0) return;
        let enqueued = false;
        for (const item of draft.items) {
          const geometry = await transaction.modelGeometry.findUnique({
            where: { id: item.targetModelGeometryId },
          });
          if (!geometry) {
            await this.enqueueCanonicalization(transaction, item, order.id);
            enqueued = true;
            continue;
          }
          const occupancy = await this.resolveReferenceOccupancy(
            transaction,
            item,
            geometry,
            order.id,
            true,
          );
          if (occupancy.kind === "failed") {
            enqueued = true;
            continue;
          }
          if (occupancy.kind === "pending") {
            await this.enqueueReferenceSlice(
              transaction,
              item,
              geometry,
              occupancy.partsPerPlate,
              order.id,
            );
            enqueued = true;
            continue;
          }
          const missing = await this.missingReferenceSlices(
            transaction,
            item,
            geometry,
            referenceOccupancies(item.quantity, occupancy.partsPerPlate),
          );
          for (const partsPerPlate of missing) {
            await this.enqueueReferenceSlice(
              transaction,
              item,
              geometry,
              partsPerPlate,
              order.id,
            );
            enqueued = true;
          }
        }
        if (enqueued) return;
        await this.stageOrFinalizeBinding(transaction, order.id);
      },
    );
    await this.advanceEligibility(session.automaticOrderOrigin!.order.id);
    return this.getSession(sessionId, authorization);
  }

  private async idempotentEffect(
    namespace: string,
    idempotencyKey: string,
    fingerprint: string | ((transaction: Transaction) => Promise<string>),
    operation: (transaction: Transaction) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await lockIdempotencyKey(transaction, namespace, idempotencyKey);
      const resolvedFingerprint =
        typeof fingerprint === "string"
          ? fingerprint
          : await fingerprint(transaction);
      const record = await idempotencyRecordAfterLock(
        transaction,
        namespace,
        idempotencyKey,
        resolvedFingerprint,
      );
      if (record.replayed) return;
      await operation(transaction);
      await completeIdempotency(transaction, record.id, { completed: true });
    });
  }

  private async validateConfiguration(input: ConfigureAutomaticQuoteItemDto) {
    const modelFileId = normalizedUuid(input?.modelFileId, "modelFileId");
    const printConfigRevisionId = normalizedUuid(
      input?.printConfigRevisionId,
      "printConfigRevisionId",
    );
    if (
      !Array.isArray(input?.bodyIds) ||
      input.bodyIds.length === 0 ||
      input.bodyIds.length > 256
    ) {
      throw new BadRequestException(
        "bodyIds must contain 1 through 256 bodies",
      );
    }
    const bodyIds = [
      ...new Set(
        input.bodyIds.map((bodyId) => safeIdentifier(bodyId, "bodyId")),
      ),
    ].sort();
    if (bodyIds.length !== input.bodyIds.length) {
      throw new BadRequestException("bodyIds must be unique");
    }
    if (!Object.values(Material).includes(input.material as Material)) {
      throw new BadRequestException("material is invalid");
    }
    if (!(input.infillPreset in INFILL_PERCENT)) {
      throw new BadRequestException("infillPreset is invalid");
    }
    const quantity = positiveInteger(
      input.quantity,
      "quantity",
      MAX_ITEM_QUANTITY,
    );
    return {
      modelFileId,
      bodyIds,
      printConfigRevisionId,
      material: input.material as Material,
      color: optionalText(input.color, "color", 100),
      infillPreset: input.infillPreset,
      quantity,
      fitSensitive: input.fitSensitive === true,
    };
  }

  private async enqueueCanonicalization(
    transaction: Transaction,
    item: {
      id: string;
      sourceModelFileId: string;
      bodyIds: string[];
      selectionSha256: string;
      targetModelGeometryId: string;
    },
    correlationId: string,
  ): Promise<void> {
    const source = await transaction.modelFile.findUniqueOrThrow({
      where: { id: item.sourceModelFileId },
    });
    const sourceInput = inspectionInput(source, { mode: "inspect_source" });
    const { slicingInputFingerprint } = await import("@taven/slicer-contracts");
    const jobId = deterministicUuid(
      `canonicalization:${item.id}:${item.selectionSha256}`,
    );
    const dispatch = await this.nextPreprocessingAttempt(
      transaction,
      jobId,
      "slicing.model-inspection.requested",
    );
    if (!dispatch) return;
    await enqueueInspection(transaction, {
      jobId,
      correlationId,
      source,
      ...dispatch,
      operation: {
        mode: "canonicalize_selection",
        sourceInspectionFingerprintSha256: slicingInputFingerprint(
          "model_inspection",
          sourceInput,
        ),
        bodyIds: item.bodyIds,
        selectionSha256: item.selectionSha256,
        confirmedUnitConversion: {
          sourceUnit: "millimeter",
          targetUnit: "millimeter",
          scaleFactorPpm: 1_000_000,
        },
        targetGeometry: {
          modelGeometryId: item.targetModelGeometryId,
          canonicalObjectKey: `geometries/${item.targetModelGeometryId}/canonical`,
        },
      },
    });
  }

  private async enqueueReferenceSlice(
    transaction: Transaction,
    item: {
      id: string;
      bodyIds: string[];
      selectionSha256: string;
      printConfigRevisionId: string;
      referenceProfileId: string;
    },
    geometry: {
      id: string;
      sourceModelFileId: string;
      canonicalObjectKey: string;
      geometryHash: string;
      sourceModelFile?: never;
    },
    partsPerPlate: number,
    correlationId: string,
  ): Promise<void> {
    const initialJob = await this.referenceSliceJob(
      transaction,
      item,
      geometry,
      partsPerPlate,
      correlationId,
      1,
    );
    const dispatch = await this.nextPreprocessingAttempt(
      transaction,
      initialJob.jobId,
      "slicing.reference-slice.requested",
    );
    if (!dispatch) return;
    const { ReferenceSliceJobSchema, slicingDispatchAttemptKey } =
      await import("@taven/slicer-contracts");
    const job = ReferenceSliceJobSchema.parse({
      ...initialJob,
      attempt: dispatch.attempt,
    });
    await transaction.outboxMessage.upsert({
      where: {
        deduplicationKey: slicingDispatchAttemptKey(
          job.idempotencyKey,
          dispatch.attempt,
        ),
      },
      create: {
        deduplicationKey: slicingDispatchAttemptKey(
          job.idempotencyKey,
          dispatch.attempt,
        ),
        aggregateType: "ReferenceSliceDispatch",
        aggregateId: job.jobId,
        messageType: "slicing.reference-slice.requested",
        schemaVersion: 2,
        payload: { job } as unknown as Prisma.InputJsonObject,
        ...(dispatch.availableAt ? { availableAt: dispatch.availableAt } : {}),
      },
      update: {},
    });
  }

  private async referenceSliceJob(
    transaction: Transaction | PrismaService,
    item: {
      id: string;
      bodyIds: string[];
      selectionSha256: string;
      printConfigRevisionId: string;
      referenceProfileId: string;
    },
    geometry: {
      id: string;
      sourceModelFileId: string;
      canonicalObjectKey: string;
      geometryHash: string;
      sourceModelFile?: never;
    },
    partsPerPlate: number,
    correlationId: string,
    attempt: number,
  ) {
    const [source, profile, config] = await Promise.all([
      transaction.modelFile.findUniqueOrThrow({
        where: { id: geometry.sourceModelFileId },
      }),
      transaction.referenceProfile.findUniqueOrThrow({
        where: { id: item.referenceProfileId },
      }),
      transaction.printConfigRevision.findUniqueOrThrow({
        where: { id: item.printConfigRevisionId },
      }),
    ]);
    const input = {
      geometry: {
        sourceModelFileId: source.id,
        sourceContentSha256: source.contentHash,
        modelGeometryId: geometry.id,
        canonicalObjectKey: geometry.canonicalObjectKey,
        geometrySha256: geometry.geometryHash,
        bodyIds: item.bodyIds,
        selectionSha256: item.selectionSha256,
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
      partsPerPlate,
    };
    const { ReferenceSliceJobSchema, slicingInputFingerprint } =
      await import("@taven/slicer-contracts");
    const jobId = deterministicUuid(
      `reference:${item.id}:${partsPerPlate}:${fingerprintOf(input)}`,
    );
    const inputFingerprintSha256 = slicingInputFingerprint(
      "reference_slice",
      input,
    );
    const job = ReferenceSliceJobSchema.parse({
      contractVersion: 2,
      kind: "reference_slice",
      jobId,
      correlationId,
      inputFingerprintSha256,
      idempotencyKey: `slicer:v2:reference_slice:${jobId}:${inputFingerprintSha256}`,
      attempt,
      input,
    });
    return job;
  }

  private async nextPreprocessingAttempt(
    transaction: Transaction,
    jobId: string,
    messageType:
      | "slicing.model-inspection.requested"
      | "slicing.reference-slice.requested",
  ): Promise<PreprocessingDispatch | null> {
    const latest = await this.latestPreprocessingDispatch(
      transaction,
      jobId,
      messageType,
    );
    if (!latest) return { attempt: 1 };
    if (latest.deadLettered || latest.status === null) return null;
    if (
      latest.status === "failed" &&
      latest.failureClass === "retryable_infrastructure" &&
      latest.attempt < MAX_SLICING_JOB_ATTEMPTS
    ) {
      return {
        attempt: latest.attempt + 1,
        ...(latest.receiptCreatedAt && latest.retryAfterMilliseconds
          ? {
              availableAt: new Date(
                latest.receiptCreatedAt.getTime() +
                  latest.retryAfterMilliseconds,
              ),
            }
          : {}),
      };
    }
    return null;
  }

  private async latestPreprocessingDispatch(
    transaction: Transaction | PrismaService,
    jobId: string,
    messageType:
      | "slicing.model-inspection.requested"
      | "slicing.reference-slice.requested",
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
    const states = await transaction.$queryRaw<PreprocessingDispatchState[]>`
      SELECT
        (dispatch.payload #>> '{job,attempt}')::integer AS attempt,
        terminal.status,
        terminal.failure_class AS "failureClass",
        terminal.failure_code AS "failureCode",
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
          receipt.payload #>> '{result,outcome,code}' AS failure_code,
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
    return states[0];
  }

  private async resolveReferenceOccupancy(
    transaction: Transaction | PrismaService,
    item: AutomaticQuoteCandidateDraftItem,
    geometry: {
      id: string;
      sourceModelFileId: string;
      canonicalObjectKey: string;
      geometryHash: string;
      sourceModelFile?: never;
    },
    correlationId: string,
    persist: boolean,
  ): Promise<ReferenceOccupancyResolution> {
    if (item.referencePartsPerPlate !== null) {
      return { kind: "resolved", partsPerPlate: item.referencePartsPerPlate };
    }
    let bounds = {
      lowerBound: item.referenceProbeLowerBound,
      upperBound: item.referenceProbeUpperBound,
    };
    for (;;) {
      const resolved = resolvedReferenceOccupancy(item.quantity, bounds);
      if (resolved !== undefined) {
        if (resolved === null) return { kind: "failed" };
        if (persist) {
          await transaction.automaticQuoteItemDraft.update({
            where: { id: item.id },
            data: {
              referencePartsPerPlate: resolved,
              referenceProbeLowerBound: bounds.lowerBound,
              referenceProbeUpperBound: bounds.upperBound,
            },
          });
        }
        return { kind: "resolved", partsPerPlate: resolved };
      }
      const partsPerPlate = nextReferenceOccupancyProbe(item.quantity, bounds);
      if (partsPerPlate === null) {
        throw new Error("Reference occupancy probe did not resolve");
      }
      const missing = await this.missingReferenceSlices(
        transaction,
        item,
        geometry,
        [partsPerPlate],
      );
      if (missing.length === 0) {
        bounds = recordReferenceOccupancyProbe(
          item.quantity,
          bounds,
          partsPerPlate,
          true,
        );
        if (persist) {
          await transaction.automaticQuoteItemDraft.update({
            where: { id: item.id },
            data: {
              referenceProbeLowerBound: bounds.lowerBound,
              referenceProbeUpperBound: bounds.upperBound,
            },
          });
        }
        continue;
      }
      const job = await this.referenceSliceJob(
        transaction,
        item,
        geometry,
        partsPerPlate,
        correlationId,
        1,
      );
      const dispatch = await this.latestPreprocessingDispatch(
        transaction,
        job.jobId,
        "slicing.reference-slice.requested",
      );
      if (!this.referenceProbeDoesNotFit(dispatch)) {
        return this.preprocessingDispatchRequiresHandoff(dispatch)
          ? { kind: "failed" }
          : { kind: "pending", partsPerPlate };
      }
      bounds = recordReferenceOccupancyProbe(
        item.quantity,
        bounds,
        partsPerPlate,
        false,
      );
      if (persist) {
        await transaction.automaticQuoteItemDraft.update({
          where: { id: item.id },
          data: {
            referenceProbeLowerBound: bounds.lowerBound,
            referenceProbeUpperBound: bounds.upperBound,
          },
        });
      }
    }
  }

  private referenceProbeDoesNotFit(
    dispatch: PreprocessingDispatchState | undefined,
  ): boolean {
    // Orca reports an over-full one-plate arrangement through the same bounded
    // failure codes. Probing downward distinguishes that case from a model that
    // cannot be sliced even at one copy, which converges to the failed frontier.
    return (
      dispatch?.status === "failed" &&
      !dispatch.deadLettered &&
      dispatch.failureClass === "deterministic_invalid" &&
      (dispatch.failureCode === "INVALID_GEOMETRY" ||
        dispatch.failureCode === "RESOURCE_LIMIT_EXCEEDED")
    );
  }

  private preprocessingDispatchRequiresHandoff(
    dispatch: PreprocessingDispatchState | undefined,
  ): boolean {
    if (!dispatch) return false;
    if (dispatch.deadLettered) return true;
    if (dispatch.status !== "failed") return false;
    return (
      dispatch.failureClass !== "retryable_infrastructure" ||
      dispatch.attempt >= MAX_SLICING_JOB_ATTEMPTS
    );
  }

  private async preprocessingRequiresHandoff(
    orderId: string,
    items: readonly AutomaticQuoteCandidateDraftItem[],
  ): Promise<boolean> {
    for (const item of items) {
      const geometry = await this.prisma.modelGeometry.findUnique({
        where: { id: item.targetModelGeometryId },
      });
      if (!geometry) {
        const dispatch = await this.latestPreprocessingDispatch(
          this.prisma,
          deterministicUuid(
            `canonicalization:${item.id}:${item.selectionSha256}`,
          ),
          "slicing.model-inspection.requested",
        );
        if (this.preprocessingDispatchRequiresHandoff(dispatch)) return true;
        continue;
      }
      const occupancy = await this.resolveReferenceOccupancy(
        this.prisma,
        item,
        geometry,
        orderId,
        false,
      );
      if (occupancy.kind === "failed") return true;
      if (occupancy.kind === "pending") continue;
      const missing = await this.missingReferenceSlices(
        this.prisma,
        item,
        geometry,
        referenceOccupancies(item.quantity, occupancy.partsPerPlate),
      );
      for (const partsPerPlate of missing) {
        const job = await this.referenceSliceJob(
          this.prisma,
          item,
          geometry,
          partsPerPlate,
          orderId,
          1,
        );
        const dispatch = await this.latestPreprocessingDispatch(
          this.prisma,
          job.jobId,
          "slicing.reference-slice.requested",
        );
        if (this.preprocessingDispatchRequiresHandoff(dispatch)) return true;
      }
    }
    const [draft, priceList] = await Promise.all([
      this.prisma.automaticQuoteDraft.findUnique({
        where: { orderId },
        include: { selectedDeliveryDestination: true },
      }),
      this.prisma.priceList.findUnique({
        where: {
          currency_revision: {
            currency: "CZK",
            revision: AUTOMATIC_PRICE_LIST_REVISION,
          },
        },
      }),
    ]);
    if (!draft?.selectedDeliveryDestination || !priceList) return false;
    const pricing = await this.pricingItemsFromDraft(
      this.prisma,
      orderId,
      items,
      null,
    );
    if (!pricing) return false;
    const provisional = await prepareAutomaticQuote({
      priceList,
      items: pricing.items,
      expressRequested: draft.expressRequested,
      materialAndColorAvailable: true,
      withinBuildLimits: true,
      riskAcknowledgementsComplete: true,
      hasBlockingPreflightFinding: false,
      deliveryDestination: draft.selectedDeliveryDestination,
      shipmentPlanIdForOrdinal: (ordinal) =>
        deterministicUuid(
          `automatic-handoff-shipment-plan:${orderId}:${draft.configurationRevision}:${ordinal}`,
        ),
    });
    if (provisional.prepared.kind !== "binding_quote") return false;
    const parcelDemands = candidateParcelDemands(
      pricing.items,
      provisional.prepared.shipmentPlan,
    );
    if (!parcelDemands) return false;
    const itemByPricingId = new Map(
      pricing.items.map((pricingItem, index) => [pricingItem.id, items[index]]),
    );
    const checked = new Set<string>();
    for (const demand of parcelDemands) {
      const item = itemByPricingId.get(demand.itemId);
      const pricingItem = pricing.items.find(({ id }) => id === demand.itemId);
      if (!item || !pricingItem) continue;
      const geometry = await this.prisma.modelGeometry.findUnique({
        where: { id: item.targetModelGeometryId },
      });
      if (!geometry) continue;
      const occupancies = referenceOccupancies(
        demand.quantity,
        Math.min(pricingItem.referencePartsPerPlate, demand.quantity),
      );
      const missing = await this.missingReferenceSlices(
        this.prisma,
        item,
        geometry,
        occupancies,
      );
      for (const partsPerPlate of missing) {
        const requestKey = `${item.id}:${partsPerPlate}`;
        if (checked.has(requestKey)) continue;
        checked.add(requestKey);
        const job = await this.referenceSliceJob(
          this.prisma,
          item,
          geometry,
          partsPerPlate,
          orderId,
          1,
        );
        const dispatch = await this.latestPreprocessingDispatch(
          this.prisma,
          job.jobId,
          "slicing.reference-slice.requested",
        );
        if (this.preprocessingDispatchRequiresHandoff(dispatch)) return true;
      }
    }
    return false;
  }

  private async missingReferenceSlices(
    transaction: Transaction | PrismaService,
    item: {
      bodyIds: string[];
      selectionSha256: string;
      printConfigRevisionId: string;
      referenceProfileId: string;
      referencePartsPerPlate: number | null;
      quantity: number;
    },
    geometry: {
      id: string;
      geometryHash: string;
    },
    requestedOccupancies?: readonly number[],
  ): Promise<number[]> {
    if (
      requestedOccupancies === undefined &&
      item.referencePartsPerPlate === null
    ) {
      throw new Error("Reference occupancy is unresolved");
    }
    const requested =
      requestedOccupancies === undefined
        ? referenceOccupancies(item.quantity, item.referencePartsPerPlate!)
        : [...requestedOccupancies];
    const { buildReferenceSliceCacheKey, RevisionRef, Sha256Digest } =
      await import("@taven/core");
    const missing: number[] = [];
    for (const partsPerPlate of requested) {
      const cacheKey = buildReferenceSliceCacheKey({
        geometryHash: Sha256Digest.parse(geometry.geometryHash),
        modelGeometryId: geometry.id,
        geometrySelectionHash: Sha256Digest.parse(item.selectionSha256),
        referenceProfileRevision: RevisionRef.create(
          "reference-profile",
          item.referenceProfileId,
        ),
        printConfigRevision: RevisionRef.create(
          "print-config",
          item.printConfigRevisionId,
        ),
        partsPerPlate,
      });
      const slice = await transaction.sliceResult.findUnique({
        where: { cacheKey },
      });
      if (!slice) missing.push(partsPerPlate);
    }
    return missing;
  }

  private async stageOrFinalizeBinding(
    transaction: Transaction,
    orderId: string,
  ): Promise<void> {
    if (!(await this.riskAllowsAutomaticQuote(transaction, orderId))) return;
    const draftOrder = await transaction.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        automaticQuoteDraft: {
          include: { selectedDeliveryDestination: true, items: true },
        },
        activePriceBinding: {
          include: {
            orderPriceBinding: { include: { priceSnapshot: true } },
          },
        },
      },
    });
    const draft = draftOrder.automaticQuoteDraft;
    const destination = draft?.selectedDeliveryDestination;
    if (!draft || !destination || draft.items.length === 0) return;
    if (
      draftOrder.activePriceBinding &&
      bindingMatchesAutomaticDraft(
        draftOrder.activePriceBinding.orderPriceBinding,
        draft,
      )
    ) {
      return;
    }
    const priceList = await transaction.priceList.findUnique({
      where: {
        currency_revision: {
          currency: "CZK",
          revision: AUTOMATIC_PRICE_LIST_REVISION,
        },
      },
    });
    if (!priceList) {
      throw new ConflictException("Automatic quote pricing is unavailable");
    }
    const draftsByOrdinal = new Map(
      draft.items.map((item) => [item.ordinal, item]),
    );
    const transient = await this.pricingItemsFromDraft(
      transaction,
      orderId,
      draft.items,
      null,
    );
    if (!transient) return;
    const bindingId = deterministicUuid(
      `automatic-binding:${orderId}:${destination.id}:${draft.configurationRevision}:${priceList.revision}`,
    );
    const preparationInput = {
      priceList,
      items: transient.items,
      expressRequested: draft.expressRequested,
      riskAcknowledgementsComplete: true,
      hasBlockingPreflightFinding: false,
      deliveryDestination: destination,
      shipmentPlanIdForOrdinal: (ordinal: number) =>
        deterministicUuid(`automatic-shipment-plan:${bindingId}:${ordinal}`),
    };
    const provisionalPlan = await prepareAutomaticQuote({
      ...preparationInput,
      materialAndColorAvailable: true,
      withinBuildLimits: true,
    });
    if (provisionalPlan.prepared.kind !== "binding_quote") return;
    if (
      await this.enqueueMissingCandidateReferenceSlices(
        transaction,
        orderId,
        draft.items,
        transient.items,
        provisionalPlan.prepared.shipmentPlan,
      )
    ) {
      return;
    }
    const candidateResourcesAvailable = await this.candidateResourcesAvailable(
      transaction,
      draft.items,
      transient.items,
      provisionalPlan.prepared.shipmentPlan,
    );
    if (candidateResourcesAvailable === null) return;
    const gateResult = candidateResourcesAvailable
      ? provisionalPlan
      : await prepareAutomaticQuote({
          ...preparationInput,
          materialAndColorAvailable: false,
          withinBuildLimits: false,
        });
    if (gateResult.prepared.kind !== "binding_quote") return;

    await this.ensureOrderItems(transaction, orderId);
    const topology = await this.ensureQuoteTopology(transaction, orderId);
    const order = await transaction.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        items: {
          include: {
            modelGeometry: true,
            primaryReferenceSliceResult: true,
            tailReferenceSliceResult: true,
            fulfilmentSlots: { orderBy: { quantityOrdinal: "asc" } },
          },
          orderBy: { ordinal: "asc" },
        },
      },
    });
    const prepared = await prepareAutomaticQuote({
      priceList,
      items: order.items.map((item) => {
        const itemDraft = draftsByOrdinal.get(item.ordinal);
        if (
          !itemDraft ||
          !item.primaryReferenceSliceResult ||
          item.fulfilmentSlots.length !== item.quantity
        ) {
          throw new ConflictException("Automatic quote topology is incomplete");
        }
        return {
          id: item.id,
          referenceProfileId: itemDraft.referenceProfileId,
          material: item.material,
          quantity: item.quantity,
          referencePartsPerPlate: item.referencePartsPerPlate ?? item.quantity,
          primary: item.primaryReferenceSliceResult,
          tail: item.tailReferenceSliceResult,
          boundsXMicrometers: item.modelGeometry.boundsXMicrometers,
          boundsYMicrometers: item.modelGeometry.boundsYMicrometers,
          boundsZMicrometers: item.modelGeometry.boundsZMicrometers,
          fulfilmentSlots: item.fulfilmentSlots,
        };
      }),
      expressRequested: draft.expressRequested,
      materialAndColorAvailable: candidateResourcesAvailable,
      withinBuildLimits: candidateResourcesAvailable,
      riskAcknowledgementsComplete: true,
      hasBlockingPreflightFinding: false,
      deliveryDestination: destination,
      shipmentPlanIdForOrdinal: (ordinal) =>
        deterministicUuid(`automatic-shipment-plan:${bindingId}:${ordinal}`),
    });
    if (prepared.prepared.kind !== "binding_quote") {
      throw new ConflictException(
        "Automatic quote gates changed while creating final topology",
      );
    }
    await this.persistBinding(transaction, {
      orderId,
      orderPhaseId: topology.phaseId,
      bindingId,
      priceList,
      destinationId: destination.id,
      configurationRevision: draft.configurationRevision,
      expressRequested: draft.expressRequested,
      prepared: prepared.prepared,
      paymentFeeRateBasisPoints: prepared.parameters.paymentFeeRateBasisPoints,
      paymentFeeFixedMinor: prepared.parameters.paymentFeeFixedMinor,
      paymentProviderConfig: prepared.parameters.paymentProviderConfig,
    });
  }

  private async riskAllowsAutomaticQuote(
    transaction: Transaction,
    orderId: string,
  ): Promise<boolean> {
    const items = await transaction.automaticQuoteItemDraft.findMany({
      where: { orderId },
      include: { riskDecisions: true },
    });
    let warningCount = 0;
    for (const item of items) {
      if (item.fitSensitive) return false;
      const findings = await this.currentRiskFindings(transaction, item);
      if (
        findings.some(
          (finding) => finding.severity === PreflightSeverity.BLOCKING,
        )
      ) {
        return false;
      }
      warningCount += findings.filter(
        (finding) => finding.severity === PreflightSeverity.WARNING,
      ).length;
      if (warningCount > 3) return false;
      const decisionByFinding = new Map(
        item.riskDecisions
          .filter(
            (decision) =>
              decision.configurationFingerprint ===
              item.configurationFingerprint,
          )
          .map((decision) => [decision.preflightFindingId, decision.decision]),
      );
      if (
        [...decisionByFinding.values()].some(
          (decision) => decision === AutomaticQuoteRiskDecision.DECLINED,
        ) ||
        findings.some(
          (finding) =>
            finding.severity === PreflightSeverity.WARNING &&
            decisionByFinding.get(finding.id) !==
              AutomaticQuoteRiskDecision.ACKNOWLEDGED,
        )
      ) {
        return false;
      }
    }
    return true;
  }

  private async currentRiskFindings(
    transaction: Transaction | PrismaService,
    item: {
      id: string;
      orderId: string;
      sourceModelFileId: string;
      bodyIds: string[];
      selectionSha256: string;
      targetModelGeometryId: string;
      printConfigRevisionId: string;
      referenceProfileId: string;
      quantity: number;
      referencePartsPerPlate: number | null;
    },
  ) {
    const inspectionRevisions = [INSPECTION_REVISION];
    if (item.referencePartsPerPlate !== null) {
      const geometry = await transaction.modelGeometry.findUnique({
        where: { id: item.targetModelGeometryId },
      });
      if (geometry) {
        const referenceJobs = await Promise.all(
          referenceOccupancies(item.quantity, item.referencePartsPerPlate).map(
            (partsPerPlate) =>
              this.referenceSliceJob(
                transaction,
                item,
                geometry,
                partsPerPlate,
                item.orderId,
                1,
              ),
          ),
        );
        inspectionRevisions.push(
          ...referenceJobs.map(
            ({ inputFingerprintSha256 }) => inputFingerprintSha256,
          ),
        );
      }
    }
    return transaction.preflightFinding.findMany({
      where: {
        modelFileId: item.sourceModelFileId,
        modelGeometryId: item.targetModelGeometryId,
        inspectionRevision: { in: inspectionRevisions },
      },
      orderBy: [{ severity: "desc" }, { code: "asc" }],
    });
  }

  private async ensureOrderItems(
    transaction: Transaction,
    orderId: string,
  ): Promise<void> {
    if (await transaction.orderPriceBinding.findFirst({ where: { orderId } }))
      return;
    const existingItems = await transaction.orderItem.count({
      where: { orderId },
    });
    if (existingItems > 0) return;
    const drafts = await transaction.automaticQuoteItemDraft.findMany({
      where: { orderId },
      orderBy: { ordinal: "asc" },
    });
    for (const item of drafts) {
      if (item.referencePartsPerPlate === null) {
        throw new ConflictException("Reference occupancy is unresolved");
      }
      const geometry = await transaction.modelGeometry.findUniqueOrThrow({
        where: { id: item.targetModelGeometryId },
      });
      const occupancies = referenceOccupancies(
        item.quantity,
        item.referencePartsPerPlate,
      );
      const slices = await this.referenceSlices(
        transaction,
        item,
        geometry,
        occupancies,
      );
      await transaction.orderItem.create({
        data: {
          id: deterministicUuid(`automatic-order-item:${item.id}`),
          orderId,
          ordinal: item.ordinal,
          sourceModelFileId: item.sourceModelFileId,
          modelGeometryId: geometry.id,
          printConfigRevisionId: item.printConfigRevisionId,
          primaryReferenceSliceResultId: slices[0]!.id,
          tailReferenceSliceResultId: slices[1]?.id ?? null,
          referencePartsPerPlate: occupancies[0]!,
          material: item.material,
          color: item.color,
          quantity: item.quantity,
        },
      });
    }
  }

  private async ensureQuoteTopology(
    transaction: Transaction,
    orderId: string,
  ): Promise<{ phaseId: string }> {
    const phase = await transaction.orderPhase.upsert({
      where: { orderId },
      create: {
        id: deterministicUuid(`automatic-phase:${orderId}:single`),
        orderId,
        kind: OrderPhaseKind.SINGLE,
        status: OrderPhaseStatus.QUOTED,
      },
      update: {},
    });
    const items = await transaction.orderItem.findMany({
      where: { orderId },
      include: { fulfilmentSlots: true },
      orderBy: { ordinal: "asc" },
    });
    for (const item of items) {
      if (item.fulfilmentSlots.length > 0) {
        if (item.fulfilmentSlots.length !== item.quantity) {
          throw new ConflictException(
            "Automatic quote fulfilment topology is incomplete",
          );
        }
        continue;
      }
      await transaction.fulfilmentSlot.createMany({
        data: Array.from({ length: item.quantity }, (_, index) => ({
          id: deterministicUuid(
            `automatic-slot:${phase.id}:${item.id}:${index + 1}`,
          ),
          orderId,
          orderPhaseId: phase.id,
          orderItemId: item.id,
          quantityOrdinal: index + 1,
          packingUnitKey: `${item.id}:single:${index + 1}`,
          settlementAmountMinor: 0n,
        })),
      });
    }
    return { phaseId: phase.id };
  }

  private async enqueueMissingCandidateReferenceSlices(
    transaction: Transaction,
    orderId: string,
    items: readonly AutomaticQuoteCandidateDraftItem[],
    pricingItems: readonly AutomaticQuotePricingItem[],
    shipmentPlan: AutomaticBindingQuote["shipmentPlan"],
  ): Promise<boolean> {
    const parcelDemands = candidateParcelDemands(pricingItems, shipmentPlan);
    if (!parcelDemands) return false;
    const draftByPricingItemId = new Map(
      pricingItems.map((pricingItem, index) => [pricingItem.id, items[index]]),
    );
    const requested = new Set<string>();
    let enqueued = false;
    for (const demand of parcelDemands) {
      const item = draftByPricingItemId.get(demand.itemId);
      const pricingItem = pricingItems.find(({ id }) => id === demand.itemId);
      if (!item || !pricingItem) return false;
      const geometry = await transaction.modelGeometry.findUnique({
        where: { id: item.targetModelGeometryId },
      });
      if (!geometry) return false;
      const occupancies = referenceOccupancies(
        demand.quantity,
        Math.min(pricingItem.referencePartsPerPlate, demand.quantity),
      );
      const missing = await this.missingReferenceSlices(
        transaction,
        item,
        geometry,
        occupancies,
      );
      for (const partsPerPlate of missing) {
        const requestKey = `${item.id}:${partsPerPlate}`;
        if (requested.has(requestKey)) continue;
        requested.add(requestKey);
        await this.enqueueReferenceSlice(
          transaction,
          item,
          geometry,
          partsPerPlate,
          orderId,
        );
        enqueued = true;
      }
    }
    return enqueued;
  }

  private async exactCandidateMaterialDemands(
    transaction: Transaction | PrismaService,
    items: readonly AutomaticQuoteCandidateDraftItem[],
    pricingItems: readonly AutomaticQuotePricingItem[],
    shipmentPlan: AutomaticBindingQuote["shipmentPlan"],
  ): Promise<Array<{
    itemId: string;
    requiredMaterialMilligrams: bigint;
  }> | null> {
    const parcelDemands = candidateParcelDemands(pricingItems, shipmentPlan);
    if (!parcelDemands) return null;
    const draftByPricingItemId = new Map(
      pricingItems.map((pricingItem, index) => [pricingItem.id, items[index]]),
    );
    const demands: Array<{
      itemId: string;
      requiredMaterialMilligrams: bigint;
    }> = [];
    for (const demand of parcelDemands) {
      const item = draftByPricingItemId.get(demand.itemId);
      const pricingItem = pricingItems.find(({ id }) => id === demand.itemId);
      if (!item || !pricingItem) return null;
      const geometry = await transaction.modelGeometry.findUnique({
        where: { id: item.targetModelGeometryId },
      });
      if (!geometry) return null;
      const partsPerPlate = Math.min(
        pricingItem.referencePartsPerPlate,
        demand.quantity,
      );
      const occupancies = referenceOccupancies(demand.quantity, partsPerPlate);
      const slices = await this.referenceSlices(
        transaction,
        item,
        geometry,
        occupancies,
      ).catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2025"
        ) {
          return null;
        }
        throw error;
      });
      if (!slices) return null;
      demands.push({
        itemId: demand.itemId,
        requiredMaterialMilligrams: estimatedMaterialForQuantity(
          demand.quantity,
          partsPerPlate,
          slices,
        ),
      });
    }
    return demands;
  }

  private async draftInventoryAvailable(
    transaction: Transaction | PrismaService,
    items: readonly AutomaticQuoteCandidateDraftItem[],
    pricingItems: readonly AutomaticQuotePricingItem[],
  ): Promise<boolean> {
    if (items.length !== pricingItems.length || items.length === 0) {
      return false;
    }
    const resourcesByItemId = new Map<
      string,
      Map<string, Array<{ inventoryId: string; available: bigint }>>
    >();
    const demands: Array<{
      itemId: string;
      requiredMaterialMilligrams: bigint;
    }> = [];
    for (const [index, item] of items.entries()) {
      const pricingItem = pricingItems[index];
      if (!pricingItem) return false;
      const rows = await transaction.$queryRaw<
        Array<{
          nodeId: string;
          inventoryId: string;
          availableMilligrams: bigint;
          buildVolumeXMicrometers: bigint;
          buildVolumeYMicrometers: bigint;
          buildVolumeZMicrometers: bigint;
        }>
      >`
        SELECT DISTINCT
          node.id AS "nodeId",
          inventory.id AS "inventoryId",
          inventory.remaining_milligrams - inventory.reserved_milligrams
            AS "availableMilligrams",
          capability.build_volume_x_micrometers
            AS "buildVolumeXMicrometers",
          capability.build_volume_y_micrometers
            AS "buildVolumeYMicrometers",
          capability.build_volume_z_micrometers
            AS "buildVolumeZMicrometers"
        FROM machine_profiles profile
        JOIN machine_capabilities capability
          ON capability.id = profile.machine_capability_id
        JOIN print_config_revisions config
          ON config.id = ${item.printConfigRevisionId}::uuid
         AND config.quality = profile.quality
        JOIN machines machine
          ON machine.machine_capability_id = profile.machine_capability_id
         AND machine.status = 'ACTIVE'
         AND machine.installed_nozzle_micrometers =
             profile.nozzle_diameter_micrometers
        JOIN nodes node
          ON node.id = machine.node_id
         AND node.active
        JOIN machine_calibrations calibration
          ON calibration.node_id = machine.node_id
         AND calibration.machine_id = machine.id
         AND calibration.state = 'ACTIVE'
        JOIN inventories inventory
          ON inventory.node_id = machine.node_id
         AND inventory.machine_id = machine.id
         AND inventory.status = 'AVAILABLE'
         AND inventory.remaining_milligrams > inventory.reserved_milligrams
         AND inventory.material = ${item.material}::material
         AND (${item.color}::text IS NULL OR inventory.color = ${item.color})
        WHERE profile.reference_profile_id = ${item.referenceProfileId}::uuid
          AND profile.material = ${item.material}::material
          AND profile.state = 'ACTIVE'
          AND profile.production_artifact_format <> 'bgcode'
      `;
      const byNode = new Map<
        string,
        Array<{ inventoryId: string; available: bigint }>
      >();
      for (const row of rows.filter((candidate) =>
        geometryFitsCapability(pricingItem, candidate),
      )) {
        const options = byNode.get(row.nodeId) ?? [];
        if (
          !options.some(({ inventoryId }) => inventoryId === row.inventoryId)
        ) {
          options.push({
            inventoryId: row.inventoryId,
            available: row.availableMilligrams,
          });
        }
        byNode.set(row.nodeId, options);
      }
      if (byNode.size === 0) return false;
      resourcesByItemId.set(pricingItem.id, byNode);
      demands.push({
        itemId: pricingItem.id,
        requiredMaterialMilligrams: totalEstimatedMaterial(pricingItem),
      });
    }
    const commonNodeIds = [
      ...(resourcesByItemId.get(demands[0]!.itemId)?.keys() ?? []),
    ].filter((nodeId) =>
      demands.every(({ itemId }) => resourcesByItemId.get(itemId)?.has(nodeId)),
    );
    return commonNodeIds.some((nodeId) =>
      hasUsableInventoryAssignment(
        demands.map(({ itemId, requiredMaterialMilligrams }) => ({
          requiredMaterialMilligrams,
          options: resourcesByItemId.get(itemId)?.get(nodeId) ?? [],
        })),
      ),
    );
  }

  private async candidateResourcesAvailable(
    transaction: Transaction | PrismaService,
    items: readonly AutomaticQuoteCandidateDraftItem[],
    pricingItems: readonly AutomaticQuotePricingItem[],
    shipmentPlan?: AutomaticBindingQuote["shipmentPlan"],
  ): Promise<boolean | null> {
    if (items.length !== pricingItems.length || items.length === 0) {
      return false;
    }
    const resourcesByItemId = new Map<
      string,
      Map<string, Array<{ inventoryId: string; available: bigint }>>
    >();
    for (const [index, item] of items.entries()) {
      const pricingItem = pricingItems[index];
      if (!pricingItem) return false;
      const rows = await transaction.$queryRaw<
        Array<{
          nodeId: string;
          inventoryId: string;
          availableMilligrams: bigint;
        }>
      >`
        SELECT DISTINCT
          node.id AS "nodeId",
          inventory.id AS "inventoryId",
          inventory.remaining_milligrams - inventory.reserved_milligrams
            AS "availableMilligrams"
        FROM machine_profiles profile
        JOIN print_config_revisions config
          ON config.id = ${item.printConfigRevisionId}::uuid
         AND config.quality = profile.quality
        JOIN machines machine
          ON machine.machine_capability_id = profile.machine_capability_id
         AND machine.status = 'ACTIVE'
         AND machine.installed_nozzle_micrometers =
             profile.nozzle_diameter_micrometers
        JOIN nodes node
          ON node.id = machine.node_id
         AND node.active
        JOIN machine_calibrations calibration
          ON calibration.node_id = machine.node_id
         AND calibration.machine_id = machine.id
         AND calibration.state = 'ACTIVE'
        JOIN inventories inventory
          ON inventory.node_id = machine.node_id
         AND inventory.machine_id = machine.id
         AND inventory.status = 'AVAILABLE'
         AND inventory.remaining_milligrams > inventory.reserved_milligrams
         AND inventory.material = ${item.material}::material
         AND (${item.color}::text IS NULL OR inventory.color = ${item.color})
        WHERE profile.reference_profile_id = ${item.referenceProfileId}::uuid
          AND profile.material = ${item.material}::material
          AND profile.state = 'ACTIVE'
          AND profile.production_artifact_format <> 'bgcode'
          AND taven_geometry_fits_machine_capability(
            ${item.targetModelGeometryId}::uuid,
            machine.machine_capability_id
          )
      `;
      const byNode = new Map<
        string,
        Array<{ inventoryId: string; available: bigint }>
      >();
      for (const row of rows) {
        const options = byNode.get(row.nodeId) ?? [];
        if (
          !options.some(({ inventoryId }) => inventoryId === row.inventoryId)
        ) {
          options.push({
            inventoryId: row.inventoryId,
            available: row.availableMilligrams,
          });
        }
        byNode.set(row.nodeId, options);
      }
      if (byNode.size === 0) return false;
      resourcesByItemId.set(pricingItem.id, byNode);
    }
    const demands = shipmentPlan
      ? await this.exactCandidateMaterialDemands(
          transaction,
          items,
          pricingItems,
          shipmentPlan,
        )
      : pricingItems.map((item) => ({
          itemId: item.id,
          requiredMaterialMilligrams: totalEstimatedMaterial(item),
        }));
    if (demands === null) return null;
    if (demands.length === 0) return false;
    const commonNodeIds = [
      ...(resourcesByItemId.get(demands[0]!.itemId)?.keys() ?? []),
    ].filter((nodeId) =>
      demands.every(({ itemId }) => resourcesByItemId.get(itemId)?.has(nodeId)),
    );
    return commonNodeIds.some((nodeId) =>
      hasUsableInventoryAssignment(
        demands.map(({ itemId, requiredMaterialMilligrams }) => ({
          requiredMaterialMilligrams,
          options: resourcesByItemId.get(itemId)?.get(nodeId) ?? [],
        })),
      ),
    );
  }

  private async persistBinding(
    transaction: Transaction,
    input: {
      orderId: string;
      orderPhaseId: string;
      bindingId: string;
      priceList: {
        id: string;
        revision: string;
        currency: string;
      };
      destinationId: string;
      configurationRevision: number;
      expressRequested: boolean;
      prepared: AutomaticBindingQuote;
      paymentFeeRateBasisPoints: number;
      paymentFeeFixedMinor: bigint;
      paymentProviderConfig: Prisma.InputJsonObject;
    },
  ): Promise<void> {
    const observedAt = await databaseNow(transaction);
    const snapshotId = deterministicUuid(
      `automatic-price-snapshot:${input.bindingId}`,
    );
    const snapshotInput = jsonSafe({
      automaticQuote: {
        orderId: input.orderId,
        configurationRevision: input.configurationRevision,
        deliveryDestinationId: input.destinationId,
        expressRequested: input.expressRequested,
        priceListRevision: input.priceList.revision,
        expressEligibilityAtPricing: {
          state: input.expressRequested ? "CANDIDATE_PENDING" : "NOT_REQUESTED",
          preCandidateEvaluation: input.prepared.expressEligibility,
        },
        shipmentPlan: jsonSafe(input.prepared.shipmentPlan),
        breakdown: jsonSafe(input.prepared.price.breakdown),
        tax: jsonSafe(input.prepared.price.tax),
      },
    });
    await transaction.priceSnapshot.create({
      data: {
        id: snapshotId,
        priceListId: input.priceList.id,
        currency: input.priceList.currency,
        contractTotalMinor: input.prepared.price.contractTotal.minorUnits,
        taxRegime: input.prepared.price.tax.regime,
        vatRateBasisPoints: input.prepared.price.tax.vatRateBasisPoints,
        netAmountMinor: input.prepared.price.tax.net.minorUnits,
        vatAmountMinor: input.prepared.price.tax.vat.minorUnits,
        pricingRevision: input.priceList.revision,
        inputSnapshot: snapshotInput,
        snapshotHash: fingerprintOf(snapshotInput),
        createdAt: observedAt,
      },
    });
    await transaction.orderPriceBinding.create({
      data: {
        id: input.bindingId,
        orderId: input.orderId,
        priceSnapshotId: snapshotId,
        deliveryDestinationId: input.destinationId,
        createdAt: observedAt,
      },
    });
    const fulfilmentSlots = await transaction.fulfilmentSlot.findMany({
      where: { orderId: input.orderId },
      select: { id: true, packingUnitKey: true },
    });
    const slotIdByPackingUnitKey = new Map(
      fulfilmentSlots.map((slot) => [slot.packingUnitKey, slot.id]),
    );
    const shipmentAmountById = new Map(
      input.prepared.price.components
        .filter((component) => component.kind === "SHIPMENT")
        .map((component) => [component.targetId!, component.amount.minorUnits]),
    );
    await transaction.shipmentPlan.createMany({
      data: input.prepared.shipmentPlan.parcels.map((parcel, index) => {
        const id = input.prepared.price.shipmentPlanIds[index];
        if (!id) throw new Error("Shipment plan identity is unavailable");
        return {
          id,
          orderId: input.orderId,
          orderPhaseId: input.orderPhaseId,
          priceSnapshotId: snapshotId,
          orderPriceBindingId: input.bindingId,
          deliveryDestinationId: input.destinationId,
          ordinal: parcel.ordinal,
          category: parcel.categoryId,
          plannedVolumeCubicMm: cubicMicrometersToCubicMillimeters(
            parcel.volumeProxyCubicMicrometers,
          ),
          plannedWeightMilligrams: parcel.weightMilligrams,
          shippingAmountMinor: shipmentAmountById.get(id) ?? 0n,
          packagingAmountMinor: 0n,
          handlingAmountMinor: 0n,
          allocationSnapshot: jsonSafe({
            placements: parcel.placements,
            packingUnitKeys: parcel.placements.map(
              ({ packingUnitKey }) => packingUnitKey,
            ),
          }),
          createdAt: observedAt,
        };
      }),
    });
    const shipmentPlanIdBySlotId = new Map<string, string>();
    for (const [
      index,
      parcel,
    ] of input.prepared.shipmentPlan.parcels.entries()) {
      const id = input.prepared.price.shipmentPlanIds[index];
      if (!id) throw new Error("Shipment plan identity is unavailable");
      for (const placement of parcel.placements) {
        const fulfilmentSlotId = slotIdByPackingUnitKey.get(
          placement.packingUnitKey,
        );
        if (!fulfilmentSlotId) {
          throw new Error("Shipment packing unit has no fulfilment slot");
        }
        shipmentPlanIdBySlotId.set(fulfilmentSlotId, id);
      }
    }
    await transaction.shipmentPlanFulfilmentSlot.createMany({
      data: [...shipmentPlanIdBySlotId].map(
        ([fulfilmentSlotId, shipmentPlanId]) => ({
          shipmentPlanId,
          orderPriceBindingId: input.bindingId,
          fulfilmentSlotId,
        }),
      ),
    });
    const orderItemIds = new Set(
      (
        await transaction.orderItem.findMany({
          where: { orderId: input.orderId },
          select: { id: true },
        })
      ).map(({ id }) => id),
    );
    for (const component of input.prepared.price.components) {
      const componentId = deterministicUuid(
        `automatic-price-component:${snapshotId}:${component.componentId}`,
      );
      const shipmentPlanId =
        component.kind === "SHIPMENT" ? component.targetId : undefined;
      const orderItemId =
        component.targetId && orderItemIds.has(component.targetId)
          ? component.targetId
          : undefined;
      await transaction.priceSnapshotComponent.create({
        data: {
          id: componentId,
          priceSnapshotId: snapshotId,
          kind: PriceComponentKind[component.kind],
          scope: shipmentPlanId
            ? PriceComponentScope.SHIPMENT_PLAN
            : orderItemId
              ? PriceComponentScope.ORDER_ITEM
              : PriceComponentScope.ORDER,
          orderItemId: orderItemId ?? null,
          shipmentPlanId: shipmentPlanId ?? null,
          amountMinor: component.amount.minorUnits,
          allocation: jsonSafe({
            calculationComponentId: component.componentId,
            allocations: component.allocations.map((allocation) => {
              const fulfilmentSlotId = slotIdByPackingUnitKey.get(
                allocation.targetId,
              );
              if (!fulfilmentSlotId) {
                throw new Error(
                  "Price allocation packing unit has no fulfilment slot",
                );
              }
              return {
                packingUnitKey: allocation.targetId,
                fulfilmentSlotId,
                amountMinor: allocation.amount.minorUnits.toString(),
              };
            }),
          }),
          createdAt: observedAt,
        },
      });
      await transaction.priceComponentFulfilmentAllocation.createMany({
        data: component.allocations.map((allocation) => {
          const fulfilmentSlotId = slotIdByPackingUnitKey.get(
            allocation.targetId,
          );
          if (!fulfilmentSlotId) {
            throw new Error(
              "Price allocation packing unit has no fulfilment slot",
            );
          }
          return {
            priceSnapshotComponentId: componentId,
            fulfilmentSlotId,
            amountMinor: allocation.amount.minorUnits,
          };
        }),
      });
    }
    const fullCapture = input.prepared.price.captures.find(
      (capture) => capture.role === "FULL",
    );
    if (!fullCapture) throw new Error("Full payment capture is unavailable");
    await transaction.paymentSchedule.create({
      data: {
        id: deterministicUuid(`automatic-payment-schedule:${snapshotId}:full`),
        priceSnapshotId: snapshotId,
        sequence: fullCapture.sequence,
        role: PaymentRole.FULL,
        grossAmountMinor: fullCapture.gross.minorUnits,
        feeRateBasisPoints: input.paymentFeeRateBasisPoints,
        feeFixedMinor: input.paymentFeeFixedMinor,
        providerConfig: input.paymentProviderConfig,
        createdAt: observedAt,
      },
    });
    await transaction.$executeRaw`
      UPDATE fulfilment_slots slot
      SET settlement_amount_minor = allocated.amount_minor,
          updated_at = ${observedAt}
      FROM (
        SELECT allocation.fulfilment_slot_id,
               sum(allocation.amount_minor)::bigint AS amount_minor
        FROM price_component_fulfilment_allocations allocation
        JOIN price_snapshot_components component
          ON component.id = allocation.price_snapshot_component_id
        WHERE component.price_snapshot_id = ${snapshotId}::uuid
        GROUP BY allocation.fulfilment_slot_id
      ) allocated
      WHERE slot.id = allocated.fulfilment_slot_id
    `;
    await transaction.orderActivePriceBinding.upsert({
      where: { orderId: input.orderId },
      create: { orderId: input.orderId, orderPriceBindingId: input.bindingId },
      update: { orderPriceBindingId: input.bindingId },
    });
    await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
  }

  private async advanceEligibility(orderId: string): Promise<void> {
    const active = await this.prisma.orderActivePriceBinding.findUnique({
      where: { orderId },
      include: {
        order: { include: { automaticQuoteDraft: true } },
        orderPriceBinding: {
          include: {
            shipmentPlans: true,
            priceSnapshot: { include: { priceList: true } },
          },
        },
      },
    });
    if (!active || active.orderPriceBinding.invalidatedAt) return;
    const bindingId = active.orderPriceBindingId;
    const automaticParameters = parseAutomaticQuotePricingParameters(
      active.orderPriceBinding.priceSnapshot.priceList.parameters,
    );
    const draft = active.order.automaticQuoteDraft;
    if (
      !draft ||
      !bindingMatchesAutomaticDraft(active.orderPriceBinding, draft)
    ) {
      return;
    }
    const expressRequested =
      automaticBindingExpressRequested(
        active.orderPriceBinding.priceSnapshot.inputSnapshot,
      ) === true;
    const expressCapacityWindowSeconds = expressRequested
      ? automaticExpressCapacityWindowSeconds(automaticParameters)
      : undefined;
    const expressMaximumPlateCount = expressRequested
      ? automaticParameters.expressMaximumPlateCount
      : undefined;
    await this.dispatchAutomaticCandidates(orderId, bindingId);
    const phase = await this.prisma.orderPhase.findUnique({
      where: { orderId },
    });
    if (!phase) return;
    const observedAt = await databaseNow(this.prisma);
    const evaluationFrontier = await this.automaticCandidateFrontier(
      this.prisma,
      bindingId,
      observedAt,
    );
    if (evaluationFrontier.missingOptionRequirement) {
      await this.recordCandidateEstimationHandoff({
        orderId,
        bindingId,
        evaluationFrontierHash: evaluationFrontier.hash,
        reason: "NO_DISPATCHABLE_CANDIDATE_RESOURCES",
      });
      return;
    }
    const definitiveNoPlanNodeIds = new Set<string>();
    for (const nodeId of evaluationFrontier.successNodeIds) {
      try {
        const planningObservedAt = new Date();
        const latestPlan = await this.prisma.phaseResourcePlan.findFirst({
          where: {
            nodeId,
            orderPhaseId: phase.id,
            jobs: {
              some: {
                candidateResourceEstimate: {
                  shipmentPlan: { orderPriceBindingId: bindingId },
                },
              },
            },
          },
          include: { reservationSets: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        });
        const liveReservation = latestPlan?.reservationSets.find(
          (reservation) =>
            reservation.status === "RESERVED" &&
            reservation.expiresAt > planningObservedAt &&
            latestPlan.expiresAt > planningObservedAt,
        );
        const liveReservationCapacityFits =
          !latestPlan || !liveReservation || !expressCapacityWindowSeconds
            ? true
            : await this.planCapacityFitsWindow(
                this.prisma,
                latestPlan.id,
                latestPlan.nodeId,
                planningObservedAt,
                expressCapacityWindowSeconds,
              );
        const latestPlanPlateCountFits =
          !latestPlan || !expressMaximumPlateCount
            ? true
            : await this.planPlateCountFitsLimit(
                this.prisma,
                latestPlan.id,
                latestPlan.nodeId,
                expressMaximumPlateCount,
              );
        if (
          latestPlan &&
          liveReservation &&
          liveReservationCapacityFits &&
          latestPlanPlateCountFits
        ) {
          const finalized = await this.finalizeAutomaticQuote({
            orderId,
            bindingId,
            phaseResourcePlanId: latestPlan.id,
            phaseReservationSetId: liveReservation.id,
            ...(expressCapacityWindowSeconds
              ? { capacityWindowSeconds: expressCapacityWindowSeconds }
              : {}),
            ...(expressMaximumPlateCount
              ? { maximumPlateCount: expressMaximumPlateCount }
              : {}),
          });
          if (finalized) return;
          await this.resourceReservations.releaseBeforePrint(
            liveReservation.id,
          );
        }
        if (
          liveReservation &&
          (!liveReservationCapacityFits || !latestPlanPlateCountFits)
        ) {
          await this.resourceReservations.releaseBeforePrint(
            liveReservation.id,
          );
        }
        const needsSuccessor = Boolean(
          latestPlan &&
          (latestPlan.expiresAt <= planningObservedAt ||
            latestPlan.reservationSets.length > 0 ||
            !latestPlanPlateCountFits),
        );
        const planKey =
          latestPlan && !needsSuccessor
            ? latestPlan.planKey
            : `automatic:${fingerprintOf({
                orderId,
                bindingId,
                nodeId,
                ...(expressCapacityWindowSeconds
                  ? {
                      capacityWindowSeconds:
                        expressCapacityWindowSeconds.toString(),
                    }
                  : {}),
                ...(expressMaximumPlateCount
                  ? {
                      maximumPlateCount: expressMaximumPlateCount.toString(),
                    }
                  : {}),
                ...(latestPlan ? { retryOf: latestPlan.id } : {}),
              })}`;
        const plan = await this.eligibilityPlans.createCompletePlan({
          nodeId,
          orderPhaseId: phase.id,
          planKey,
          ...(expressCapacityWindowSeconds
            ? { capacityWindowSeconds: expressCapacityWindowSeconds }
            : {}),
          ...(expressMaximumPlateCount
            ? { maximumPlateCount: expressMaximumPlateCount }
            : {}),
        });
        const reservation = await this.resourceReservations.reserve({
          nodeId,
          phaseResourcePlanId: plan.phaseResourcePlanId,
          reservationKey: `automatic:${fingerprintOf({ orderId, bindingId, nodeId, plan: plan.phaseResourcePlanId })}`,
        });
        const finalized = await this.finalizeAutomaticQuote({
          orderId,
          bindingId,
          phaseResourcePlanId: plan.phaseResourcePlanId,
          phaseReservationSetId: reservation.phaseReservationSetId,
          ...(expressCapacityWindowSeconds
            ? { capacityWindowSeconds: expressCapacityWindowSeconds }
            : {}),
          ...(expressMaximumPlateCount
            ? { maximumPlateCount: expressMaximumPlateCount }
            : {}),
        });
        if (finalized) return;
        await this.resourceReservations.releaseBeforePrint(
          reservation.phaseReservationSetId,
        );
      } catch (error) {
        if (
          error instanceof ResourceConflictError &&
          error.constraint === "complete_phase_resource_plan_required"
        ) {
          definitiveNoPlanNodeIds.add(nodeId);
          continue;
        }
        if (
          error instanceof ResourceConflictError ||
          error instanceof ResourceNotFoundError
        ) {
          continue;
        }
        throw error;
      }
    }
    if (!expressCapacityWindowSeconds && definitiveNoPlanNodeIds.size > 0) {
      await this.recordCandidateEstimationHandoff({
        orderId,
        bindingId,
        evaluationFrontierHash: evaluationFrontier.hash,
        reason: "NO_COMPLETE_RESOURCE_PLAN",
        definitiveNoPlanNodeIds,
      });
    }
  }

  private async releaseSupersededReservations(
    sessionId: string,
  ): Promise<void> {
    const order = await this.prisma.order.findFirst({
      where: { automaticOrigin: { quoteSessionId: sessionId } },
      include: {
        automaticQuoteDraft: true,
        activePriceBinding: {
          include: {
            orderPriceBinding: { include: { priceSnapshot: true } },
          },
        },
      },
    });
    const active = order?.activePriceBinding?.orderPriceBinding;
    if (!order?.automaticQuoteDraft || !active) {
      return;
    }
    if (bindingMatchesAutomaticDraft(active, order.automaticQuoteDraft)) return;
    const reservations = await this.prisma.phaseReservationSet.findMany({
      where: {
        status: "RESERVED",
        phaseResourcePlan: {
          jobs: {
            some: {
              candidateResourceEstimate: {
                shipmentPlan: { orderPriceBindingId: active.id },
              },
            },
          },
        },
      },
      select: { id: true },
    });
    for (const reservation of reservations) {
      await this.resourceReservations.releaseBeforePrint(reservation.id);
    }
  }

  private async dispatchAutomaticCandidates(
    orderId: string,
    bindingId: string,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        automaticQuoteDraft: { include: { items: true } },
        items: {
          include: {
            sourceModelFile: true,
            modelGeometry: true,
            printConfigRevision: true,
          },
          orderBy: { ordinal: "asc" },
        },
        activePriceBinding: {
          include: {
            orderPriceBinding: {
              include: {
                shipmentPlans: {
                  include: {
                    fulfilmentSlotAllocations: {
                      include: { fulfilmentSlot: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (
      !order?.automaticQuoteDraft ||
      order.activePriceBinding?.orderPriceBindingId !== bindingId
    ) {
      return;
    }
    const observedAt = await databaseNow(this.prisma);
    const draftsByOrdinal = new Map(
      order.automaticQuoteDraft.items.map((item) => [item.ordinal, item]),
    );
    const shipmentPlans =
      order.activePriceBinding.orderPriceBinding.shipmentPlans;
    const contracts = await import("@taven/slicer-contracts");
    for (const item of order.items) {
      const draft = draftsByOrdinal.get(item.ordinal);
      if (!draft) continue;
      for (const shipmentPlan of shipmentPlans) {
        const quantity = shipmentPlan.fulfilmentSlotAllocations.filter(
          ({ fulfilmentSlot }) => fulfilmentSlot.orderItemId === item.id,
        ).length;
        if (quantity === 0) continue;
        const profiles = await this.prisma.machineProfile.findMany({
          where: {
            state: RevisionState.ACTIVE,
            referenceProfileId: draft.referenceProfileId,
            material: item.material,
          },
          include: {
            machineCapability: {
              include: {
                machines: {
                  where: { status: MachineStatus.ACTIVE },
                  include: {
                    node: true,
                    calibrations: {
                      where: { state: RevisionState.ACTIVE },
                      orderBy: [{ activatedAt: "desc" }, { id: "asc" }],
                    },
                    inventories: {
                      where: {
                        status: InventoryStatus.AVAILABLE,
                        material: item.material,
                        remainingMilligrams: { gt: 0n },
                        ...(item.color ? { color: item.color } : {}),
                      },
                      orderBy: { id: "asc" },
                    },
                  },
                  orderBy: { id: "asc" },
                },
              },
            },
          },
          orderBy: { id: "asc" },
        });
        for (const profile of profiles) {
          const productionArtifactFormat = toSlicerProductionArtifactFormat(
            profile.productionArtifactFormat,
          );
          const plateCapacities = candidatePlateCapacities(
            quantity,
            productionArtifactFormat,
          );
          if (plateCapacities.length === 0) continue;
          if (
            !geometryFitsCapability(
              item.modelGeometry,
              profile.machineCapability,
            )
          ) {
            continue;
          }
          for (const machine of profile.machineCapability.machines) {
            if (
              !machine.node.active ||
              machine.installedNozzleMicrometers !==
                profile.nozzleDiameterMicrometers
            ) {
              continue;
            }
            const calibration = machine.calibrations[0];
            if (!calibration) continue;
            for (const inventory of machine.inventories) {
              for (const partsPerPlate of plateCapacities) {
                const arrangementRevisionId = deterministicUuid(
                  `automatic-arrangement:${bindingId}:${item.id}:${shipmentPlan.id}:${machine.id}:${profile.id}:${calibration.id}:${quantity}:${partsPerPlate}`,
                );
                const arrangementContentSha256 = fingerprintOf({
                  bindingId,
                  itemId: item.id,
                  shipmentPlanId: shipmentPlan.id,
                  machineId: machine.id,
                  machineProfileId: profile.id,
                  machineCalibrationId: calibration.id,
                  quantity,
                  partsPerPlate,
                });
                await this.prisma.arrangementRevision.upsert({
                  where: { id: arrangementRevisionId },
                  create: {
                    id: arrangementRevisionId,
                    contentSha256: arrangementContentSha256,
                  },
                  update: {},
                });
                const inputBase = {
                  geometry: {
                    sourceModelFileId: item.sourceModelFile.id,
                    sourceContentSha256: item.sourceModelFile.contentHash,
                    modelGeometryId: item.modelGeometry.id,
                    canonicalObjectKey: item.modelGeometry.canonicalObjectKey,
                    geometrySha256: item.modelGeometry.geometryHash,
                    bodyIds: draft.bodyIds,
                    selectionSha256: draft.selectionSha256,
                  },
                  machineId: machine.id,
                  machineProfile: {
                    revisionId: profile.id,
                    contentSha256: slicerSettingsSnapshot(profile.settings)
                      .contentSha256,
                    slicerEngine: profile.slicerEngine,
                    slicerVersion: profile.slicerVersion,
                    productionArtifactFormat,
                  },
                  machineCalibration: {
                    revisionId: calibration.id,
                    contentSha256: slicerSettingsSnapshot(calibration.settings)
                      .contentSha256,
                  },
                  printConfig: {
                    revisionId: item.printConfigRevision.id,
                    contentSha256: slicerSettingsSnapshot(
                      item.printConfigRevision.settings,
                    ).contentSha256,
                  },
                  partsPerPlate,
                  quantity,
                  shipmentPlanId: shipmentPlan.id,
                  arrangementRevision: {
                    revisionId: arrangementRevisionId,
                    contentSha256: arrangementContentSha256,
                  },
                };
                const occupancySliceTargets = referenceOccupancies(
                  quantity,
                  partsPerPlate,
                ).map((occupancy) => {
                  const cacheIdentitySha256 =
                    contracts.machineOccupancyCacheIdentitySha256(
                      inputBase,
                      occupancy,
                    );
                  return {
                    partsPerPlate: occupancy,
                    cacheIdentitySha256,
                    analysisObjectKey: `slice-metrics/${cacheIdentitySha256}/result.json`,
                  };
                });
                const candidateInput = { ...inputBase, occupancySliceTargets };
                const initialJobId = deterministicUuid(
                  `automatic-candidate:${bindingId}:${item.id}:${shipmentPlan.id}:${machine.id}:${profile.id}:${calibration.id}:${inventory.id}:${partsPerPlate}`,
                );
                const dispatchIdentity =
                  await this.nextAutomaticCandidateDispatch(
                    initialJobId,
                    observedAt,
                  );
                if (!dispatchIdentity) continue;
                const inputFingerprintSha256 =
                  contracts.slicingInputFingerprint(
                    "candidate_estimate",
                    candidateInput,
                  );
                const idempotencyKey = `slicer:v2:candidate_estimate:${dispatchIdentity.jobId}:${inputFingerprintSha256}`;
                const job = contracts.CandidateEstimateJobSchema.parse({
                  contractVersion: 2,
                  kind: "candidate_estimate",
                  jobId: dispatchIdentity.jobId,
                  correlationId: orderId,
                  inputFingerprintSha256,
                  idempotencyKey,
                  attempt: dispatchIdentity.attempt,
                  input: candidateInput,
                });
                await this.candidateEstimates.dispatch({
                  nodeId: machine.nodeId,
                  inventoryId: inventory.id,
                  job,
                  ...(dispatchIdentity.availableAt
                    ? { availableAt: dispatchIdentity.availableAt }
                    : {}),
                });
              }
            }
          }
        }
      }
    }
  }

  private async nextAutomaticCandidateDispatch(
    initialJobId: string,
    observedAt: Date,
  ): Promise<{
    jobId: string;
    attempt: number;
    availableAt?: Date;
  } | null> {
    let jobId = initialJobId;
    for (let generation = 0; generation < 100; generation += 1) {
      const states = await this.prisma.$queryRaw<
        AutomaticCandidateDispatchState[]
      >`
        SELECT
          (dispatch.payload #>> '{job,attempt}')::integer AS attempt,
          terminal.outcome::text AS outcome,
          terminal.failure_class AS "failureClass",
          terminal.retry_after_milliseconds AS "retryAfterMilliseconds",
          terminal.created_at AS "receiptCreatedAt",
          candidate.expires_at AS "expiresAt",
          EXISTS (
            SELECT 1
            FROM outbox_messages dead_letter
            WHERE dead_letter.aggregate_type = 'SlicingDispatchDeadLetter'
              AND dead_letter.aggregate_id = dispatch.id
              AND dead_letter.message_type = 'slicing.candidate_estimate.dead-lettered'
          ) AS "deadLettered"
        FROM outbox_messages dispatch
        LEFT JOIN candidate_estimate_terminal_results terminal
          ON terminal.outbox_message_id = dispatch.id
        LEFT JOIN candidate_resource_estimates candidate
          ON candidate.id = terminal.candidate_resource_estimate_id
        WHERE dispatch.aggregate_type = 'CandidateEstimateDispatch'
          AND dispatch.aggregate_id = ${jobId}::uuid
          AND dispatch.message_type = 'slicing.candidate-estimate.requested'
        ORDER BY (dispatch.payload #>> '{job,attempt}')::integer DESC
        LIMIT 1
      `;
      const latest = states[0];
      if (!latest) return { jobId, attempt: 1 };
      if (latest.deadLettered || latest.outcome === null) return null;
      if (latest.outcome === "FAILED") {
        if (
          latest.failureClass !== "retryable_infrastructure" ||
          latest.attempt >= MAX_SLICING_JOB_ATTEMPTS
        ) {
          return null;
        }
        return {
          jobId,
          attempt: latest.attempt + 1,
          ...(latest.receiptCreatedAt && latest.retryAfterMilliseconds
            ? {
                availableAt: new Date(
                  latest.receiptCreatedAt.getTime() +
                    latest.retryAfterMilliseconds,
                ),
              }
            : {}),
        };
      }
      if (!latest.expiresAt || latest.expiresAt > observedAt) return null;
      jobId = deterministicUuid(`automatic-candidate-successor:${jobId}`);
    }
    return null;
  }

  private async automaticCandidateFrontier(
    transaction: Transaction | PrismaService,
    bindingId: string,
    observedAt: Date,
  ): Promise<AutomaticCandidateFrontier> {
    const rows = await transaction.$queryRaw<AutomaticCandidateFrontierRow[]>`
      WITH item_requirements AS (
        SELECT
          shipment_plan.id AS shipment_plan_id,
          item.id AS order_item_id,
          item.model_geometry_id,
          item.print_config_revision_id,
          item.material::text AS material,
          item.color,
          count(*)::integer AS quantity
        FROM order_price_bindings binding
        JOIN shipment_plans shipment_plan
          ON shipment_plan.order_price_binding_id = binding.id
        JOIN shipment_plan_fulfilment_slots allocation
          ON allocation.shipment_plan_id = shipment_plan.id
         AND allocation.order_price_binding_id = binding.id
        JOIN fulfilment_slots slot
          ON slot.id = allocation.fulfilment_slot_id
         AND slot.order_id = binding.order_id
        JOIN order_items item
          ON item.id = slot.order_item_id
         AND item.order_id = slot.order_id
        WHERE binding.id = ${bindingId}::uuid
          AND binding.invalidated_at IS NULL
        GROUP BY
          shipment_plan.id,
          item.id,
          item.model_geometry_id,
          item.print_config_revision_id,
          item.material,
          item.color
      ), ranked_dispatches AS (
        SELECT
          requirement.shipment_plan_id,
          requirement.order_item_id,
          dispatch.id AS dispatch_id,
          dispatch.payload #>> '{job,inputFingerprintSha256}'
            AS input_fingerprint,
          dispatch.payload #>> '{inventoryId}' AS inventory_id,
          inventory.remaining_milligrams,
          inventory.reserved_milligrams,
          inventory.status::text AS inventory_status,
          inventory.updated_at AS inventory_updated_at,
          dispatch.payload #>> '{nodeId}' AS node_id,
          (dispatch.payload #>> '{job,attempt}')::integer AS attempt,
          terminal.outcome::text AS outcome,
          terminal.failure_class,
          terminal.candidate_resource_estimate_id AS candidate_id,
          candidate.expires_at,
          EXISTS (
            SELECT 1
            FROM outbox_messages dead_letter
            WHERE dead_letter.aggregate_type = 'SlicingDispatchDeadLetter'
              AND dead_letter.aggregate_id = dispatch.id
              AND dead_letter.message_type = 'slicing.candidate_estimate.dead-lettered'
          ) AS dead_lettered,
          row_number() OVER (
            PARTITION BY
              requirement.shipment_plan_id,
              requirement.order_item_id,
              dispatch.payload #>> '{job,inputFingerprintSha256}',
              dispatch.payload #>> '{inventoryId}'
            ORDER BY
              dispatch.created_at DESC,
              (dispatch.payload #>> '{job,attempt}')::integer DESC,
              dispatch.id DESC
          ) AS dispatch_rank
        FROM item_requirements requirement
        JOIN outbox_messages dispatch
          ON dispatch.aggregate_type = 'CandidateEstimateDispatch'
         AND dispatch.message_type = 'slicing.candidate-estimate.requested'
         AND dispatch.payload #>> '{job,input,shipmentPlanId}' =
             requirement.shipment_plan_id::text
         AND dispatch.payload #>> '{job,input,geometry,modelGeometryId}' =
             requirement.model_geometry_id::text
         AND dispatch.payload #>> '{job,input,printConfig,revisionId}' =
             requirement.print_config_revision_id::text
         AND (dispatch.payload #>> '{job,input,quantity}')::integer <=
             requirement.quantity
        JOIN inventories inventory
          ON inventory.id::text = dispatch.payload #>> '{inventoryId}'
         AND inventory.material::text = requirement.material
         AND (requirement.color IS NULL OR inventory.color = requirement.color)
        LEFT JOIN candidate_estimate_terminal_results terminal
          ON terminal.outbox_message_id = dispatch.id
        LEFT JOIN candidate_resource_estimates candidate
          ON candidate.id = terminal.candidate_resource_estimate_id
      )
      SELECT
        requirement.shipment_plan_id AS "shipmentPlanId",
        requirement.order_item_id AS "orderItemId",
        ranked.dispatch_id AS "dispatchId",
        ranked.input_fingerprint AS "inputFingerprint",
        ranked.inventory_id AS "inventoryId",
        ranked.remaining_milligrams AS "inventoryRemainingMilligrams",
        ranked.reserved_milligrams AS "inventoryReservedMilligrams",
        ranked.inventory_status AS "inventoryStatus",
        ranked.inventory_updated_at AS "inventoryUpdatedAt",
        ranked.node_id AS "nodeId",
        ranked.attempt,
        ranked.outcome,
        ranked.failure_class AS "failureClass",
        ranked.candidate_id AS "candidateId",
        ranked.expires_at AS "expiresAt",
        ranked.dead_lettered AS "deadLettered"
      FROM item_requirements requirement
      LEFT JOIN ranked_dispatches ranked
        ON ranked.shipment_plan_id = requirement.shipment_plan_id
       AND ranked.order_item_id = requirement.order_item_id
       AND ranked.dispatch_rank = 1
      ORDER BY
        requirement.shipment_plan_id,
        requirement.order_item_id,
        ranked.input_fingerprint,
        ranked.inventory_id,
        ranked.dispatch_id
    `;
    const capacityFrontier = await transaction.$queryRaw<
      AutomaticCandidateCapacityFrontierRow[]
    >`
      SELECT DISTINCT
        reservation.id,
        reservation.node_id AS "nodeId",
        reservation.machine_id AS "machineId",
        reservation.starts_at AS "startsAt",
        reservation.ends_at AS "endsAt",
        reservation.status::text,
        reservation.expires_at AS "expiresAt"
      FROM capacity_reservations reservation
      JOIN candidate_resource_estimates candidate
        ON candidate.node_id = reservation.node_id
       AND candidate.machine_id = reservation.machine_id
      JOIN shipment_plans shipment_plan
        ON shipment_plan.id = candidate.shipment_plan_id
       AND shipment_plan.order_price_binding_id = ${bindingId}::uuid
      JOIN candidate_capacity_intervals candidate_interval
        ON candidate_interval.candidate_resource_estimate_id = candidate.id
       AND candidate_interval.node_id = candidate.node_id
       AND reservation.starts_at < candidate_interval.ends_at
       AND reservation.ends_at > candidate_interval.starts_at
      ORDER BY
        reservation.node_id,
        reservation.machine_id,
        reservation.starts_at,
        reservation.ends_at,
        reservation.id
    `;
    const requirements = new Map<string, AutomaticCandidateFrontierRow[]>();
    for (const row of rows) {
      const key = `${row.shipmentPlanId}:${row.orderItemId}`;
      const grouped = requirements.get(key) ?? [];
      grouped.push(row);
      requirements.set(key, grouped);
    }
    const optionsFor = (group: AutomaticCandidateFrontierRow[]) =>
      group.filter((row) => row.dispatchId !== null);
    const permanentlyFailed = (row: AutomaticCandidateFrontierRow) =>
      row.deadLettered === true ||
      (row.outcome === "FAILED" &&
        (row.failureClass !== "retryable_infrastructure" ||
          (row.attempt ?? 0) >= MAX_SLICING_JOB_ATTEMPTS));
    const settled = (row: AutomaticCandidateFrontierRow) =>
      permanentlyFailed(row) ||
      (row.outcome === "SUCCEEDED" &&
        row.deadLettered !== true &&
        row.candidateId !== null &&
        row.expiresAt !== null &&
        row.expiresAt > observedAt);
    const groups = [...requirements.values()];
    const successNodeIds = [
      ...new Set(
        rows
          .filter(
            (row) =>
              row.outcome === "SUCCEEDED" &&
              row.deadLettered !== true &&
              row.candidateId !== null &&
              row.expiresAt !== null &&
              row.expiresAt > observedAt &&
              row.nodeId !== null,
          )
          .map((row) => row.nodeId!),
      ),
    ].sort();
    return {
      hash: fingerprintOf({
        candidates: rows.map((row) => ({
          shipmentPlanId: row.shipmentPlanId,
          orderItemId: row.orderItemId,
          dispatchId: row.dispatchId,
          inputFingerprint: row.inputFingerprint,
          inventoryId: row.inventoryId,
          inventoryRemainingMilligrams:
            row.inventoryRemainingMilligrams?.toString() ?? null,
          inventoryReservedMilligrams:
            row.inventoryReservedMilligrams?.toString() ?? null,
          inventoryStatus: row.inventoryStatus,
          inventoryUpdatedAt: row.inventoryUpdatedAt?.toISOString() ?? null,
          nodeId: row.nodeId,
          attempt: row.attempt,
          outcome: row.outcome,
          failureClass: row.failureClass,
          candidateId: row.candidateId,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          deadLettered: row.deadLettered,
        })),
        capacityReservations: capacityFrontier.map((reservation) => ({
          id: reservation.id,
          nodeId: reservation.nodeId,
          machineId: reservation.machineId,
          startsAt: reservation.startsAt.toISOString(),
          endsAt: reservation.endsAt.toISOString(),
          status: reservation.status,
          expiresAt: reservation.expiresAt.toISOString(),
        })),
      }),
      quiescent:
        groups.length > 0 &&
        groups.every((group) => {
          const options = optionsFor(group);
          return options.length > 0 && options.every(settled);
        }),
      allFailedRequirement: groups.some((group) => {
        const options = optionsFor(group);
        return options.length > 0 && options.every(permanentlyFailed);
      }),
      missingOptionRequirement: groups.some(
        (group) => optionsFor(group).length === 0,
      ),
      successNodeIds,
    };
  }

  private async hasLiveCandidatePlan(
    transaction: Transaction | PrismaService,
    bindingId: string,
    observedAt: Date,
  ): Promise<boolean> {
    const plan = await transaction.phaseResourcePlan.findFirst({
      where: {
        expiresAt: { gt: observedAt },
        jobs: {
          some: {
            candidateResourceEstimate: {
              shipmentPlan: { orderPriceBindingId: bindingId },
            },
          },
        },
      },
      select: { id: true },
    });
    return plan !== null;
  }

  private async recordCandidateEstimationHandoff(input: {
    orderId: string;
    bindingId: string;
    evaluationFrontierHash: string;
    reason: "NO_DISPATCHABLE_CANDIDATE_RESOURCES" | "NO_COMPLETE_RESOURCE_PLAN";
    definitiveNoPlanNodeIds?: ReadonlySet<string>;
  }): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT taven_lock_automatic_order_session(${input.orderId}::uuid)::text
      `;
      const observedAt = await databaseNow(transaction);
      const active = await transaction.orderActivePriceBinding.findUnique({
        where: { orderId: input.orderId },
        include: {
          order: { include: { automaticQuoteDraft: true } },
          orderPriceBinding: { include: { priceSnapshot: true } },
        },
      });
      const draft = active?.order.automaticQuoteDraft;
      if (
        !active ||
        active.orderPriceBindingId !== input.bindingId ||
        active.orderPriceBinding.invalidatedAt ||
        !draft ||
        !bindingMatchesAutomaticDraft(active.orderPriceBinding, draft) ||
        (await this.hasLiveCandidatePlan(
          transaction,
          input.bindingId,
          observedAt,
        ))
      ) {
        return;
      }
      const frontier = await this.automaticCandidateFrontier(
        transaction,
        input.bindingId,
        observedAt,
      );
      if (frontier.hash !== input.evaluationFrontierHash) {
        return;
      }
      if (input.reason === "NO_DISPATCHABLE_CANDIDATE_RESOURCES") {
        if (!frontier.missingOptionRequirement) return;
      } else {
        const definitiveNoPlanNodeIds = input.definitiveNoPlanNodeIds;
        if (
          automaticBindingExpressRequested(
            active.orderPriceBinding.priceSnapshot.inputSnapshot,
          ) ||
          !frontier.quiescent ||
          frontier.successNodeIds.length === 0 ||
          !definitiveNoPlanNodeIds ||
          frontier.successNodeIds.length !== definitiveNoPlanNodeIds.size ||
          frontier.successNodeIds.some(
            (nodeId) => !definitiveNoPlanNodeIds.has(nodeId),
          )
        ) {
          return;
        }
      }
      const deduplicationKey = candidateUnusableDispositionKey(
        input.bindingId,
        frontier.hash,
      );
      await transaction.outboxMessage.upsert({
        where: { deduplicationKey },
        create: {
          deduplicationKey,
          aggregateType: "AutomaticQuoteEligibilityDisposition",
          aggregateId: input.bindingId,
          messageType: CANDIDATE_UNUSABLE_DISPOSITION_TYPE,
          schemaVersion: 1,
          payload: jsonSafe({
            orderId: input.orderId,
            bindingId: input.bindingId,
            frontierSha256: frontier.hash,
            nodeIds: frontier.successNodeIds,
            reason: input.reason,
            observedAt: observedAt.toISOString(),
          }),
          status: OutboxStatus.DELIVERED,
          deliveredAt: observedAt,
        },
        update: {},
      });
    });
  }

  private async candidateEstimationRequiresHandoff(
    orderId: string,
  ): Promise<boolean> {
    const active = await this.prisma.orderActivePriceBinding.findUnique({
      where: { orderId },
      include: {
        order: { include: { automaticQuoteDraft: true } },
        orderPriceBinding: { include: { priceSnapshot: true } },
      },
    });
    const draft = active?.order.automaticQuoteDraft;
    if (
      !active ||
      active.orderPriceBinding.invalidatedAt ||
      !draft ||
      !bindingMatchesAutomaticDraft(active.orderPriceBinding, draft)
    ) {
      return false;
    }
    const observedAt = await databaseNow(this.prisma);
    if (
      await this.hasLiveCandidatePlan(
        this.prisma,
        active.orderPriceBindingId,
        observedAt,
      )
    ) {
      return false;
    }
    const frontier = await this.automaticCandidateFrontier(
      this.prisma,
      active.orderPriceBindingId,
      observedAt,
    );
    if (frontier.allFailedRequirement) return true;
    const marker = await this.prisma.outboxMessage.findUnique({
      where: {
        deduplicationKey: candidateUnusableDispositionKey(
          active.orderPriceBindingId,
          frontier.hash,
        ),
      },
      select: {
        aggregateType: true,
        aggregateId: true,
        messageType: true,
        status: true,
      },
    });
    return Boolean(
      marker &&
      marker.aggregateType === "AutomaticQuoteEligibilityDisposition" &&
      marker.aggregateId === active.orderPriceBindingId &&
      marker.messageType === CANDIDATE_UNUSABLE_DISPOSITION_TYPE &&
      marker.status === OutboxStatus.DELIVERED,
    );
  }

  private async finalizeAutomaticQuote(input: {
    orderId: string;
    bindingId: string;
    phaseResourcePlanId: string;
    phaseReservationSetId: string;
    capacityWindowSeconds?: bigint;
    maximumPlateCount?: bigint;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT taven_lock_automatic_order_session(${input.orderId}::uuid)::text
      `;
      const observedAt = await databaseNow(transaction);
      const active = await transaction.orderActivePriceBinding.findUnique({
        where: { orderId: input.orderId },
        include: {
          order: { include: { automaticQuoteDraft: true } },
          orderPriceBinding: { include: { priceSnapshot: true } },
        },
      });
      const plan = await transaction.phaseResourcePlan.findUnique({
        where: { id: input.phaseResourcePlanId },
        include: {
          eligibilitySnapshot: { include: { orderPhase: true } },
        },
      });
      const reservation = await transaction.phaseReservationSet.findUnique({
        where: { id: input.phaseReservationSetId },
      });
      const origin = await transaction.automaticOrderOrigin.findUnique({
        where: { orderId: input.orderId },
      });
      const bindingMatchesDraft = Boolean(
        active?.order.automaticQuoteDraft &&
        bindingMatchesAutomaticDraft(
          active.orderPriceBinding,
          active.order.automaticQuoteDraft,
        ),
      );
      const capacityFits = !input.capacityWindowSeconds
        ? true
        : plan
          ? await this.planCapacityFitsWindow(
              transaction,
              input.phaseResourcePlanId,
              plan.nodeId,
              observedAt,
              input.capacityWindowSeconds,
            )
          : false;
      const plateCountFits = !input.maximumPlateCount
        ? true
        : plan
          ? await this.planPlateCountFitsLimit(
              transaction,
              input.phaseResourcePlanId,
              plan.nodeId,
              input.maximumPlateCount,
            )
          : false;
      if (
        active?.orderPriceBindingId !== input.bindingId ||
        plan?.eligibilitySnapshot.orderPhase.orderId !== input.orderId ||
        plan.expiresAt <= observedAt ||
        reservation?.phaseResourcePlanId !== plan.id ||
        reservation.status !== "RESERVED" ||
        reservation.expiresAt <= observedAt ||
        !capacityFits ||
        !plateCountFits ||
        !bindingMatchesDraft ||
        !origin
      ) {
        return false;
      }
      await transaction.order.updateMany({
        where: { id: input.orderId, status: OrderStatus.DRAFT },
        data: {
          status: OrderStatus.QUOTED,
          quotedAt: observedAt,
          updatedAt: observedAt,
        },
      });
      await transaction.quoteSession.updateMany({
        where: {
          id: origin.quoteSessionId,
          status: QuoteSessionStatus.OPEN,
        },
        data: {
          status: QuoteSessionStatus.CONVERTED,
          updatedAt: observedAt,
        },
      });
      await transaction.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      return true;
    });
  }

  private async planCapacityFitsWindow(
    transaction: Transaction | PrismaService,
    phaseResourcePlanId: string,
    nodeId: string,
    observedAt: Date,
    capacityWindowSeconds: bigint,
  ): Promise<boolean> {
    const capacityEndsAt = new Date(
      observedAt.getTime() + Number(capacityWindowSeconds * 1_000n),
    );
    const rows = await transaction.$queryRaw<Array<{ fits: boolean }>>`
      SELECT
        count(*) > 0
        AND bool_and(
          candidate_interval.starts_at > ${observedAt}
          AND candidate_interval.ends_at <= ${capacityEndsAt}
        ) AS fits
      FROM phase_resource_plan_jobs plan_job
      JOIN candidate_capacity_intervals candidate_interval
        ON candidate_interval.candidate_resource_estimate_id =
           plan_job.candidate_resource_estimate_id
       AND candidate_interval.node_id = plan_job.node_id
      WHERE plan_job.phase_resource_plan_id = ${phaseResourcePlanId}::uuid
        AND plan_job.node_id = ${nodeId}::uuid
    `;
    return rows[0]?.fits === true;
  }

  private async planPlateCountFitsLimit(
    transaction: Transaction | PrismaService,
    phaseResourcePlanId: string,
    nodeId: string,
    maximumPlateCount: bigint,
  ): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ fits: boolean }>>`
      SELECT
        count(candidate_interval.id) > 0
        AND count(candidate_interval.id) <= ${maximumPlateCount}::bigint AS fits
      FROM phase_resource_plan_jobs plan_job
      JOIN candidate_capacity_intervals candidate_interval
        ON candidate_interval.candidate_resource_estimate_id =
           plan_job.candidate_resource_estimate_id
       AND candidate_interval.node_id = plan_job.node_id
      WHERE plan_job.phase_resource_plan_id = ${phaseResourcePlanId}::uuid
        AND plan_job.node_id = ${nodeId}::uuid
    `;
    return rows[0]?.fits === true;
  }

  private async referenceSlices(
    transaction: Transaction | PrismaService,
    item: {
      selectionSha256: string;
      printConfigRevisionId: string;
      referenceProfileId: string;
    },
    geometry: { id: string; geometryHash: string },
    occupancies: readonly number[],
  ) {
    const { buildReferenceSliceCacheKey, RevisionRef, Sha256Digest } =
      await import("@taven/core");
    const slices = [];
    for (const partsPerPlate of occupancies) {
      const cacheKey = buildReferenceSliceCacheKey({
        geometryHash: Sha256Digest.parse(geometry.geometryHash),
        modelGeometryId: geometry.id,
        geometrySelectionHash: Sha256Digest.parse(item.selectionSha256),
        referenceProfileRevision: RevisionRef.create(
          "reference-profile",
          item.referenceProfileId,
        ),
        printConfigRevision: RevisionRef.create(
          "print-config",
          item.printConfigRevisionId,
        ),
        partsPerPlate,
      });
      slices.push(
        await transaction.sliceResult.findUniqueOrThrow({
          where: { cacheKey },
        }),
      );
    }
    return slices;
  }

  private async pricingItemsFromDraft(
    transaction: Transaction | PrismaService,
    orderId: string,
    draftItems: ReadonlyArray<{
      id: string;
      ordinal: number;
      sourceModelFileId: string;
      bodyIds: string[];
      selectionSha256: string;
      targetModelGeometryId: string;
      printConfigRevisionId: string;
      referenceProfileId: string;
      material: Material;
      infillPreset: string;
      quantity: number;
      referencePartsPerPlate: number | null;
    }>,
    roughParameters: AutomaticQuotePricingParameters | null,
  ): Promise<{
    items: AutomaticQuotePricingItem[];
    allReferenceSliced: boolean;
  } | null> {
    const items: AutomaticQuotePricingItem[] = [];
    let allReferenceSliced = true;
    for (const item of draftItems) {
      const geometry = await transaction.modelGeometry.findUnique({
        where: { id: item.targetModelGeometryId },
      });
      const referencePartsPerPlate =
        item.referencePartsPerPlate ?? (roughParameters ? item.quantity : null);
      if (referencePartsPerPlate === null) return null;
      const occupancies = referenceOccupancies(
        item.quantity,
        referencePartsPerPlate,
      );
      const slices = geometry
        ? await this.referenceSlices(
            transaction,
            item,
            geometry,
            occupancies,
          ).catch((error: unknown) => {
            if (
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === "P2025"
            ) {
              return null;
            }
            throw error;
          })
        : null;
      let bounds: {
        volumeCubicMicrometers: bigint;
        boundsXMicrometers: bigint;
        boundsYMicrometers: bigint;
        boundsZMicrometers: bigint;
      } | null = geometry;
      if (!bounds && roughParameters) {
        const attachment = await transaction.automaticQuoteModelFile.findUnique(
          {
            where: {
              orderId_modelFileId: {
                orderId,
                modelFileId: item.sourceModelFileId,
              },
            },
          },
        );
        const inspection = attachment
          ? await terminalResultForJob(
              transaction,
              attachment.inspectionJobId,
              "model_inspection",
            )
          : null;
        bounds = inspectionMeshEstimate(inspection, item.bodyIds);
      }
      if (!bounds) return null;

      let primary: AutomaticQuotePricingItem["primary"] | null =
        slices?.[0] ?? null;
      let tail: AutomaticQuotePricingItem["tail"] = slices?.[1] ?? null;
      if (!primary) {
        if (!roughParameters) return null;
        const estimated = roughSliceMetrics(
          { ...item, referencePartsPerPlate },
          bounds.volumeCubicMicrometers,
          roughParameters,
        );
        primary = estimated.primary;
        tail = estimated.tail;
        allReferenceSliced = false;
      }
      const itemId = deterministicUuid(`automatic-order-item:${item.id}`);
      items.push({
        id: itemId,
        referenceProfileId: item.referenceProfileId,
        material: item.material,
        quantity: item.quantity,
        referencePartsPerPlate: occupancies[0]!,
        primary,
        tail,
        boundsXMicrometers: bounds.boundsXMicrometers,
        boundsYMicrometers: bounds.boundsYMicrometers,
        boundsZMicrometers: bounds.boundsZMicrometers,
        fulfilmentSlots: Array.from({ length: item.quantity }, (_, index) => ({
          packingUnitKey: `${itemId}:single:${index + 1}`,
        })),
      });
    }
    return { items, allReferenceSliced };
  }

  private async roughQuote(
    orderId: string,
    candidateAdmissionSatisfied = false,
  ): Promise<{
    quote: AutomaticQuoteSessionDto["roughEstimate"];
    deliveryOptions: AutomaticQuoteSessionDto["deliveryOptions"];
    express: { eligible: boolean; reasons: readonly string[] };
    reasons: readonly string[];
  } | null> {
    const [draft, priceList] = await Promise.all([
      this.prisma.automaticQuoteDraft.findUnique({
        where: { orderId },
        include: {
          selectedDeliveryDestination: true,
          items: { orderBy: { ordinal: "asc" } },
        },
      }),
      this.prisma.priceList.findUnique({
        where: {
          currency_revision: {
            currency: "CZK",
            revision: AUTOMATIC_PRICE_LIST_REVISION,
          },
        },
      }),
    ]);
    if (!draft || !priceList || draft.items.length === 0) return null;
    const pricing = await this.pricingItemsFromDraft(
      this.prisma,
      orderId,
      draft.items,
      parseAutomaticQuotePricingParameters(priceList.parameters),
    );
    if (!pricing) return null;
    const deliveryOptions = await this.deliveryOptions({
      orderId,
      configurationRevision: draft.configurationRevision,
      expressRequested: draft.expressRequested,
      items: pricing.items,
      priceList,
    });
    const itemOrdinals = new Map(
      pricing.items.map((item, index) => [
        item.id,
        draft.items[index]!.ordinal,
      ]),
    );
    const preparationInput = {
      priceList,
      items: pricing.items,
      expressRequested: draft.expressRequested,
      riskAcknowledgementsComplete: true,
      hasBlockingPreflightFinding: false,
      ...(draft.selectedDeliveryDestination
        ? {
            deliveryDestination: draft.selectedDeliveryDestination,
            shipmentPlanIdForOrdinal: (ordinal: number) =>
              deterministicUuid(
                `automatic-rough-shipment-plan:${orderId}:${draft.configurationRevision}:${ordinal}`,
              ),
          }
        : {}),
    };
    const provisionalPlan = await prepareAutomaticQuote({
      ...preparationInput,
      materialAndColorAvailable: true,
      withinBuildLimits: true,
    });
    const candidateResourcesAvailable = candidateAdmissionSatisfied
      ? true
      : await this.candidateResourcesAvailable(
          this.prisma,
          draft.items,
          pricing.items,
          provisionalPlan.prepared.kind === "binding_quote"
            ? provisionalPlan.prepared.shipmentPlan
            : undefined,
        );
    const candidateGate = candidateResourcesAvailable ?? true;
    const result = candidateGate
      ? provisionalPlan.prepared
      : (
          await prepareAutomaticQuote({
            ...preparationInput,
            materialAndColorAvailable: false,
            withinBuildLimits: false,
          })
        ).prepared;
    return {
      quote: provisionalPriceDto(result.price, itemOrdinals),
      deliveryOptions,
      express: result.expressEligibility,
      reasons: pricing.allReferenceSliced ? result.reasons : [],
    };
  }

  private async loadSession(sessionId: string) {
    const session = await this.prisma.quoteSession.findUnique({
      where: { id: sessionId },
      include: {
        automaticOrderOrigin: {
          include: {
            order: {
              include: {
                automaticQuoteDraft: {
                  include: {
                    selectedDeliveryDestination: true,
                    modelFiles: {
                      include: { modelFile: true },
                      orderBy: { createdAt: "asc" },
                    },
                    items: {
                      include: {
                        printConfigRevision: true,
                        riskDecisions: true,
                      },
                      orderBy: { ordinal: "asc" },
                    },
                  },
                },
                activePriceBinding: {
                  include: {
                    orderPriceBinding: {
                      include: {
                        priceSnapshot: {
                          include: { components: true },
                        },
                        shipmentPlans: true,
                      },
                    },
                  },
                },
                items: { orderBy: { ordinal: "asc" } },
                phases: true,
              },
            },
          },
        },
      },
    });
    if (!session?.automaticOrderOrigin?.order.automaticQuoteDraft) {
      throw new NotFoundException("Automatic quote session was not found");
    }
    return session;
  }

  private async readModel(
    session: Awaited<ReturnType<AutomaticQuotesService["loadSession"]>>,
  ): Promise<AutomaticQuoteSessionDto> {
    const order = session.automaticOrderOrigin!.order;
    const draft = order.automaticQuoteDraft!;
    const expired =
      session.status === QuoteSessionStatus.EXPIRED ||
      session.expiresAt.getTime() <= Date.now();
    const modelFiles = await Promise.all(
      draft.modelFiles.map(async (attached) => {
        if (attached.modelFile.format === ModelFileFormat.STEP) {
          return {
            modelFileId: attached.modelFileId,
            format: attached.modelFile.format,
            inspectionStatus: "UNSUPPORTED" as const,
            discoveredBodyIds: [],
          };
        }
        const [result, dispatch] = await Promise.all([
          terminalResultForJob(
            this.prisma,
            attached.inspectionJobId,
            "model_inspection",
          ),
          this.latestPreprocessingDispatch(
            this.prisma,
            attached.inspectionJobId,
            "slicing.model-inspection.requested",
          ),
        ]);
        return {
          modelFileId: attached.modelFileId,
          format: attached.modelFile.format,
          inspectionStatus: dispatch?.deadLettered
            ? ("FAILED" as const)
            : terminalStatus(result),
          discoveredBodyIds: successfulInspectionBodies(result),
        };
      }),
    );
    const configurationCapabilities = await this.configurationCapabilities();
    const configurationOptions = configurationCapabilities.map(
      ({ referenceProfileId: _referenceProfileId, ...option }) => option,
    );
    const itemDtos = await Promise.all(
      draft.items.map(async (item) => {
        const geometry = await this.prisma.modelGeometry.findUnique({
          where: { id: item.targetModelGeometryId },
        });
        const occupancy = geometry
          ? await this.resolveReferenceOccupancy(
              this.prisma,
              item,
              geometry,
              order.id,
              false,
            )
          : null;
        const missing =
          geometry && occupancy?.kind === "resolved"
            ? await this.missingReferenceSlices(
                this.prisma,
                item,
                geometry,
                referenceOccupancies(item.quantity, occupancy.partsPerPlate),
              )
            : [];
        const findings = await this.currentRiskFindings(this.prisma, item);
        const decisions = new Map(
          item.riskDecisions
            .filter(
              (decision) =>
                decision.configurationFingerprint ===
                item.configurationFingerprint,
            )
            .map((decision) => [
              decision.preflightFindingId,
              decision.decision,
            ]),
        );
        return {
          id: item.id,
          ordinal: item.ordinal,
          modelFileId: item.sourceModelFileId,
          bodyIds: item.bodyIds,
          printConfigRevisionId: item.printConfigRevisionId,
          material: item.material,
          color: item.color,
          infillPreset: item.infillPreset,
          quality: item.printConfigRevision.quality,
          quantity: item.quantity,
          fitSensitive: item.fitSensitive,
          status: !geometry
            ? ("CANONICALIZATION_PENDING" as const)
            : occupancy?.kind !== "resolved" ||
                item.referencePartsPerPlate !== occupancy.partsPerPlate ||
                missing.length > 0
              ? ("REFERENCE_SLICING_PENDING" as const)
              : ("READY" as const),
          findings: findings.map((finding) => ({
            id: finding.id,
            code: finding.code,
            severity: finding.severity,
            message: finding.message,
            acknowledgementKey: findingAcknowledgementKey(finding.evidence),
            decision: decisions.get(finding.id) ?? null,
          })),
        };
      }),
    );
    const handoffReasons: string[] = [];
    if (await this.preprocessingRequiresHandoff(order.id, draft.items)) {
      handoffReasons.push("PREPROCESSING_FAILED");
    }
    if (await this.candidateEstimationRequiresHandoff(order.id)) {
      handoffReasons.push("CANDIDATE_ESTIMATION_FAILED");
    }
    if (modelFiles.some((file) => file.inspectionStatus === "UNSUPPORTED")) {
      handoffReasons.push("UNSUPPORTED_FORMAT");
    }
    if (modelFiles.some((file) => file.inspectionStatus === "FAILED")) {
      handoffReasons.push("INSPECTION_FAILED");
    }
    if (
      modelFiles.length > 0 &&
      modelFiles.every((file) => file.inspectionStatus === "SUCCEEDED") &&
      itemDtos.length === 0 &&
      configurationOptions.length === 0
    ) {
      handoffReasons.push("NO_CONFIGURATION_AVAILABLE");
    }
    if (
      itemDtos.some((item) =>
        item.findings.some((finding) => finding.severity === "BLOCKING"),
      )
    ) {
      handoffReasons.push("BLOCKING_PREFLIGHT_FINDING");
    }
    if (
      itemDtos.some((item) =>
        item.findings.some((finding) => finding.decision === "DECLINED"),
      )
    ) {
      handoffReasons.push("RISK_DECLINED");
    }
    if (itemDtos.some((item) => item.fitSensitive)) {
      handoffReasons.push("FIT_SENSITIVE");
    }
    const warningCount = itemDtos.reduce(
      (count, item) =>
        count +
        item.findings.filter((finding) => finding.severity === "WARNING")
          .length,
      0,
    );
    if (warningCount > 3) {
      handoffReasons.push("RISK_ACKNOWLEDGEMENT_LIMIT_EXCEEDED");
    }
    const readyItems =
      itemDtos.length > 0 && itemDtos.every((item) => item.status === "READY");
    const acknowledgementIncomplete = itemDtos.some((item) =>
      item.findings.some(
        (finding) =>
          finding.severity === "WARNING" && finding.decision !== "ACKNOWLEDGED",
      ),
    );
    const candidateActive = order.activePriceBinding?.orderPriceBinding;
    const active =
      candidateActive && bindingMatchesAutomaticDraft(candidateActive, draft)
        ? candidateActive
        : undefined;
    const currentPlan = active
      ? await this.prisma.phaseResourcePlan.findFirst({
          where: {
            orderPhaseId: { in: order.phases.map((phase) => phase.id) },
            expiresAt: { gt: new Date() },
            jobs: {
              some: {
                candidateResourceEstimate: {
                  shipmentPlan: { orderPriceBindingId: active.id },
                },
              },
            },
          },
          include: { reservationSets: true },
          orderBy: { createdAt: "desc" },
        })
      : null;
    const currentReservation = currentPlan?.reservationSets.find(
      (reservation) =>
        reservation.status === "RESERVED" &&
        reservation.expiresAt.getTime() > Date.now(),
    );
    const hasLiveReservation = Boolean(currentPlan && currentReservation);
    const rough =
      itemDtos.length > 0
        ? await this.roughQuote(order.id, hasLiveReservation)
        : null;
    const deliveryOptions =
      rough?.deliveryOptions ?? (await this.deliveryOptions());
    const selectedDeliveryDestination = draft.selectedDeliveryDestination
      ? {
          providerEndpointId:
            draft.selectedDeliveryDestination.providerEndpointId,
          endpointType: draft.selectedDeliveryDestination.endpointType,
          label: selectedDestinationLabel(
            draft.selectedDeliveryDestination.addressSnapshot,
            draft.selectedDeliveryDestination.providerEndpointId,
          ),
        }
      : null;
    const permanentRoughReasons = new Set([
      "UNSUPPORTED_FORMAT",
      "BLOCKING_PREFLIGHT_FINDING",
      "AUTOMATIC_QUANTITY_LIMIT_EXCEEDED",
      "AUTOMATIC_AMOUNT_LIMIT_EXCEEDED",
      "BUILD_LIMIT_EXCEEDED",
      "EXPRESS_INELIGIBLE",
    ]);
    for (const reason of rough?.reasons ?? []) {
      if (
        permanentRoughReasons.has(reason) &&
        !handoffReasons.includes(reason)
      ) {
        handoffReasons.push(reason);
      }
    }
    const checkoutReady =
      !expired &&
      order.status === OrderStatus.QUOTED &&
      Boolean(active && currentPlan && currentReservation);
    if (
      readyItems &&
      !checkoutReady &&
      deliveryOptions.length === 0 &&
      !handoffReasons.includes("SHIPMENT_INELIGIBLE")
    ) {
      handoffReasons.push("SHIPMENT_INELIGIBLE");
    }
    const expressCandidatePending =
      draft.expressRequested &&
      !expired &&
      !checkoutReady &&
      rough?.express.eligible === true;
    const bindingQuote =
      checkoutReady && active
        ? priceDto(
            active.priceSnapshot,
            order.items,
            active.shipmentPlans,
            "BINDING",
          )
        : null;
    const shipmentIneligible =
      rough?.reasons.includes("SHIPMENT_INELIGIBLE") ?? false;
    const quantityComparisons =
      itemDtos.length > 0 ? await this.quantityComparisons(order.id) : [];
    const phase = expired
      ? "EXPIRED"
      : handoffReasons.length > 0
        ? "HANDOFF_REQUIRED"
        : modelFiles.length === 0 ||
            modelFiles.some((file) => file.inspectionStatus === "PENDING")
          ? "INSPECTION_PENDING"
          : itemDtos.length === 0
            ? "CONFIGURATION_REQUIRED"
            : !readyItems
              ? "REFERENCE_SLICES_PENDING"
              : acknowledgementIncomplete
                ? "ACTION_REQUIRED"
                : !draft.selectedDeliveryDestinationId || shipmentIneligible
                  ? "DESTINATION_REQUIRED"
                  : checkoutReady
                    ? "CHECKOUT_READY"
                    : "ELIGIBILITY_PENDING";
    return {
      sessionId: session.id,
      orderId: order.id,
      publicReference: order.publicReference,
      phase,
      configurationRevision: draft.configurationRevision,
      configurationEditable: !expired && order.items.length === 0,
      checkoutEvidenceAccepted: Boolean(order.acceptedOrderPriceBindingId),
      modelFiles,
      items: itemDtos,
      configurationOptions,
      deliveryOptions: [...deliveryOptions],
      selectedDeliveryDestination,
      quantityComparisons,
      roughEstimate: rough?.quote ?? null,
      bindingQuote,
      express: {
        requested: draft.expressRequested,
        eligible: draft.expressRequested
          ? checkoutReady && rough?.express.eligible === true
          : (rough?.express.eligible ?? false),
        reasons: expressCandidatePending
          ? ["ELIGIBILITY_PENDING"]
          : ((rough ? [...rough.express.reasons] : undefined) ??
            (draft.expressRequested ? ["ELIGIBILITY_PENDING"] : [])),
      },
      handoff:
        handoffReasons.length > 0
          ? {
              kind: "INDIVIDUAL_QUOTE_REQUEST",
              reasons: handoffReasons,
              safeContext: {
                automaticQuoteSessionId: session.id,
                modelFileIds: draft.modelFiles.map(
                  ({ modelFileId }) => modelFileId,
                ),
                itemSelections: draft.items.map((item) => ({
                  ordinal: item.ordinal,
                  modelFileId: item.sourceModelFileId,
                  bodyIds: item.bodyIds,
                  material: item.material,
                  quantity: item.quantity,
                  fitSensitive: item.fitSensitive,
                })),
              },
            }
          : null,
      checkoutReady,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  // This catalog seeds the selector before the customer has supplied bodies and
  // quantity. configureItem applies the authoritative whole-draft inventory
  // gate before persisting the selection or allowing slicing to be enqueued.
  private async configurationCapabilities(
    client: Transaction | PrismaService = this.prisma,
  ) {
    const rows = await client.$queryRaw<
      Array<{
        referenceProfileId: string;
        referenceActivatedAt: Date | null;
        printConfigRevisionId: string;
        material: "PLA" | "PETG";
        color: string | null;
        quality: "DRAFT" | "STANDARD" | "FINE";
        infillPercent: number;
      }>
    >`
      SELECT DISTINCT
        reference.id AS "referenceProfileId",
        reference.activated_at AS "referenceActivatedAt",
        config.id AS "printConfigRevisionId",
        profile.material::text AS material,
        inventory.color,
        config.quality::text AS quality,
        config.infill_percent AS "infillPercent"
      FROM reference_profiles reference
      JOIN machine_profiles profile
        ON profile.reference_profile_id = reference.id
       AND profile.material = reference.material
       AND profile.quality = reference.quality
       AND profile.state = 'ACTIVE'
       AND profile.production_artifact_format <> 'bgcode'
      JOIN print_config_revisions config
        ON config.quality = profile.quality
       AND config.infill_percent IN (10, 20, 40)
       AND NOT config.supports_enabled
       AND NOT config.brim_enabled
      JOIN machines machine
        ON machine.machine_capability_id = profile.machine_capability_id
       AND machine.status = 'ACTIVE'
       AND machine.installed_nozzle_micrometers =
           profile.nozzle_diameter_micrometers
      JOIN nodes node
        ON node.id = machine.node_id
       AND node.active
      JOIN machine_calibrations calibration
        ON calibration.node_id = machine.node_id
       AND calibration.machine_id = machine.id
       AND calibration.state = 'ACTIVE'
      JOIN inventories inventory
        ON inventory.node_id = machine.node_id
       AND inventory.machine_id = machine.id
       AND inventory.status = 'AVAILABLE'
       AND inventory.remaining_milligrams > inventory.reserved_milligrams
       AND inventory.material = profile.material
      WHERE reference.state = 'ACTIVE'
      ORDER BY
        profile.material::text,
        inventory.color NULLS FIRST,
        config.quality::text,
        config.infill_percent,
        config.id,
        reference.activated_at DESC NULLS LAST,
        reference.id
    `;
    const options = new Map<string, (typeof rows)[number]>();
    const addOption = (row: (typeof rows)[number]) => {
      const key = JSON.stringify([
        row.printConfigRevisionId,
        row.material,
        row.color,
        row.quality,
        row.infillPercent,
      ]);
      if (!options.has(key)) options.set(key, row);
    };
    for (const row of rows) {
      addOption(row);
      if (row.color !== null) addOption({ ...row, color: null });
    }
    return [...options.values()].map((row) => ({
      referenceProfileId: row.referenceProfileId,
      printConfigRevisionId: row.printConfigRevisionId,
      material: row.material,
      color: row.color,
      quality: row.quality,
      infillPreset: infillPreset(row.infillPercent),
    }));
  }

  private async deliveryOptions(input?: {
    orderId: string;
    configurationRevision: number;
    expressRequested: boolean;
    items: readonly AutomaticQuotePricingItem[];
    priceList: {
      id: string;
      revision: string;
      termsRevision: string;
      currency: string;
      parameters: Prisma.JsonValue;
    };
  }) {
    const [options, priceList] = await Promise.all([
      this.deliveryCapabilities.list(),
      input
        ? Promise.resolve(input.priceList)
        : this.prisma.priceList.findUnique({
            where: {
              currency_revision: {
                currency: "CZK",
                revision: AUTOMATIC_PRICE_LIST_REVISION,
              },
            },
          }),
    ]);
    if (!priceList) return [];
    const pricedCategories = new Set(
      parseAutomaticQuotePricingParameters(
        priceList.parameters,
      ).shipmentCategories.map(({ id }) => id),
    );
    const pricedOptions = options.filter((option) =>
      option.supportedCategoryIds.some((id) => pricedCategories.has(id)),
    );
    const viableOptions = input
      ? (
          await Promise.all(
            pricedOptions.map(async (option) => {
              const identity = fingerprintOf({
                endpointType: option.endpointType,
                providerEndpointId: option.providerEndpointId,
              });
              const prepared = await prepareAutomaticQuote({
                priceList,
                items: input.items,
                expressRequested: input.expressRequested,
                materialAndColorAvailable: true,
                withinBuildLimits: true,
                riskAcknowledgementsComplete: true,
                hasBlockingPreflightFinding: false,
                deliveryDestination: {
                  id: deterministicUuid(
                    `automatic-delivery-option:${input.orderId}:${identity}`,
                  ),
                  capabilitySnapshot: {
                    supportedCategoryIds: [...option.supportedCategoryIds],
                  },
                },
                shipmentPlanIdForOrdinal: (ordinal) =>
                  deterministicUuid(
                    `automatic-delivery-option-plan:${input.orderId}:${input.configurationRevision}:${identity}:${ordinal}`,
                  ),
              });
              return prepared.prepared.kind !== "binding_quote" &&
                prepared.prepared.reasons.includes("SHIPMENT_INELIGIBLE")
                ? null
                : option;
            }),
          )
        ).filter((option) => option !== null)
      : pricedOptions;
    return viableOptions.map(
      ({ supportedCategoryIds: _supportedCategoryIds, ...option }) => option,
    );
  }

  private async quantityComparisons(
    orderId: string,
  ): Promise<AutomaticQuoteSessionDto["quantityComparisons"]> {
    const [draft, priceList] = await Promise.all([
      this.prisma.automaticQuoteDraft.findUnique({
        where: { orderId },
        include: {
          modelFiles: true,
          selectedDeliveryDestination: true,
          items: { orderBy: { ordinal: "asc" } },
        },
      }),
      this.prisma.priceList.findUnique({
        where: {
          currency_revision: {
            currency: "CZK",
            revision: AUTOMATIC_PRICE_LIST_REVISION,
          },
        },
      }),
    ]);
    if (!draft || !priceList || draft.items.length === 0) return [];
    const parameters = parseAutomaticQuotePricingParameters(
      priceList.parameters,
    );
    const baseline = await this.pricingItemsFromDraft(
      this.prisma,
      orderId,
      draft.items,
      parameters,
    );
    if (!baseline) return [];
    const geometries = await this.prisma.modelGeometry.findMany({
      where: {
        id: {
          in: draft.items.map(
            ({ targetModelGeometryId }) => targetModelGeometryId,
          ),
        },
      },
    });
    const geometryById = new Map(
      geometries.map((geometry) => [geometry.id, geometry]),
    );
    const missingGeometryModelFileIds = new Set(
      draft.items
        .filter((item) => !geometryById.has(item.targetModelGeometryId))
        .map(({ sourceModelFileId }) => sourceModelFileId),
    );
    const inspectionByModelFileId = new Map(
      await Promise.all(
        draft.modelFiles
          .filter(({ modelFileId }) =>
            missingGeometryModelFileIds.has(modelFileId),
          )
          .map(
            async (attached) =>
              [
                attached.modelFileId,
                await terminalResultForJob(
                  this.prisma,
                  attached.inspectionJobId,
                  "model_inspection",
                ),
              ] as const,
          ),
      ),
    );
    const comparisons: AutomaticQuoteSessionDto["quantityComparisons"] = [];
    for (const [activeIndex, activeItem] of draft.items.entries()) {
      const bounds =
        geometryById.get(activeItem.targetModelGeometryId) ??
        inspectionMeshEstimate(
          inspectionByModelFileId.get(activeItem.sourceModelFileId),
          activeItem.bodyIds,
        );
      if (!bounds) continue;
      for (const quantity of [1, 5, 20] as const) {
        let comparisonItem = baseline.items[activeIndex]!;
        if (quantity !== activeItem.quantity) {
          const referencePartsPerPlate =
            activeItem.referencePartsPerPlate ?? quantity;
          const metrics = roughSliceMetrics(
            { ...activeItem, quantity, referencePartsPerPlate },
            bounds.volumeCubicMicrometers,
            parameters,
          );
          comparisonItem = {
            id: comparisonItem.id,
            referenceProfileId: activeItem.referenceProfileId,
            material: activeItem.material,
            quantity,
            referencePartsPerPlate,
            primary: metrics.primary,
            tail: metrics.tail,
            boundsXMicrometers: bounds.boundsXMicrometers,
            boundsYMicrometers: bounds.boundsYMicrometers,
            boundsZMicrometers: bounds.boundsZMicrometers,
            fulfilmentSlots: Array.from({ length: quantity }, (_, index) => ({
              packingUnitKey: `${comparisonItem.id}:single:${index + 1}`,
            })),
          };
        }
        const comparisonItems = [...baseline.items];
        comparisonItems[activeIndex] = comparisonItem;
        const prepared = await prepareAutomaticQuote({
          priceList,
          items: comparisonItems,
          expressRequested: draft.expressRequested,
          materialAndColorAvailable: true,
          withinBuildLimits: true,
          riskAcknowledgementsComplete: true,
          hasBlockingPreflightFinding: false,
          ...(draft.selectedDeliveryDestination
            ? {
                deliveryDestination: draft.selectedDeliveryDestination,
                shipmentPlanIdForOrdinal: (ordinal: number) =>
                  deterministicUuid(
                    `automatic-quantity-comparison:${orderId}:${draft.configurationRevision}:${activeItem.ordinal}:${quantity}:${ordinal}`,
                  ),
              }
            : {}),
        });
        comparisons.push({
          itemOrdinal: activeItem.ordinal,
          quantity,
          currency: priceList.currency,
          orderTotalMinor: safeNumber(
            prepared.prepared.price.customerTotal.minorUnits,
          ),
        });
      }
    }
    return comparisons;
  }
}

function infillPreset(
  infillPercent: number,
): "DECORATIVE" | "STANDARD" | "STRONG" {
  if (infillPercent === INFILL_PERCENT.DECORATIVE) return "DECORATIVE";
  if (infillPercent === INFILL_PERCENT.STANDARD) return "STANDARD";
  if (infillPercent === INFILL_PERCENT.STRONG) return "STRONG";
  throw new Error(`Unsupported named infill percent: ${infillPercent}`);
}

function referenceOccupancies(
  quantity: number,
  partsPerPlate: number,
): number[] {
  if (quantity <= partsPerPlate) return [quantity];
  const remainder = quantity % partsPerPlate;
  return remainder === 0 ? [partsPerPlate] : [partsPerPlate, remainder];
}

function totalEstimatedMaterial(item: AutomaticQuotePricingItem): bigint {
  const fullPlateCount = Math.floor(
    item.quantity / item.referencePartsPerPlate,
  );
  const remainder = item.quantity % item.referencePartsPerPlate;
  return (
    item.primary.estimatedMaterialMilligrams *
      BigInt(Math.max(1, fullPlateCount)) +
    (remainder > 0 && item.quantity > item.referencePartsPerPlate
      ? (item.tail?.estimatedMaterialMilligrams ?? 0n)
      : 0n)
  );
}

function automaticBindingExpressRequested(
  inputSnapshot: Prisma.JsonValue,
): boolean | null {
  const requested = asRecord(
    asRecord(inputSnapshot)?.automaticQuote,
  )?.expressRequested;
  return typeof requested === "boolean" ? requested : null;
}

function automaticBindingConfigurationRevision(
  inputSnapshot: Prisma.JsonValue,
): number | null {
  const revision = asRecord(
    asRecord(inputSnapshot)?.automaticQuote,
  )?.configurationRevision;
  return typeof revision === "number" && Number.isSafeInteger(revision)
    ? revision
    : null;
}

function bindingMatchesAutomaticDraft(
  binding: {
    deliveryDestinationId: string;
    priceSnapshot: { inputSnapshot: Prisma.JsonValue };
  },
  draft: {
    selectedDeliveryDestinationId: string | null;
    expressRequested: boolean;
    configurationRevision: number;
  },
): boolean {
  return (
    binding.deliveryDestinationId === draft.selectedDeliveryDestinationId &&
    automaticBindingExpressRequested(binding.priceSnapshot.inputSnapshot) ===
      draft.expressRequested &&
    automaticBindingConfigurationRevision(
      binding.priceSnapshot.inputSnapshot,
    ) === draft.configurationRevision
  );
}

function candidateParcelDemands(
  items: readonly AutomaticQuotePricingItem[],
  shipmentPlan: AutomaticBindingQuote["shipmentPlan"],
): Array<{ itemId: string; quantity: number }> | null {
  const itemByPackingUnitKey = new Map<string, AutomaticQuotePricingItem>();
  for (const item of items) {
    for (const slot of item.fulfilmentSlots) {
      if (itemByPackingUnitKey.has(slot.packingUnitKey)) return null;
      itemByPackingUnitKey.set(slot.packingUnitKey, item);
    }
  }

  const quantitiesByDemand = new Map<
    string,
    { item: AutomaticQuotePricingItem; quantity: number }
  >();
  const placedPackingUnitKeys = new Set<string>();
  for (const parcel of shipmentPlan.parcels) {
    for (const placement of parcel.placements) {
      const item = itemByPackingUnitKey.get(placement.packingUnitKey);
      if (!item || placedPackingUnitKeys.has(placement.packingUnitKey)) {
        return null;
      }
      placedPackingUnitKeys.add(placement.packingUnitKey);
      const demandKey = `${item.id}:${parcel.ordinal}`;
      const current = quantitiesByDemand.get(demandKey);
      quantitiesByDemand.set(demandKey, {
        item,
        quantity: (current?.quantity ?? 0) + 1,
      });
    }
  }
  if (placedPackingUnitKeys.size !== itemByPackingUnitKey.size) return null;

  return [...quantitiesByDemand.values()].map(({ item, quantity }) => ({
    itemId: item.id,
    quantity,
  }));
}

function estimatedMaterialForQuantity(
  quantity: number,
  partsPerPlate: number,
  slices: ReadonlyArray<{ estimatedMaterialMilligrams: bigint }>,
): bigint {
  const primary = slices[0];
  if (!primary) {
    throw new Error(
      "Candidate material calculation is missing its primary slice",
    );
  }
  const fullPlateCount = Math.floor(quantity / partsPerPlate);
  const remainder = quantity % partsPerPlate;
  if (quantity <= partsPerPlate) {
    return primary.estimatedMaterialMilligrams;
  }
  const tail = remainder > 0 ? slices[1] : null;
  if (remainder > 0 && !tail) {
    throw new Error("Candidate material calculation is missing its tail slice");
  }
  return (
    primary.estimatedMaterialMilligrams * BigInt(fullPlateCount) +
    (tail?.estimatedMaterialMilligrams ?? 0n)
  );
}

function automaticExpressCapacityWindowSeconds(
  parameters: AutomaticQuotePricingParameters,
): bigint {
  const productionWindowSeconds =
    parameters.expressAvailableProductionWindowSeconds -
    parameters.expressPackagingBufferSeconds;
  const milliseconds = productionWindowSeconds * 1_000n;
  if (
    productionWindowSeconds <= 0n ||
    milliseconds > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ConflictException("Automatic express capacity is unavailable");
  }
  return productionWindowSeconds;
}

function hasUsableInventoryAssignment(
  items: ReadonlyArray<{
    requiredMaterialMilligrams: bigint;
    options: ReadonlyArray<{ inventoryId: string; available: bigint }>;
  }>,
): boolean {
  const ordered = [...items].sort(
    (left, right) =>
      left.options.length - right.options.length ||
      (left.requiredMaterialMilligrams > right.requiredMaterialMilligrams
        ? -1
        : left.requiredMaterialMilligrams < right.requiredMaterialMilligrams
          ? 1
          : 0),
  );
  const remaining = new Map<string, bigint>();
  for (const item of ordered) {
    for (const option of item.options) {
      remaining.set(option.inventoryId, option.available);
    }
  }
  const assign = (index: number): boolean => {
    const item = ordered[index];
    if (!item) return true;
    for (const option of item.options) {
      const available = remaining.get(option.inventoryId) ?? 0n;
      if (available < item.requiredMaterialMilligrams) continue;
      remaining.set(
        option.inventoryId,
        available - item.requiredMaterialMilligrams,
      );
      if (assign(index + 1)) return true;
      remaining.set(option.inventoryId, available);
    }
    return false;
  };
  return assign(0);
}

function inspectionInput(
  source: {
    id: string;
    format: ModelFileFormat;
    storageObjectKey: string;
    contentHash: string;
  },
  operation: JsonRecord,
) {
  return {
    source: {
      modelFileId: source.id,
      format: source.format === ModelFileFormat.STL ? "stl" : "3mf",
      objectKey: source.storageObjectKey,
      contentSha256: source.contentHash,
    },
    operation,
    inspectionRevision: INSPECTION_REVISION,
    inspectionConfigSha256: INSPECTION_CONFIG_SHA256,
    canonicalizerRevision: CANONICALIZER_REVISION,
    canonicalizerConfigSha256: CANONICALIZER_CONFIG_SHA256,
  };
}

async function enqueueInspection(
  transaction: Transaction,
  input: {
    jobId: string;
    correlationId: string;
    source: {
      id: string;
      format: ModelFileFormat;
      storageObjectKey: string;
      contentHash: string;
    };
    attempt?: number;
    availableAt?: Date;
    operation: JsonRecord;
  },
): Promise<void> {
  const {
    ModelInspectionJobSchema,
    slicingDispatchAttemptKey,
    slicingInputFingerprint,
  } = await import("@taven/slicer-contracts");
  const jobInput = inspectionInput(input.source, input.operation);
  const inputFingerprintSha256 = slicingInputFingerprint(
    "model_inspection",
    jobInput,
  );
  const attempt = input.attempt ?? 1;
  const job = ModelInspectionJobSchema.parse({
    contractVersion: 2,
    kind: "model_inspection",
    jobId: input.jobId,
    correlationId: input.correlationId,
    inputFingerprintSha256,
    idempotencyKey: `slicer:v2:model_inspection:${input.jobId}:${inputFingerprintSha256}`,
    attempt,
    input: jobInput,
  });
  const deduplicationKey = slicingDispatchAttemptKey(
    job.idempotencyKey,
    attempt,
  );
  await transaction.outboxMessage.upsert({
    where: { deduplicationKey },
    create: {
      deduplicationKey,
      aggregateType: "ModelInspectionDispatch",
      aggregateId: job.jobId,
      messageType: "slicing.model-inspection.requested",
      schemaVersion: 2,
      payload: { job } as unknown as Prisma.InputJsonObject,
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    },
    update: {},
  });
}

async function terminalResultForJob(
  transaction: Transaction | PrismaService,
  jobId: string,
  kind: "model_inspection" | "reference_slice",
): Promise<unknown> {
  const dispatch = await transaction.outboxMessage.findFirst({
    where: {
      aggregateId: jobId,
      messageType:
        kind === "model_inspection"
          ? "slicing.model-inspection.requested"
          : "slicing.reference-slice.requested",
    },
    orderBy: { createdAt: "desc" },
  });
  if (!dispatch) return null;
  const receipt = await transaction.outboxMessage.findFirst({
    where: {
      aggregateType: "SlicingDispatchResult",
      aggregateId: dispatch.id,
      messageType: `slicing.${kind}.result-received`,
    },
  });
  const payload = asRecord(receipt?.payload);
  return payload?.result ?? null;
}

function successfulInspectionBodies(result: unknown): string[] {
  const record = asRecord(result);
  const outcome = asRecord(record?.outcome);
  if (outcome?.status !== "succeeded" || !Array.isArray(outcome.bodies))
    return [];
  return outcome.bodies
    .flatMap((body) => {
      const bodyRecord = asRecord(body);
      return typeof bodyRecord?.bodyId === "string" ? [bodyRecord.bodyId] : [];
    })
    .sort();
}

function inspectionMeshEstimate(
  result: unknown,
  selectedBodyIds: readonly string[],
): {
  volumeCubicMicrometers: bigint;
  boundsXMicrometers: bigint;
  boundsYMicrometers: bigint;
  boundsZMicrometers: bigint;
} | null {
  const outcome = asRecord(asRecord(result)?.outcome);
  if (outcome?.status !== "succeeded" || !Array.isArray(outcome.bodies)) {
    return null;
  }
  const selectedIds = new Set(selectedBodyIds);
  const bodies = outcome.bodies.flatMap((value) => {
    const body = asRecord(value);
    if (typeof body?.bodyId !== "string" || !selectedIds.has(body.bodyId)) {
      return [];
    }
    const boundingBox = positiveBoundingBox(body.boundingBox);
    const volume = positiveBigInt(body.volumeCubicMicrometers);
    return boundingBox && volume
      ? [{ bodyId: body.bodyId, boundingBox, volume }]
      : [];
  });
  if (
    bodies.length !== selectedIds.size ||
    bodies.some(({ bodyId }) => !selectedIds.has(bodyId))
  ) {
    return null;
  }
  // Source inspection exposes body dimensions but not their relative origins.
  // A single body's bounds are exact; for a multi-body subset, use the whole
  // source bounds so rough pricing and pre-canonicalization machine admission
  // cannot underestimate a spaced assembly. Canonical geometry replaces this
  // conservative estimate once the selection has been materialized.
  const selectedBounds =
    bodies.length === 1
      ? bodies[0]!.boundingBox
      : positiveBoundingBox(asRecord(outcome.metrics)?.boundingBox);
  if (!selectedBounds) return null;
  return {
    volumeCubicMicrometers: bodies.reduce(
      (total, body) => total + body.volume,
      0n,
    ),
    boundsXMicrometers: selectedBounds.xMicrometers,
    boundsYMicrometers: selectedBounds.yMicrometers,
    boundsZMicrometers: selectedBounds.zMicrometers,
  };
}

function positiveBoundingBox(value: unknown): {
  xMicrometers: bigint;
  yMicrometers: bigint;
  zMicrometers: bigint;
} | null {
  const box = asRecord(value);
  const xMicrometers = positiveBigInt(box?.xMicrometers);
  const yMicrometers = positiveBigInt(box?.yMicrometers);
  const zMicrometers = positiveBigInt(box?.zMicrometers);
  return xMicrometers && yMicrometers && zMicrometers
    ? { xMicrometers, yMicrometers, zMicrometers }
    : null;
}

function positiveBigInt(value: unknown): bigint | null {
  if (
    (typeof value !== "string" && typeof value !== "bigint") ||
    !/^\d+$/.test(String(value))
  ) {
    return null;
  }
  const parsed = BigInt(value);
  return parsed > 0n ? parsed : null;
}

function roughSliceMetrics(
  item: {
    material: Material;
    infillPreset: string;
    quantity: number;
    referencePartsPerPlate: number;
  },
  volumeCubicMicrometers: bigint,
  parameters: AutomaticQuotePricingParameters,
): {
  primary: {
    estimatedPrintSeconds: bigint;
    estimatedMaterialMilligrams: bigint;
  };
  tail: {
    estimatedPrintSeconds: bigint;
    estimatedMaterialMilligrams: bigint;
  } | null;
} {
  if (
    !(item.infillPreset in parameters.roughMaterialVolumeRatioByInfillPreset)
  ) {
    throw new ConflictException("Automatic rough-estimate infill is invalid");
  }
  const infillPreset = item.infillPreset as
    "DECORATIVE" | "STANDARD" | "STRONG";
  const density =
    parameters.roughMaterialDensityMilligramsPerCubicMillimeter[item.material];
  const volumeRatio =
    parameters.roughMaterialVolumeRatioByInfillPreset[infillPreset];
  const materialPerUnit = ceilDivide(
    volumeCubicMicrometers * density.numerator * volumeRatio.numerator,
    1_000_000_000n * density.denominator * volumeRatio.denominator,
  );
  const metricsForQuantity = (quantity: number) => {
    const material = materialPerUnit * BigInt(quantity);
    return {
      estimatedMaterialMilligrams: material,
      estimatedPrintSeconds: ceilDivide(
        material * parameters.roughExtrusionMilligramsPerSecond.denominator,
        parameters.roughExtrusionMilligramsPerSecond.numerator,
      ),
    };
  };
  const primaryQuantity = Math.min(item.quantity, item.referencePartsPerPlate);
  const remainder = item.quantity % item.referencePartsPerPlate;
  return {
    primary: metricsForQuantity(primaryQuantity),
    tail:
      item.quantity > item.referencePartsPerPlate && remainder > 0
        ? metricsForQuantity(remainder)
        : null,
  };
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function terminalStatus(
  result: unknown,
): "PENDING" | "SUCCEEDED" | "FAILED" | "UNSUPPORTED" {
  const outcome = asRecord(asRecord(result)?.outcome);
  const status = outcome?.status;
  return status === "succeeded"
    ? "SUCCEEDED"
    : status === "failed" && outcome?.failureClass === "unsupported_input"
      ? "UNSUPPORTED"
      : status === "failed"
        ? "FAILED"
        : "PENDING";
}

function findingAcknowledgementKey(
  value: Prisma.JsonValue | null,
): string | null {
  const key = asRecord(value)?.acknowledgementKey;
  return typeof key === "string" ? key : null;
}

function priceDto(
  snapshot: {
    currency: string;
    contractTotalMinor: bigint;
    taxRegime: "NON_VAT_PAYER" | "VAT_PAYER";
    vatRateBasisPoints: number;
    netAmountMinor: bigint;
    vatAmountMinor: bigint;
    components: Array<{
      id: string;
      kind: string;
      scope: string;
      orderItemId: string | null;
      shipmentPlanId: string | null;
      amountMinor: bigint;
    }>;
  },
  orderItems: Array<{ id: string; ordinal: number }>,
  shipmentPlans: Array<{ id: string; ordinal: number }>,
  kind: "ROUGH_ESTIMATE" | "BINDING",
) {
  const itemOrdinals = new Map(
    orderItems.map((item) => [item.id, item.ordinal]),
  );
  const planOrdinals = new Map(
    shipmentPlans.map((plan) => [plan.id, plan.ordinal]),
  );
  return {
    kind,
    currency: snapshot.currency,
    taxRegime: snapshot.taxRegime,
    vatRateBasisPoints: snapshot.vatRateBasisPoints,
    netAmountMinor: safeNumber(snapshot.netAmountMinor),
    vatAmountMinor: safeNumber(snapshot.vatAmountMinor),
    totalMinor: safeNumber(snapshot.contractTotalMinor),
    components: snapshot.components.map((component) => ({
      id: component.id,
      kind: component.kind,
      scope:
        component.scope === "ORDER_ITEM"
          ? ("ORDER_ITEM" as const)
          : component.scope === "SHIPMENT_PLAN"
            ? ("SHIPMENT_PLAN" as const)
            : ("ORDER" as const),
      itemOrdinal: component.orderItemId
        ? (itemOrdinals.get(component.orderItemId) ?? null)
        : null,
      shipmentPlanOrdinal: component.shipmentPlanId
        ? (planOrdinals.get(component.shipmentPlanId) ?? null)
        : null,
      amountMinor: safeNumber(component.amountMinor),
    })),
  };
}

function provisionalPriceDto(
  price:
    | {
        kind: "provisional";
        breakdown: { subtotal: { minorUnits: bigint; currency: string } };
        customerTotal: { minorUnits: bigint };
        tax: {
          regime: "NON_VAT_PAYER" | "VAT_PAYER";
          vatRateBasisPoints: number;
          net: { minorUnits: bigint };
          vat: { minorUnits: bigint };
        };
        components: ReadonlyArray<{
          componentId: string;
          kind: string;
          targetId?: string;
          amount: { minorUnits: bigint };
        }>;
      }
    | {
        kind: "binding";
        breakdown: { subtotal: { minorUnits: bigint; currency: string } };
        customerTotal: { minorUnits: bigint };
        tax: {
          regime: "NON_VAT_PAYER" | "VAT_PAYER";
          vatRateBasisPoints: number;
          net: { minorUnits: bigint };
          vat: { minorUnits: bigint };
        };
        contractTotal: { minorUnits: bigint };
        components: ReadonlyArray<{
          componentId: string;
          kind: string;
          targetId?: string;
          amount: { minorUnits: bigint };
        }>;
      },
  itemOrdinals: ReadonlyMap<string, number>,
): AutomaticQuoteSessionDto["roughEstimate"] {
  return {
    kind: "ROUGH_ESTIMATE",
    currency: price.breakdown.subtotal.currency,
    taxRegime: price.tax.regime,
    vatRateBasisPoints: price.tax.vatRateBasisPoints,
    netAmountMinor: safeNumber(price.tax.net.minorUnits),
    vatAmountMinor: safeNumber(price.tax.vat.minorUnits),
    totalMinor: safeNumber(price.customerTotal.minorUnits),
    components: price.components.map((component) => ({
      id: component.componentId,
      kind: component.kind,
      scope:
        component.targetId && itemOrdinals.has(component.targetId)
          ? ("ORDER_ITEM" as const)
          : ("ORDER" as const),
      itemOrdinal: component.targetId
        ? (itemOrdinals.get(component.targetId) ?? null)
        : null,
      shipmentPlanOrdinal: null,
      amountMinor: safeNumber(component.amount.minorUnits),
    })),
  };
}

function cubicMicrometersToCubicMillimeters(value: bigint): bigint {
  const divisor = 1_000_000_000n;
  return (value + divisor - 1n) / divisor;
}

function jsonSafe(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? entry.toString() : entry,
    ),
  ) as Prisma.InputJsonValue;
}

async function lockedSession(transaction: Transaction, sessionId: string) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM quote_sessions WHERE id = ${sessionId}::uuid FOR UPDATE
  `;
  if (!rows[0])
    throw new NotFoundException("Automatic quote session was not found");
  return transaction.quoteSession.findUniqueOrThrow({
    where: { id: sessionId },
  });
}

function assertOpenSession(
  session: {
    publicTokenHash: string;
    status: QuoteSessionStatus;
    expiresAt: Date;
  },
  token: string,
): void {
  assertSessionCapability(session, token);
  if (
    session.status !== QuoteSessionStatus.OPEN ||
    session.expiresAt.getTime() <= Date.now()
  ) {
    throw new GoneException("Automatic quote session is no longer editable");
  }
}

function assertOpenOrConvertedSession(
  session: {
    publicTokenHash: string;
    status: QuoteSessionStatus;
    expiresAt: Date;
  },
  token: string,
): void {
  assertSessionCapability(session, token);
  if (
    (session.status !== QuoteSessionStatus.OPEN &&
      session.status !== QuoteSessionStatus.CONVERTED) ||
    session.expiresAt.getTime() <= Date.now()
  ) {
    throw new GoneException("Automatic quote session is no longer available");
  }
}

function assertSessionCapability(
  session: { publicTokenHash: string } | null | undefined,
  token: string,
): asserts session is { publicTokenHash: string } {
  if (!session || !matchesTokenHash(token, session.publicTokenHash)) {
    throw new UnauthorizedException("Capability is invalid");
  }
}

async function lockIdempotency(
  transaction: Transaction,
  namespace: string,
  idempotencyKey: string,
  requestFingerprint: string | readonly string[],
) {
  await lockIdempotencyKey(transaction, namespace, idempotencyKey);
  return idempotencyRecordAfterLock(
    transaction,
    namespace,
    idempotencyKey,
    requestFingerprint,
  );
}

async function lockIdempotencyKey(
  transaction: Transaction,
  namespace: string,
  idempotencyKey: string,
): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${namespace}:${idempotencyKey}`}, 0)
    )::text
  `;
}

async function idempotencyRecordAfterLock(
  transaction: Transaction,
  namespace: string,
  idempotencyKey: string,
  requestFingerprint: string | readonly string[],
) {
  const acceptedFingerprints =
    typeof requestFingerprint === "string"
      ? [requestFingerprint]
      : requestFingerprint;
  const primaryFingerprint = acceptedFingerprints[0];
  if (!primaryFingerprint) {
    throw new Error("At least one idempotency fingerprint is required");
  }
  const observedAt = await databaseNow(transaction);
  const existing = await transaction.idempotencyRecord.findFirst({
    where: { namespace, idempotencyKey },
    orderBy: { generation: "desc" },
  });
  if (existing && existing.expiresAt.getTime() > observedAt.getTime()) {
    if (!acceptedFingerprints.includes(existing.requestFingerprint)) {
      throw new ConflictException(
        "Idempotency key was already used with different input",
      );
    }
    if (
      existing.status !== IdempotencyStatus.COMPLETED ||
      existing.responseBody === null
    ) {
      throw new ConflictException("Idempotent command is incomplete");
    }
    return {
      id: existing.id,
      generation: existing.generation,
      replayed: true as const,
      response: existing.responseBody,
    };
  }
  const created = await transaction.idempotencyRecord.create({
    data: {
      namespace,
      idempotencyKey,
      generation: (existing?.generation ?? 0) + 1,
      requestFingerprint: primaryFingerprint,
      expiresAt: addDays(observedAt, IDEMPOTENCY_DAYS),
    },
  });
  return {
    id: created.id,
    generation: created.generation,
    replayed: false as const,
    response: null,
  };
}

async function completeIdempotency(
  transaction: Transaction,
  id: string,
  response: unknown,
): Promise<void> {
  await transaction.idempotencyRecord.update({
    where: { id },
    data: {
      status: IdempotencyStatus.COMPLETED,
      responseStatusCode: 200,
      responseBody: JSON.parse(
        JSON.stringify(response),
      ) as Prisma.InputJsonValue,
    },
  });
}

async function databaseNow(
  transaction: Transaction | PrismaService,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT clock_timestamp() AS observed_at
  `;
  if (!rows[0]) throw new Error("Database clock is unavailable");
  return rows[0].observed_at;
}

function sessionToken(
  secret: string,
  commandKey: string,
  fingerprint: string,
  generation: number,
): string {
  return createHmac("sha256", secret)
    .update(["automatic-quote", commandKey, fingerprint, generation].join("\0"))
    .digest("base64url");
}

function automaticQuoteHandoffToken(secret: string, handoffId: string): string {
  return createHmac("sha256", secret)
    .update(["automatic-quote-handoff", handoffId].join("\0"))
    .digest("base64url");
}

function handoffCapabilityResponse(
  secret: string,
  stored: { handoffId: string; expiresAt: string },
): AutomaticQuoteHandoffCapabilityDto {
  return {
    handoffToken: automaticQuoteHandoffToken(secret, stored.handoffId),
    expiresAt: stored.expiresAt,
  };
}

function handoffSnapshot(
  view: AutomaticQuoteSessionDto,
): AutomaticQuoteHandoffSnapshot {
  const handoff = view.handoff;
  const context = handoff?.safeContext;
  if (!handoff || !context) {
    throw new ConflictException(
      "Automatic quote does not require an assisted request",
    );
  }
  const modelFileIds = context.modelFileIds;
  const itemSelections = context.itemSelections;
  if (!Array.isArray(modelFileIds) || !Array.isArray(itemSelections)) {
    throw new Error("Automatic quote handoff context is invalid");
  }
  return {
    reasons: [...handoff.reasons],
    modelFileIds: modelFileIds.map((value) =>
      normalizedUuid(value, "modelFileId"),
    ),
    itemSelections: itemSelections.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Automatic quote handoff item is invalid");
      }
      const item = value as JsonRecord;
      if (
        typeof item.ordinal !== "number" ||
        !Number.isSafeInteger(item.ordinal) ||
        typeof item.material !== "string" ||
        typeof item.quantity !== "number" ||
        !Number.isSafeInteger(item.quantity) ||
        typeof item.fitSensitive !== "boolean" ||
        !Array.isArray(item.bodyIds) ||
        item.bodyIds.some((bodyId) => typeof bodyId !== "string")
      ) {
        throw new Error("Automatic quote handoff item is invalid");
      }
      return {
        ordinal: item.ordinal,
        modelFileId: normalizedUuid(item.modelFileId, "modelFileId"),
        bodyIds: [...item.bodyIds] as string[],
        material: item.material,
        quantity: item.quantity,
        fitSensitive: item.fitSensitive,
      };
    }),
  };
}

function automaticQuoteClientSubject(
  capabilityKey: string,
  clientAddress: string,
): string {
  return createHmac("sha256", capabilityKey)
    .update(
      `anonymous-automatic-quote\0${normalizeClientAddress(clientAddress)}`,
    )
    .digest("hex");
}

function normalizeClientAddress(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized || "unknown";
}

function geometryFitsCapability(
  geometry: {
    boundsXMicrometers: bigint;
    boundsYMicrometers: bigint;
    boundsZMicrometers: bigint;
  },
  capability: {
    buildVolumeXMicrometers: bigint;
    buildVolumeYMicrometers: bigint;
    buildVolumeZMicrometers: bigint;
  },
): boolean {
  const compare = (left: bigint, right: bigint) =>
    left < right ? -1 : left > right ? 1 : 0;
  const bounds = [
    geometry.boundsXMicrometers,
    geometry.boundsYMicrometers,
    geometry.boundsZMicrometers,
  ].sort(compare);
  const buildVolume = [
    capability.buildVolumeXMicrometers,
    capability.buildVolumeYMicrometers,
    capability.buildVolumeZMicrometers,
  ].sort(compare);
  return bounds.every((bound, index) => bound <= buildVolume[index]!);
}

function quoteCapabilityKeyRing(): {
  all: readonly QuoteCapabilityKey[];
  byId: ReadonlyMap<string, QuoteCapabilityKey>;
} {
  const currentKey = process.env.TAVEN_QUOTE_CAPABILITY_KEY;
  if (!currentKey || currentKey.length < 32) {
    throw new Error(
      "TAVEN_QUOTE_CAPABILITY_KEY must contain at least 32 characters",
    );
  }
  const previousKeys = previousQuoteCapabilityKeys();
  const keys = [currentKey, ...previousKeys].map((key) => {
    if (key.length < 32) {
      throw new Error(
        "Every TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS entry must contain at least 32 characters",
      );
    }
    return { id: quoteCapabilityKeyId(key), key } satisfies QuoteCapabilityKey;
  });
  return { all: keys, byId: new Map(keys.map((key) => [key.id, key])) };
}

function previousQuoteCapabilityKeys(): string[] {
  const serialized = process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS;
  if (!serialized) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(
      "TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS must be a JSON array of strings",
    );
  }
  if (!Array.isArray(parsed) || parsed.some((key) => typeof key !== "string")) {
    throw new Error(
      "TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS must be a JSON array of strings",
    );
  }
  return parsed;
}

function quoteCapabilityKeyId(key: string): string {
  return createHash("sha256")
    .update("taven-quote-capability-key\0")
    .update(key)
    .digest("hex");
}

function bearerCapability(authorization?: string): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
  if (!match?.[1]) throw new UnauthorizedException("Capability is invalid");
  return match[1];
}

function bearerTokenValue(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value;
}

function matchesTokenHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function candidateUnusableDispositionKey(
  bindingId: string,
  frontierSha256: string,
): string {
  return `automatic-eligibility-unusable:v1:${bindingId}:${frontierSha256}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as JsonRecord)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedUuid(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function requireIdempotencyKey(value?: string): string {
  if (!value || value.trim().length < 8 || value.trim().length > 255) {
    throw new BadRequestException(
      "Idempotency-Key must contain between 8 and 255 characters",
    );
  }
  return value.trim();
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maximum
  ) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value.trim();
}

function optionalText(
  value: unknown,
  name: string,
  maximum: number,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, name, maximum);
}

function safeIdentifier(value: unknown, name: string): string {
  const text = requiredText(value, name, 128);
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(text)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return text;
}

function positiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 1 ||
    Number(value) > maximum
  ) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return Number(value);
}

function nonnegativeInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  if (typeof value === "string" && !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return number;
}

function jsonNullable(
  value: JsonRecord | null,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value ? (value as Prisma.InputJsonObject) : Prisma.JsonNull;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function selectedDestinationLabel(snapshot: unknown, fallback: string): string {
  const label = asRecord(snapshot)?.label;
  return typeof label === "string" && label.trim() ? label.trim() : fallback;
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000);
}

function safeNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ConflictException("Persisted money exceeds the API range");
  }
  return number;
}
