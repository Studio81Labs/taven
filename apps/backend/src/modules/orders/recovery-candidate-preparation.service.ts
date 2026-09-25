import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ClaimOrigin,
  ClaimSlotResolutionStatus,
  ClaimStatus,
  IdempotencyStatus,
  JobStatus,
  OrderStatus,
  Prisma,
  type RecoveryCandidatePreparation,
  RecoveryCandidatePreparationKind,
  ReplacementRequestStatus,
  ShipmentStatus,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  assertOperationalOrderScope,
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { AuditService } from "../audit/audit.service";
import { databaseNow } from "../legal-approvals/legal-approvals.service";
import {
  CandidateEstimateService,
  type CandidateEstimateDispatch,
} from "../resources/candidate-estimate.service";
import {
  FrozenOrderCandidateInputService,
  type FrozenCandidateInput,
  type FrozenCandidateItem,
  type FrozenCandidateSource,
} from "../resources/frozen-order-candidate-input.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
} from "../resources/resource-errors";
import { SlicerProfileSnapshotUnavailableError } from "../slicing/slicer-profile-snapshot.service";
import type {
  PrepareClaimReprintDto,
  PrepareJobReplacementDto,
  RecoveryCandidatePreparationAcceptedDto,
  RecoveryCandidatePreparationDetailDto,
  RecoveryCandidatePreparationPageDto,
  RecoveryCandidateChoicePageDto,
  RecoveryCandidateChoiceDto,
} from "./recovery-candidate.dto";

type Transaction = Prisma.TransactionClient;
type Kind = RecoveryCandidatePreparationKind;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DISPATCHES = 256;
const IMMUTABLE_REPLAY_EXPIRY = new Date("9999-12-31T00:00:00.000Z");

type Source = {
  jobId: string;
  nodeId: string;
  orderPhaseId: string;
  shipmentPlanId: string;
  item: FrozenCandidateItem;
  selection: FrozenCandidateSource;
  slotIds: string[];
  quantity: number;
  fingerprint: string;
  sourceCandidateId: string;
};

type Scope = {
  kind: Kind;
  targetId: string;
  nodeId: string;
  orderId: string;
  orderPhaseId: string;
  shipmentPlanId: string;
  sourceJobId: string | null;
  replacementRequestId: string | null;
  claimId: string | null;
  predecessorShipmentId: string | null;
  incidentEvidenceId: string | null;
  sources: Source[];
  fingerprint: string;
  expressRequested: boolean;
};

function validUuid(value: string, name: string): string {
  if (!UUID.test(value)) throw new BadRequestException(`${name} is invalid`);
  return value.toLowerCase();
}

function requiredReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason || reason.length > 1000)
    throw new BadRequestException("reason is invalid");
  return reason;
}

function requiredKey(value?: string): string {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 255)
    throw new BadRequestException("Idempotency-Key is invalid");
  return key;
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pageLimit(value?: string): number {
  if (value === undefined) return 50;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 100)
    throw new BadRequestException("limit must be an integer from 1 to 100");
  return Number(value);
}

function cursorValue(value: string | undefined, filter: string): string | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      decoded &&
      typeof decoded === "object" &&
      "filter" in decoded &&
      "id" in decoded &&
      decoded.filter === filter &&
      typeof decoded.id === "string" &&
      UUID.test(decoded.id)
    )
      return decoded.id;
  } catch {
    /* malformed cursor */
  }
  throw new BadRequestException("cursor is invalid for this recovery scope");
}

function nextCursor(id: string, filter: string): string {
  return Buffer.from(JSON.stringify({ id, filter }), "utf8").toString(
    "base64url",
  );
}

@Injectable()
export class RecoveryCandidatePreparationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: CandidateEstimateService,
    private readonly frozenInputs: FrozenOrderCandidateInputService,
    private readonly audit: AuditService,
  ) {}

  prepareReplacement(
    operator: OperatorContext,
    orderId: string,
    jobId: string,
    body: PrepareJobReplacementDto,
    key?: string,
  ): Promise<RecoveryCandidatePreparationAcceptedDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_WRITE);
    return this.prepare(
      operator,
      validUuid(orderId, "orderId"),
      RecoveryCandidatePreparationKind.JOB_REPLACEMENT,
      validUuid(jobId, "jobId"),
      validUuid(
        body.expectedReplacementRequestId,
        "expectedReplacementRequestId",
      ),
      requiredReason(body.reason),
      requiredKey(key),
    );
  }

  prepareReprint(
    operator: OperatorContext,
    orderId: string,
    claimId: string,
    body: PrepareClaimReprintDto,
    key?: string,
  ): Promise<RecoveryCandidatePreparationAcceptedDto> {
    requireOperatorPermission(
      operator,
      OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION,
    );
    return this.prepare(
      operator,
      validUuid(orderId, "orderId"),
      RecoveryCandidatePreparationKind.LOST_CLAIM_REPRINT,
      validUuid(claimId, "claimId"),
      validUuid(
        body.expectedPredecessorShipmentId,
        "expectedPredecessorShipmentId",
      ),
      requiredReason(body.reason),
      requiredKey(key),
    );
  }

  private async prepare(
    operator: OperatorContext,
    orderId: string,
    kind: Kind,
    targetId: string,
    expectedId: string,
    reason: string,
    key: string,
  ): Promise<RecoveryCandidatePreparationAcceptedDto> {
    const nodeId = operatorNode(operator);
    const namespace = `recovery:${orderId}:${sha({ kind, targetId }).slice(0, 24)}`;
    const fingerprint = sha({ kind, orderId, targetId, expectedId, reason });
    const replay = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))::text`;
      await assertOperationalOrderScope(tx, orderId, nodeId);
      await this.assertTargetScope(tx, orderId, kind, targetId);
      const previous = await tx.idempotencyRecord.findFirst({
        where: { namespace, idempotencyKey: key },
        orderBy: { generation: "desc" },
      });
      if (!previous) return null;
      if (previous.requestFingerprint !== fingerprint)
        throw new ConflictException(
          "Idempotency key belongs to another recovery preparation",
        );
      if (
        previous.status !== IdempotencyStatus.COMPLETED ||
        !previous.responseBody
      )
        throw new ConflictException("Recovery preparation is incomplete");
      return previous.responseBody as unknown as RecoveryCandidatePreparationAcceptedDto;
    });
    if (replay) return replay;

    const scope = await this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, nodeId);
      return this.resolveScope(tx, orderId, kind, targetId, expectedId, nodeId);
    });
    const preparationId = randomUUID();
    const observedAt = await databaseNow(this.prisma);
    const dispatches: Array<{
      source: Source;
      option: FrozenCandidateInput;
      prepared: CandidateEstimateDispatch;
    }> = [];
    const contracts = await import("@taven/slicer-contracts");
    for (const source of scope.sources) {
      const options = await this.frozenInputs.enumerate({
        item: source.item,
        source: source.selection,
        shipmentPlanId: source.shipmentPlanId,
        quantity: source.quantity,
        nodeId,
        expressRequested: scope.expressRequested,
        observedAt,
        arrangementScope: `recovery:${preparationId}:${source.jobId}`,
      });
      if (dispatches.length + options.length > MAX_DISPATCHES)
        throw new ConflictException("RECOVERY_PREPARATION_LIMIT");
      for (const option of options) {
        const inputFingerprintSha256 = contracts.slicingInputFingerprint(
          "candidate_estimate",
          option.input,
        );
        const dispatchJobId = randomUUID();
        const job = contracts.CandidateEstimateJobSchema.parse({
          contractVersion: 2,
          kind: "candidate_estimate",
          jobId: dispatchJobId,
          correlationId: preparationId,
          inputFingerprintSha256,
          idempotencyKey: `slicer:v2:candidate_estimate:${dispatchJobId}:${inputFingerprintSha256}`,
          attempt: 1,
          input: option.input,
        });
        try {
          dispatches.push({
            source,
            option,
            prepared: await this.candidates.prepareDispatch({
              nodeId,
              inventoryId: option.inventoryId,
              job,
            }),
          });
        } catch (error) {
          if (error instanceof ResourceNotFoundError)
            throw new ConflictException("RECOVERY_RESOURCE_CHANGED");
          if (error instanceof SlicerProfileSnapshotUnavailableError)
            throw new ServiceUnavailableException(
              "RECOVERY_SNAPSHOT_UNAVAILABLE",
            );
          throw error;
        }
      }
    }

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))::text`;
        for (const dispatchKey of dispatches
          .map(({ prepared }) => prepared.job.idempotencyKey)
          .sort()) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${dispatchKey}, 0))::text`;
        }
        for (const objectKey of [
          ...new Set(
            dispatches.flatMap(({ prepared }) =>
              prepared.job.input.occupancySliceTargets.map(
                ({ analysisObjectKey }) => analysisObjectKey,
              ),
            ),
          ),
        ].sort()) {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${objectKey}, 1))::text`;
        }
        await assertOperationalOrderScope(tx, orderId, nodeId);
        await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`;
        const prior = await tx.idempotencyRecord.findFirst({
          where: { namespace, idempotencyKey: key },
          orderBy: { generation: "desc" },
        });
        const now = await databaseNow(tx);
        if (prior) {
          if (prior.requestFingerprint !== fingerprint)
            throw new ConflictException(
              "Idempotency key belongs to another recovery preparation",
            );
          if (
            prior.status !== IdempotencyStatus.COMPLETED ||
            !prior.responseBody
          )
            throw new ConflictException("Recovery preparation is incomplete");
          return prior.responseBody as unknown as RecoveryCandidatePreparationAcceptedDto;
        }
        const current = await this.resolveScope(
          tx,
          orderId,
          kind,
          targetId,
          expectedId,
          nodeId,
        );
        if (current.fingerprint !== scope.fingerprint)
          throw new ConflictException(
            "Recovery context changed during preparation",
          );
        const latest = await tx.recoveryCandidatePreparation.findFirst({
          where: { kind, targetId },
          orderBy: { generation: "desc" },
        });
        if (
          latest &&
          latest.sourceScopeFingerprint === current.fingerprint &&
          latest.replacementRequestId === current.replacementRequestId &&
          latest.predecessorShipmentId === current.predecessorShipmentId
        ) {
          const mappingIds = (
            await tx.recoveryCandidateDispatch.findMany({
              where: { preparationId: latest.id },
              select: { outboxMessageId: true },
            })
          ).map(({ outboxMessageId }) => outboxMessageId);
          const terminalIds = new Set(
            (
              await tx.candidateEstimateTerminalResult.findMany({
                where: { outboxMessageId: { in: mappingIds } },
                select: { outboxMessageId: true },
              })
            ).map(({ outboxMessageId }) => outboxMessageId),
          );
          const deadLetterIds = new Set(
            (
              await tx.outboxMessage.findMany({
                where: {
                  aggregateType: "SlicingDispatchDeadLetter",
                  aggregateId: { in: mappingIds },
                },
                select: { aggregateId: true },
              })
            ).map(({ aggregateId }) => aggregateId),
          );
          const pending = mappingIds.some(
            (id) => !terminalIds.has(id) && !deadLetterIds.has(id),
          );
          if (
            pending &&
            now.getTime() < latest.requestedAt.getTime() + 30 * 60_000
          )
            throw new ConflictException("PREPARATION_IN_PROGRESS");
        }
        await this.lockAndCheckResources(tx, dispatches, current);
        const generation = (latest?.generation ?? 0) + 1;
        const acknowledgement: RecoveryCandidatePreparationAcceptedDto = {
          preparationId,
          kind,
          orderId,
          targetId,
          generation,
          requestedAt: now.toISOString(),
          statusPath: `/admin/orders/${orderId}/fulfilment/${kind === RecoveryCandidatePreparationKind.JOB_REPLACEMENT ? `jobs/${targetId}/replacement-preparations` : `claims/${targetId}/reprint-preparations`}/${preparationId}`,
        };
        const record = await tx.idempotencyRecord.create({
          data: {
            namespace,
            idempotencyKey: key,
            generation: 1,
            requestFingerprint: fingerprint,
            expiresAt: IMMUTABLE_REPLAY_EXPIRY,
          },
        });
        await tx.recoveryCandidatePreparation.create({
          data: {
            id: preparationId,
            nodeId,
            orderId,
            orderPhaseId: scope.orderPhaseId,
            shipmentPlanId: scope.shipmentPlanId,
            kind,
            targetId,
            sourceJobId: scope.sourceJobId,
            replacementRequestId: scope.replacementRequestId,
            claimId: scope.claimId,
            predecessorShipmentId: scope.predecessorShipmentId,
            incidentEvidenceId: scope.incidentEvidenceId,
            generation,
            sourceJobIds: scope.sources.map(({ jobId }) => jobId),
            sourceScopeFingerprint: scope.fingerprint,
            requestedAt: now,
            operatorId: operator.operatorId,
            operatorSessionId: operator.sessionId,
            idempotencyRecordId: record.id,
            reason,
          },
        });
        for (const { source, prepared } of dispatches) {
          let staged: Awaited<
            ReturnType<CandidateEstimateService["stageDispatch"]>
          >;
          try {
            staged = await this.candidates.stageDispatch(tx, prepared);
          } catch (error) {
            if (
              error instanceof ResourceNotFoundError ||
              error instanceof ResourceConflictError
            )
              throw new ConflictException("RECOVERY_RESOURCE_CHANGED");
            throw error;
          }
          await tx.recoveryCandidateDispatch.create({
            data: {
              preparationId,
              nodeId,
              orderId,
              orderPhaseId: scope.orderPhaseId,
              shipmentPlanId: scope.shipmentPlanId,
              sourceJobId: source.jobId,
              sourceFingerprint: source.fingerprint,
              dispatchJobId: staged.job.jobId,
              outboxMessageId: staged.outboxMessageId,
            },
          });
        }
        await this.audit.recordOperator(tx, operator, {
          eventType: "recovery.candidate_preparation_requested",
          orderId,
          nodeId,
          correlationId: record.id,
          idempotencyKey: key,
          reasonCode: "RECOVERY_CANDIDATE_PREPARATION",
          reason,
          payload: {
            kind,
            targetId,
            preparationId,
            generation,
            sourceJobIds: scope.sources.map(({ jobId }) => jobId),
            dispatchCount: dispatches.length,
          },
        });
        await tx.idempotencyRecord.update({
          where: { id: record.id },
          data: {
            status: IdempotencyStatus.COMPLETED,
            responseStatusCode: 202,
            responseBody: acknowledgement as unknown as Prisma.InputJsonObject,
          },
        });
        return acknowledgement;
      },
      { timeout: 60_000 },
    );
  }

  private async lockAndCheckResources(
    tx: Transaction,
    dispatches: Array<{
      source: Source;
      option: FrozenCandidateInput;
    }>,
    scope: Scope,
  ): Promise<void> {
    const resources = dispatches.map(({ option }) => ({
      profileId: option.input.machineProfile.revisionId,
      machineId: option.input.machineId,
      calibrationId: option.input.machineCalibration.revisionId,
      inventoryId: option.inventoryId,
    }));
    const lockSets = [
      { table: "machine_profiles", ids: resources.map((row) => row.profileId) },
      { table: "machines", ids: resources.map((row) => row.machineId) },
      {
        table: "machine_calibrations",
        ids: resources.map((row) => row.calibrationId),
      },
      { table: "inventories", ids: resources.map((row) => row.inventoryId) },
    ];
    for (const { table, ids } of lockSets) {
      for (const id of [...new Set(ids)].sort()) {
        // Table names are fixed locally; values remain bound parameters.
        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`,
          id,
        );
        if (!rows[0]) throw new ConflictException("RECOVERY_RESOURCE_CHANGED");
      }
    }
    for (const { source, option } of dispatches) {
      const valid = await tx.$queryRaw<Array<{ eligible: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM machine_profiles profile
          JOIN machines machine ON machine.id = ${option.input.machineId}::uuid
            AND machine.node_id = ${scope.nodeId}::uuid
            AND machine.machine_capability_id = profile.machine_capability_id
            AND machine.installed_nozzle_micrometers = profile.nozzle_diameter_micrometers
            AND machine.status = 'ACTIVE'
          JOIN nodes node ON node.id = machine.node_id AND node.active
          JOIN machine_calibrations calibration
            ON calibration.id = ${option.input.machineCalibration.revisionId}::uuid
            AND calibration.machine_id = machine.id AND calibration.node_id = machine.node_id
            AND calibration.state = 'ACTIVE'
          JOIN inventories inventory ON inventory.id = ${option.inventoryId}::uuid
            AND inventory.machine_id = machine.id AND inventory.node_id = machine.node_id
            AND inventory.status = 'AVAILABLE'
            AND inventory.material::text = ${source.item.material}::text
            AND (${source.item.color}::text IS NULL OR inventory.color = ${source.item.color}::text)
            AND inventory.remaining_milligrams - inventory.reserved_milligrams > 0
            AND (${scope.expressRequested}::boolean = false OR inventory.mount_status = 'MOUNTED')
          JOIN machine_availability_selections availability
            ON availability.machine_id = machine.id AND availability.node_id = machine.node_id
            AND availability.revision_id = ${option.availabilityRevisionId}::uuid
            AND availability.selection_version = ${option.availabilitySelectionVersion}::integer
          JOIN machine_availability_revisions revision ON revision.id = availability.revision_id
            AND revision.reason <> 'LEGACY_LIVE_RESERVATION_BOOTSTRAP'
          WHERE profile.id = ${option.input.machineProfile.revisionId}::uuid
            AND profile.state = 'ACTIVE' AND profile.material = inventory.material
            AND EXISTS (SELECT 1 FROM inventory_receipts receipt
              WHERE receipt.inventory_id = inventory.id AND receipt.node_id = inventory.node_id
                AND receipt.kind = 'INITIAL')
            AND EXISTS (SELECT 1 FROM machine_availability_windows available_window
              WHERE available_window.revision_id = availability.revision_id
                AND available_window.ends_at > clock_timestamp())
        ) AS eligible
      `;
      if (!valid[0]?.eligible)
        throw new ConflictException("RECOVERY_RESOURCE_CHANGED");
    }
  }

  async list(
    operator: OperatorContext,
    orderId: string,
    kind: Kind,
    targetId: string,
    query: { limit?: string; cursor?: string },
  ): Promise<RecoveryCandidatePreparationPageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    validUuid(orderId, "orderId");
    validUuid(targetId, "targetId");
    const limit = pageLimit(query.limit);
    const filter = sha({ orderId, kind, targetId });
    const after = cursorValue(query.cursor, filter);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, operatorNode(operator));
      await this.assertTargetScope(tx, orderId, kind, targetId);
      const anchor = after
        ? await tx.recoveryCandidatePreparation.findFirst({
            where: { id: after, orderId, kind, targetId },
          })
        : null;
      if (after && !anchor) throw new BadRequestException("cursor is stale");
      const rows = await tx.recoveryCandidatePreparation.findMany({
        where: {
          orderId,
          nodeId: operatorNode(operator),
          kind,
          targetId,
          ...(anchor
            ? {
                OR: [
                  { requestedAt: { lt: anchor.requestedAt } },
                  { requestedAt: anchor.requestedAt, id: { lt: anchor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      return {
        items: await Promise.all(page.map((row) => this.project(tx, row))),
        ...(rows.length > limit
          ? { nextCursor: nextCursor(page.at(-1)!.id, filter) }
          : {}),
      };
    });
  }

  async detail(
    operator: OperatorContext,
    orderId: string,
    kind: Kind,
    targetId: string,
    preparationId: string,
  ): Promise<RecoveryCandidatePreparationDetailDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    validUuid(orderId, "orderId");
    validUuid(targetId, "targetId");
    validUuid(preparationId, "preparationId");
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, operatorNode(operator));
      await this.assertTargetScope(tx, orderId, kind, targetId);
      const row = await tx.recoveryCandidatePreparation.findFirst({
        where: {
          id: preparationId,
          nodeId: operatorNode(operator),
          orderId,
          kind,
          targetId,
        },
      });
      if (!row)
        throw new NotFoundException("Recovery preparation was not found");
      return this.project(tx, row);
    });
  }

  async choices(
    operator: OperatorContext,
    orderId: string,
    kind: Kind,
    targetId: string,
    preparationId: string,
    query: { sourceJobId?: string; limit?: string; cursor?: string },
  ): Promise<RecoveryCandidateChoicePageDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.OPERATIONS_READ);
    validUuid(orderId, "orderId");
    validUuid(targetId, "targetId");
    validUuid(preparationId, "preparationId");
    if (query.sourceJobId) validUuid(query.sourceJobId, "sourceJobId");
    const limit = pageLimit(query.limit);
    const filter = sha({
      orderId,
      kind,
      targetId,
      preparationId,
      sourceJobId: query.sourceJobId ?? null,
    });
    const after = cursorValue(query.cursor, filter);
    return this.prisma.$transaction(async (tx) => {
      await assertOperationalOrderScope(tx, orderId, operatorNode(operator));
      await this.assertTargetScope(tx, orderId, kind, targetId);
      const row = await tx.recoveryCandidatePreparation.findFirst({
        where: {
          id: preparationId,
          nodeId: operatorNode(operator),
          orderId,
          kind,
          targetId,
        },
      });
      if (!row)
        throw new NotFoundException("Recovery preparation was not found");
      if (query.sourceJobId && !row.sourceJobIds.includes(query.sourceJobId))
        throw new NotFoundException("Source Job is not in this preparation");
      const mappings = await tx.recoveryCandidateDispatch.findMany({
        where: {
          preparationId,
          ...(query.sourceJobId ? { sourceJobId: query.sourceJobId } : {}),
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        take: limit + 1,
      });
      const page = mappings.slice(0, limit);
      const now = await databaseNow(tx);
      const current = await tx.recoveryCandidatePreparation.findFirst({
        where: { kind, targetId },
        orderBy: { generation: "desc" },
        select: { id: true },
      });
      const contextValid = await this.contextMatches(tx, row);
      const items = (
        await Promise.all(
          page.map((mapping) =>
            this.choiceForDispatch(
              tx,
              mapping.outboxMessageId,
              mapping.sourceJobId,
              current?.id === preparationId,
              contextValid,
              now,
            ),
          ),
        )
      ).filter((item): item is RecoveryCandidateChoiceDto => item !== null);
      return {
        items,
        ...(mappings.length > limit
          ? { nextCursor: nextCursor(page.at(-1)!.id, filter) }
          : {}),
      };
    });
  }

  private async choiceForDispatch(
    tx: Transaction,
    outboxMessageId: string,
    sourceJobId: string,
    latest: boolean,
    contextValid: boolean,
    now: Date,
  ): Promise<RecoveryCandidateChoiceDto | null> {
    const terminal = await tx.candidateEstimateTerminalResult.findUnique({
      where: { outboxMessageId },
    });
    if (
      terminal?.outcome !== "SUCCEEDED" ||
      !terminal.candidateResourceEstimateId
    )
      return null;
    const candidate = await tx.candidateResourceEstimate.findUnique({
      where: { id: terminal.candidateResourceEstimateId },
      include: {
        capacityIntervals: { orderBy: { intervalIndex: "asc" } },
        inventory: true,
      },
    });
    if (!candidate) return null;
    const currentResources = await tx.$queryRaw<Array<{ eligible: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM candidate_resource_estimates estimate
        JOIN shipment_plans plan ON plan.id = estimate.shipment_plan_id
        JOIN order_price_bindings binding ON binding.id = plan.order_price_binding_id
        JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
        JOIN inventories inventory ON inventory.id = estimate.inventory_id
          AND inventory.node_id = estimate.node_id
          AND inventory.machine_id = estimate.machine_id
          AND inventory.status = 'AVAILABLE'
          AND inventory.remaining_milligrams - inventory.reserved_milligrams
            >= estimate.required_material_milligrams
        JOIN machine_availability_selections availability
          ON availability.machine_id = estimate.machine_id
          AND availability.node_id = estimate.node_id
          AND availability.revision_id = estimate.machine_availability_revision_id
          AND availability.selection_version = estimate.machine_availability_selection_version
        JOIN machine_availability_revisions availability_revision
          ON availability_revision.id = availability.revision_id
          AND availability_revision.reason <> 'LEGACY_LIVE_RESERVATION_BOOTSTRAP'
        JOIN machines machine ON machine.id = estimate.machine_id
          AND machine.node_id = estimate.node_id AND machine.status = 'ACTIVE'
        JOIN nodes node ON node.id = estimate.node_id AND node.active
        JOIN machine_profiles profile ON profile.id = estimate.machine_profile_id
          AND profile.machine_capability_id = machine.machine_capability_id
          AND profile.nozzle_diameter_micrometers = machine.installed_nozzle_micrometers
          AND profile.material = inventory.material AND profile.state = 'ACTIVE'
        JOIN machine_calibrations calibration
          ON calibration.id = estimate.machine_calibration_id
          AND calibration.node_id = estimate.node_id
          AND calibration.machine_id = estimate.machine_id
          AND calibration.state = 'ACTIVE'
        JOIN print_config_revisions config ON config.id = estimate.print_config_revision_id
          AND config.quality = profile.quality
        JOIN model_geometries geometry ON geometry.id = estimate.model_geometry_id
          AND geometry.deleted_at IS NULL
        JOIN model_files source ON source.id = geometry.source_model_file_id
          AND source.deleted_at IS NULL
        WHERE estimate.id = ${candidate.id}::uuid
          AND EXISTS (
            SELECT 1 FROM recovery_candidate_dispatches dispatch
            JOIN jobs source_job ON source_job.id = dispatch.source_job_id
            JOIN phase_resource_plan_slots source_slot
              ON source_slot.phase_resource_plan_job_id = source_job.phase_resource_plan_job_id
            JOIN fulfilment_slots slot ON slot.id = source_slot.fulfilment_slot_id
            JOIN order_items item ON item.id = slot.order_item_id
            WHERE dispatch.outbox_message_id = ${outboxMessageId}::uuid
              AND item.material = inventory.material
              AND (item.color IS NULL OR item.color = inventory.color)
          )
          AND EXISTS (
            SELECT 1 FROM inventory_receipts receipt
            WHERE receipt.inventory_id = inventory.id
              AND receipt.node_id = inventory.node_id AND receipt.kind = 'INITIAL'
          )
          AND (snapshot.input_snapshot #>> '{automaticQuote,expressRequested}'
            IS DISTINCT FROM 'true' OR inventory.mount_status = 'MOUNTED')
          AND (source.retention_hold <> 'NONE' OR source.source_delete_after >= (
            SELECT max(interval.ends_at) FROM candidate_capacity_intervals interval
            WHERE interval.candidate_resource_estimate_id = estimate.id))
          AND taven_geometry_fits_machine_capability(
            estimate.model_geometry_id, machine.machine_capability_id)
          AND NOT EXISTS (
            SELECT 1 FROM candidate_capacity_intervals interval
            WHERE interval.candidate_resource_estimate_id = estimate.id
              AND NOT EXISTS (
                SELECT 1 FROM machine_availability_windows available
                WHERE available.revision_id = availability.revision_id
                  AND available.starts_at <= interval.starts_at
                  AND available.ends_at >= interval.ends_at))
          AND NOT EXISTS (
            SELECT 1 FROM candidate_capacity_intervals interval
            JOIN capacity_reservations reserved
              ON reserved.machine_id = estimate.machine_id
              AND reserved.node_id = estimate.node_id
              AND reserved.status IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
              AND reserved.starts_at < interval.ends_at
              AND reserved.ends_at > interval.starts_at
            WHERE interval.candidate_resource_estimate_id = estimate.id)
      ) AS eligible
    `;
    const blockers = [
      ...(!latest ? ["PREPARATION_SUPERSEDED"] : []),
      ...(!contextValid ? ["RECOVERY_CONTEXT_CHANGED"] : []),
      ...(candidate.expiresAt.getTime() <= now.getTime() + 15 * 60_000
        ? ["CANDIDATE_EXPIRED"]
        : []),
      ...(candidate.capacityIntervals.length === 0 ||
      candidate.capacityIntervals.some(
        ({ startsAt, endsAt }) => startsAt <= now || endsAt <= startsAt,
      )
        ? ["SCHEDULE_STALE"]
        : []),
      ...(candidate.inventory.status !== "AVAILABLE"
        ? ["INVENTORY_UNAVAILABLE"]
        : []),
      ...(!currentResources[0]?.eligible ? ["RESOURCE_CHANGED"] : []),
    ];
    return {
      candidateResourceEstimateId: candidate.id,
      sourceJobId,
      machineId: candidate.machineId,
      machineProfileId: candidate.machineProfileId,
      machineCalibrationId: candidate.machineCalibrationId,
      inventoryId: candidate.inventoryId,
      printConfigRevisionId: candidate.printConfigRevisionId,
      material: candidate.inventory.material,
      color: candidate.inventory.color,
      quantity: candidate.quantity,
      partsPerPlate: candidate.partsPerPlate,
      requiredMaterialMilligrams:
        candidate.requiredMaterialMilligrams.toString(),
      requiredMachineSeconds: candidate.requiredMachineSeconds.toString(),
      intervals: candidate.capacityIntervals.map(({ startsAt, endsAt }) => ({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
      })),
      calculatedAt: candidate.calculatedAt.toISOString(),
      expiresAt: candidate.expiresAt.toISOString(),
      selectable: blockers.length === 0,
      blockingCodes: blockers,
    };
  }

  private async project(
    tx: Transaction,
    row: RecoveryCandidatePreparation,
  ): Promise<RecoveryCandidatePreparationDetailDto> {
    const now = await databaseNow(tx);
    const expired = now.getTime() >= row.requestedAt.getTime() + 30 * 60_000;
    const latest = await tx.recoveryCandidatePreparation.findFirst({
      where: { kind: row.kind, targetId: row.targetId },
      orderBy: { generation: "desc" },
      select: { id: true },
    });
    const mappings = await tx.recoveryCandidateDispatch.findMany({
      where: { preparationId: row.id },
    });
    const terminals = await tx.candidateEstimateTerminalResult.findMany({
      where: {
        outboxMessageId: {
          in: mappings.map(({ outboxMessageId }) => outboxMessageId),
        },
      },
    });
    const byOutbox = new Map(
      terminals.map((terminal) => [terminal.outboxMessageId, terminal]),
    );
    const contextValid = await this.contextMatches(tx, row);
    const deadLetterIds = new Set(
      (
        await tx.outboxMessage.findMany({
          where: {
            aggregateType: "SlicingDispatchDeadLetter",
            aggregateId: {
              in: mappings.map(({ outboxMessageId }) => outboxMessageId),
            },
          },
          select: { aggregateId: true },
        })
      ).map(({ aggregateId }) => aggregateId),
    );
    const sourceRows = await Promise.all(
      row.sourceJobIds.map(async (sourceJobId) => {
        const slots = await tx.phaseResourcePlanSlot.findMany({
          where: {
            phaseResourcePlanJob: { jobs: { some: { id: sourceJobId } } },
          },
          select: { fulfilmentSlotId: true },
          orderBy: { fulfilmentSlotId: "asc" },
        });
        const sourceDispatches = mappings.filter(
          (mapping) => mapping.sourceJobId === sourceJobId,
        );
        const pendingCount = sourceDispatches.filter(
          (mapping) =>
            !byOutbox.has(mapping.outboxMessageId) &&
            !deadLetterIds.has(mapping.outboxMessageId),
        ).length;
        const failedCount = sourceDispatches.filter(
          (mapping) =>
            byOutbox.get(mapping.outboxMessageId)?.outcome === "FAILED" ||
            deadLetterIds.has(mapping.outboxMessageId),
        ).length;
        const successful = sourceDispatches.filter(
          (mapping) =>
            byOutbox.get(mapping.outboxMessageId)?.outcome === "SUCCEEDED",
        );
        const selectable = await Promise.all(
          successful.map((mapping) =>
            this.choiceForDispatch(
              tx,
              mapping.outboxMessageId,
              sourceJobId,
              latest?.id === row.id,
              contextValid,
              now,
            ),
          ),
        );
        const selectableCount = selectable.filter(
          (choice) => choice?.selectable,
        ).length;
        return {
          sourceJobId,
          fulfilmentSlotIds: slots.map(
            ({ fulfilmentSlotId }) => fulfilmentSlotId,
          ),
          quantity: slots.length,
          pendingCount,
          failedCount,
          selectableCount,
          blockingCodes: selectableCount
            ? []
            : pendingCount
              ? [expired ? "PREPARATION_EXPIRED" : "PREPARING"]
              : ["NO_ELIGIBLE_CANDIDATE"],
        };
      }),
    );
    const pendingCount = sourceRows.reduce(
      (sum, source) => sum + source.pendingCount,
      0,
    );
    const failedCount = sourceRows.reduce(
      (sum, source) => sum + source.failedCount,
      0,
    );
    const blockers = [
      ...(latest?.id !== row.id ? ["PREPARATION_SUPERSEDED"] : []),
      ...(!contextValid ? ["RECOVERY_CONTEXT_CHANGED"] : []),
      ...(expired && pendingCount ? ["PREPARATION_EXPIRED"] : []),
      ...(!sourceRows.every(({ selectableCount }) => selectableCount > 0) &&
      !pendingCount
        ? ["INCOMPLETE_COVERAGE"]
        : []),
    ];
    const status =
      latest?.id !== row.id
        ? "SUPERSEDED"
        : !contextValid
          ? "BLOCKED"
          : sourceRows.every(({ selectableCount }) => selectableCount > 0)
            ? "CANDIDATES_AVAILABLE"
            : expired
              ? "EXPIRED"
              : pendingCount
                ? "PREPARING"
                : "BLOCKED";
    const accepted: RecoveryCandidatePreparationAcceptedDto = {
      preparationId: row.id,
      kind: row.kind,
      orderId: row.orderId,
      targetId: row.targetId,
      generation: row.generation,
      requestedAt: row.requestedAt.toISOString(),
      statusPath: `/admin/orders/${row.orderId}/fulfilment/${row.kind === RecoveryCandidatePreparationKind.JOB_REPLACEMENT ? `jobs/${row.targetId}/replacement-preparations` : `claims/${row.targetId}/reprint-preparations`}/${row.id}`,
    };
    return {
      ...accepted,
      replacementRequestId: row.replacementRequestId,
      claimId: row.claimId,
      predecessorShipmentId: row.predecessorShipmentId,
      incidentEvidenceId: row.incidentEvidenceId,
      sourceJobIds: row.sourceJobIds,
      status,
      sources: sourceRows,
      dispatchCount: mappings.length,
      pendingCount,
      failedCount,
      blockingCodes: blockers,
      nextRefreshAt:
        pendingCount && !expired
          ? new Date(row.requestedAt.getTime() + 30 * 60_000).toISOString()
          : null,
    };
  }

  private async contextMatches(
    tx: Transaction,
    row: RecoveryCandidatePreparation,
  ): Promise<boolean> {
    try {
      const current = await this.resolveScope(
        tx,
        row.orderId,
        row.kind,
        row.targetId,
        row.replacementRequestId ?? row.predecessorShipmentId!,
        row.nodeId,
      );
      return current.fingerprint === row.sourceScopeFingerprint;
    } catch (error) {
      if (error instanceof HttpException) return false;
      throw error;
    }
  }

  private async assertTargetScope(
    tx: Transaction,
    orderId: string,
    kind: Kind,
    targetId: string,
  ): Promise<void> {
    const exists =
      kind === RecoveryCandidatePreparationKind.JOB_REPLACEMENT
        ? await tx.job.findFirst({
            where: { id: targetId, orderId },
            select: { id: true },
          })
        : await tx.claim.findFirst({
            where: { id: targetId, orderId },
            select: { id: true },
          });
    if (!exists) throw new NotFoundException("Recovery target was not found");
  }

  private async resolveScope(
    tx: Transaction,
    orderId: string,
    kind: Kind,
    targetId: string,
    expectedId: string,
    nodeId: string,
  ): Promise<Scope> {
    let sourceJobIds: string[];
    let predecessorShipmentId: string | null = null;
    let incidentEvidenceId: string | null = null;
    let replacementRequestId: string | null = null;
    let claimId: string | null = null;
    let expectedClaimSlotIds: string[] | null = null;
    if (kind === RecoveryCandidatePreparationKind.JOB_REPLACEMENT) {
      const job = await tx.job.findFirst({
        where: {
          id: targetId,
          orderId,
          nodeId,
          status: { in: [JobStatus.FAILED, JobStatus.QC_REJECTED] },
          replacementJob: null,
        },
        include: { replacementRequestSource: true },
      });
      if (!job)
        throw new ConflictException(
          "Job is not an eligible failed replacement source",
        );
      const request = job.replacementRequestSource;
      if (
        !request ||
        request.id !== expectedId ||
        request.status !== ReplacementRequestStatus.OPEN ||
        request.deadlineAt <= (await databaseNow(tx))
      )
        throw new ConflictException("Replacement request is stale or closed");
      replacementRequestId = request.id;
      sourceJobIds = [job.id];
    } else {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      const claim = await tx.claim.findFirst({
        where: { id: targetId, orderId },
        include: {
          incidentShipment: true,
          resolutions: {
            include: { replacementShipment: true },
            orderBy: { fulfilmentSlotId: "asc" },
          },
        },
      });
      if (
        !claim ||
        !order ||
        order.status !== OrderStatus.SHIPPED ||
        claim.origin !== ClaimOrigin.SHIPMENT_INCIDENT ||
        ![ClaimStatus.OPEN, ClaimStatus.ACTIVE].includes(
          claim.status as typeof ClaimStatus.OPEN | typeof ClaimStatus.ACTIVE,
        )
      )
        throw new ConflictException(
          "Claim is not an eligible shipped parcel incident",
        );
      const retrying = claim.status === ClaimStatus.ACTIVE;
      const predecessor = retrying
        ? claim.resolutions[0]?.replacementShipment
        : claim.incidentShipment;
      const priorReplacementIds = new Set(
        claim.resolutions.flatMap(({ replacementShipmentId }) =>
          replacementShipmentId ? [replacementShipmentId] : [],
        ),
      );
      const authorization = predecessor
        ? await tx.reshipmentAuthorization.findUnique({
            where: { reshipmentShipmentId: predecessor.id },
          })
        : null;
      if (
        !predecessor ||
        predecessor.id !== expectedId ||
        predecessor.status !== ShipmentStatus.LOST ||
        (retrying &&
          (priorReplacementIds.size !== 1 ||
            (predecessor.reprintClaimId !== claim.id &&
              authorization?.claimId !== claim.id)))
      )
        throw new ConflictException("LOST predecessor is stale or unsupported");
      const planSlotIds = (
        await tx.shipmentPlanFulfilmentSlot.findMany({
          where: { shipmentPlanId: predecessor.shipmentPlanId },
          select: { fulfilmentSlotId: true },
          orderBy: { fulfilmentSlotId: "asc" },
        })
      ).map(({ fulfilmentSlotId }) => fulfilmentSlotId);
      const claimSlotIds = claim.resolutions.map(
        ({ fulfilmentSlotId }) => fulfilmentSlotId,
      );
      const financialWork =
        (await tx.refundTransaction.count({ where: { claimId: claim.id } })) +
        (await tx.priceAdjustment.count({ where: { claimId: claim.id } }));
      if (
        !planSlotIds.length ||
        planSlotIds.length !== claimSlotIds.length ||
        planSlotIds.some((id, index) => id !== claimSlotIds[index]) ||
        financialWork ||
        (await tx.shipment.count({
          where: { replacesShipmentId: predecessor.id },
        })) ||
        claim.resolutions.some(
          ({
            status,
            replacementRequestId: requestId,
            replacementShipmentId,
          }) =>
            status !== ClaimSlotResolutionStatus.PENDING ||
            (!retrying &&
              (requestId !== null || replacementShipmentId !== null)) ||
            (retrying &&
              (replacementShipmentId !== predecessor.id ||
                (predecessor.reprintClaimId === claim.id &&
                  requestId === null) ||
                (authorization?.claimId === claim.id && requestId !== null))),
        )
      )
        throw new ConflictException(
          "Claim does not cover the whole unresolved LOST parcel",
        );
      if (
        (await tx.fulfilmentSlot.count({
          where: { id: { in: planSlotIds }, orderId, outcome: "PENDING" },
        })) !== planSlotIds.length
      )
        throw new ConflictException("Claim slots are no longer pending");
      const jobs = await tx.job.findMany({
        where: {
          orderId,
          nodeId,
          orderPhaseId: predecessor.orderPhaseId,
          shipmentPlanId: predecessor.shipmentPlanId,
          replacementJob: null,
        },
        include: { shipmentAssignment: true },
        orderBy: { id: "asc" },
      });
      const lineage = new Set<string>();
      let lineageAt: string | null = predecessor.id;
      while (lineageAt) {
        if (lineage.has(lineageAt))
          throw new ConflictException("Shipment lineage is cyclic");
        lineage.add(lineageAt);
        const row: { replacesShipmentId: string | null } | null =
          await tx.shipment.findUnique({
            where: { id: lineageAt },
            select: { replacesShipmentId: true },
          });
        lineageAt = row?.replacesShipmentId ?? null;
      }
      if (
        !jobs.length ||
        jobs.some(
          ({ status, shipmentAssignment }) =>
            ![JobStatus.HANDED_OVER, JobStatus.SETTLED].includes(
              status as typeof JobStatus.HANDED_OVER | typeof JobStatus.SETTLED,
            ) ||
            !shipmentAssignment ||
            !lineage.has(shipmentAssignment.shipmentId),
        )
      )
        throw new ConflictException("Original parcel Jobs are unavailable");
      sourceJobIds = jobs.map(({ id }) => id);
      expectedClaimSlotIds = planSlotIds;
      const evidence = await tx.shipmentProviderEvent.findFirst({
        where: { shipmentId: predecessor.id, kind: "LOST" },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        select: { id: true },
      });
      if (!evidence)
        throw new ConflictException(
          "LOST predecessor has no final incident evidence",
        );
      predecessorShipmentId = predecessor.id;
      incidentEvidenceId = evidence.id;
      claimId = claim.id;
    }
    const sources = await Promise.all(
      sourceJobIds.map((id) => this.sourceForJob(tx, orderId, id, nodeId)),
    );
    if (expectedClaimSlotIds) {
      const actual = sources.flatMap(({ slotIds }) => slotIds).sort();
      if (
        actual.length !== expectedClaimSlotIds.length ||
        actual.some((id, index) => id !== expectedClaimSlotIds[index])
      )
        throw new ConflictException(
          "Recovery Jobs do not form the exact parcel slot partition",
        );
    }
    const phaseIds = new Set(sources.map(({ orderPhaseId }) => orderPhaseId));
    const planIds = new Set(
      sources.map(({ shipmentPlanId }) => shipmentPlanId),
    );
    if (phaseIds.size !== 1 || planIds.size !== 1)
      throw new ConflictException(
        "Recovery source Jobs span incompatible plans",
      );
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: {
        acceptedPriceBinding: {
          include: { priceSnapshot: { select: { inputSnapshot: true } } },
        },
      },
    });
    if (!order) throw new NotFoundException("Order was not found");
    if (!order.acceptedPriceBinding)
      throw new ConflictException(
        "Accepted recovery price binding is unavailable",
      );
    const acceptedInput =
      order.acceptedPriceBinding?.priceSnapshot.inputSnapshot;
    const automatic =
      acceptedInput &&
      typeof acceptedInput === "object" &&
      !Array.isArray(acceptedInput) &&
      "automaticQuote" in acceptedInput
        ? acceptedInput.automaticQuote
        : null;
    const expressRequested =
      automatic &&
      typeof automatic === "object" &&
      !Array.isArray(automatic) &&
      "expressRequested" in automatic &&
      automatic.expressRequested === true;
    return {
      kind,
      targetId,
      nodeId,
      orderId,
      orderPhaseId: sources[0]!.orderPhaseId,
      shipmentPlanId: sources[0]!.shipmentPlanId,
      sourceJobId:
        kind === RecoveryCandidatePreparationKind.JOB_REPLACEMENT
          ? targetId
          : null,
      replacementRequestId,
      claimId,
      predecessorShipmentId,
      incidentEvidenceId,
      sources,
      fingerprint: sha({
        kind,
        targetId,
        replacementRequestId,
        predecessorShipmentId,
        incidentEvidenceId,
        sources: sources.map(({ jobId, fingerprint }) => ({
          jobId,
          fingerprint,
        })),
      }),
      expressRequested: Boolean(expressRequested),
    };
  }

  private async sourceForJob(
    tx: Transaction,
    orderId: string,
    jobId: string,
    nodeId: string,
  ): Promise<Source> {
    const job = await tx.job.findFirst({
      where: { id: jobId, orderId, nodeId },
      include: {
        phaseResourcePlanJob: {
          include: {
            candidateResourceEstimate: true,
            slots: {
              include: { fulfilmentSlot: true },
              orderBy: { fulfilmentSlotId: "asc" },
            },
          },
        },
      },
    });
    if (!job || !job.phaseResourcePlanJob.slots.length)
      throw new ConflictException(
        "Recovery source Job has no frozen slot partition",
      );
    const planJob = job.phaseResourcePlanJob;
    const candidate = planJob.candidateResourceEstimate;
    const itemIds = new Set(
      planJob.slots.map(({ fulfilmentSlot }) => fulfilmentSlot.orderItemId),
    );
    if (itemIds.size !== 1 || planJob.slots.length !== candidate.quantity)
      throw new ConflictException(
        "Recovery source Job has an unsupported slot partition",
      );
    const itemId = [...itemIds][0]!;
    const item = await tx.orderItem.findFirst({
      where: { id: itemId, orderId },
      include: {
        sourceModelFile: true,
        modelGeometry: true,
        printConfigRevision: true,
        primaryReferenceSliceResult: { select: { referenceProfileId: true } },
        individualSource: {
          include: { quoteItem: { include: { modelSelection: true } } },
        },
      },
    });
    if (
      !item ||
      item.modelGeometryId !== candidate.modelGeometryId ||
      item.printConfigRevisionId !== candidate.printConfigRevisionId ||
      item.sourceModelFile.deletedAt ||
      item.modelGeometry.deletedAt ||
      (item.sourceModelFile.retentionHold === "NONE" &&
        item.sourceModelFile.sourceDeleteAfter <= (await databaseNow(tx)))
    )
      throw new GoneException(
        "Trusted recovery source geometry is unavailable",
      );
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: { individualOrigin: { include: { quote: true } } },
    });
    if (!order) throw new NotFoundException("Order was not found");
    const originalReceipt = await tx.candidateEstimateTerminalResult.findUnique(
      {
        where: { candidateResourceEstimateId: candidate.id },
        include: { outboxMessage: true },
      },
    );
    const originalPayload = originalReceipt?.outboxMessage.payload as
      Record<string, unknown> | undefined;
    const { CandidateEstimateJobSchema } =
      await import("@taven/slicer-contracts");
    const originalJob =
      originalReceipt?.outcome === "SUCCEEDED"
        ? CandidateEstimateJobSchema.safeParse(originalPayload?.job)
        : null;
    const original = originalJob?.success ? originalJob.data.input : null;
    const originalGeometry = original?.geometry;
    if (
      !originalGeometry ||
      originalGeometry.sourceModelFileId !== item.sourceModelFileId ||
      originalGeometry.sourceContentSha256 !==
        item.sourceModelFile.contentHash ||
      originalGeometry.modelGeometryId !== item.modelGeometryId ||
      originalGeometry.geometrySha256 !== item.modelGeometry.geometryHash ||
      original?.printConfig.revisionId !== item.printConfigRevisionId ||
      originalPayload?.nodeId !== job.nodeId ||
      originalPayload?.inventoryId !== candidate.inventoryId ||
      original?.machineId !== candidate.machineId ||
      original?.machineProfile.revisionId !== candidate.machineProfileId ||
      original?.machineCalibration.revisionId !==
        candidate.machineCalibrationId ||
      original?.arrangementRevision.revisionId !==
        candidate.arrangementRevisionId ||
      original.partsPerPlate !== candidate.partsPerPlate ||
      original.quantity !== candidate.quantity ||
      original.shipmentPlanId !== job.shipmentPlanId
    )
      throw new ConflictException("Accepted source dispatch is unavailable");
    const quoteItem = item.individualSource?.quoteItem;
    const individual = order.individualOrigin;
    const selection = quoteItem?.modelSelection;
    const acceptedProfile = await tx.machineProfile.findUnique({
      where: { id: candidate.machineProfileId },
      select: { referenceProfileId: true },
    });
    if (!acceptedProfile)
      throw new ConflictException("Accepted source profile is unavailable");
    const referenceProfileId =
      item.primaryReferenceSliceResult?.referenceProfileId ??
      acceptedProfile.referenceProfileId;
    if (referenceProfileId !== acceptedProfile.referenceProfileId)
      throw new ConflictException("Accepted source profile has changed");
    let frozenSelection: FrozenCandidateSource | null = null;
    if (individual) {
      if (
        quoteItem?.quoteId === individual.quoteId &&
        selection &&
        selection.requestId === individual.quote.quoteRequestId &&
        selection.modelFileId === item.sourceModelFileId &&
        selection.modelGeometryId === item.modelGeometryId &&
        selection.sourceContentSha256 === item.sourceModelFile.contentHash &&
        quoteItem.printConfigRevisionId === item.printConfigRevisionId &&
        quoteItem.primaryReferenceSliceResultId ===
          item.primaryReferenceSliceResultId &&
        quoteItem.quantity === item.quantity
      ) {
        frozenSelection = {
          referenceProfileId,
          bodyIds: selection.bodyIds,
          selectionSha256: selection.selectionSha256,
        };
      }
    } else {
      frozenSelection = {
        referenceProfileId,
        bodyIds: originalGeometry.bodyIds,
        selectionSha256: originalGeometry.selectionSha256,
      };
    }
    if (
      frozenSelection &&
      (frozenSelection.selectionSha256 !== originalGeometry.selectionSha256 ||
        frozenSelection.bodyIds.length !== originalGeometry.bodyIds.length ||
        frozenSelection.bodyIds.some(
          (id, index) => id !== originalGeometry.bodyIds[index],
        ))
    )
      throw new ConflictException(
        "Accepted source selection does not match its dispatch",
      );
    if (!frozenSelection)
      throw new ConflictException(
        "Accepted source body selection is unavailable",
      );
    const slotIds = planJob.slots.map(
      ({ fulfilmentSlotId }) => fulfilmentSlotId,
    );
    const fingerprintRows = await tx.$queryRaw<
      Array<{ fingerprint: string | null }>
    >`
      SELECT taven_recovery_source_fingerprint(${jobId}::uuid) AS fingerprint
    `;
    const fingerprint = fingerprintRows[0]?.fingerprint;
    if (!fingerprint)
      throw new ConflictException("Recovery source fingerprint is unavailable");
    return {
      jobId,
      nodeId,
      orderPhaseId: job.orderPhaseId,
      shipmentPlanId: job.shipmentPlanId,
      item,
      selection: frozenSelection,
      slotIds,
      quantity: candidate.quantity,
      fingerprint,
      sourceCandidateId: candidate.id,
    };
  }
}
