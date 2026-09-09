import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  IdempotencyStatus,
  InventoryStatus,
  MachineStatus,
  Material,
  Prisma,
  PrintQuality,
  ProductionArtifactFormat,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  operatorNode,
  requireOperatorPermission,
} from "../admin-access/operator-command";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { AuditService } from "../audit/audit.service";
import { canonicalJson, type CanonicalJson } from "./resource-identity";
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceValidationError,
} from "./resource-errors";
import {
  ResourceCatalogService,
  type CreateInventoryInput,
  type CreateMachineCalibrationInput,
  type CreateMachineProfileInput,
  type CreateReferenceProfileInput,
} from "./resource-catalog.service";
import type {
  CatalogCommandResultDto,
  CatalogReasonDto,
  CreateInventoryDto,
  CreateMachineCalibrationDto,
  CreateMachineProfileDto,
  CreateReferenceProfileDto,
  InventoryStatusDto,
  InventoryAdjustmentDto,
  MachineStatusDto,
} from "./operator-catalog.dto";

type Transaction = Prisma.TransactionClient;
type CatalogResult = CatalogCommandResultDto;
type IdempotencyPreparation<T> = { response: T } | { stageSnapshot: boolean };

const IDEMPOTENCY_DAYS = 30;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_PATTERN = /^(?:0|-?[1-9][0-9]*)$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MAX_INT32 = 2_147_483_647;
const MIN_INT32 = -2_147_483_648;

@Injectable()
export class OperatorCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ResourceCatalogService,
    private readonly audit: AuditService,
  ) {}

  async createReferenceProfile(
    operator: OperatorContext,
    body: CreateReferenceProfileDto,
    key?: string,
  ): Promise<CatalogResult> {
    const nodeId = this.globalNode(operator);
    const input = referenceProfileInput(body);
    return this.stagedCommand(
      operator,
      "catalog:reference-profile:create",
      key,
      { nodeId, input },
      () => this.catalog.provisionSettings(input.settings),
      async (tx, idempotencyKey) => {
        const profile = await this.catalog.createReferenceProfile(
          input,
          tx,
          true,
        );
        const result = { id: profile.id, state: profile.state };
        await this.record(tx, operator, nodeId, idempotencyKey, profile.id, {
          eventType: "catalog.reference-profile.created",
          payload: { operation: "create", revisionKind: "REFERENCE_PROFILE" },
        });
        return result;
      },
    );
  }

  async createMachineProfile(
    operator: OperatorContext,
    body: CreateMachineProfileDto,
    key?: string,
  ): Promise<CatalogResult> {
    const nodeId = this.globalNode(operator);
    const input = machineProfileInput(body);
    return this.stagedCommand(
      operator,
      "catalog:machine-profile:create",
      key,
      { nodeId, input },
      () => this.catalog.provisionSettings(input.settings),
      async (tx, idempotencyKey) => {
        const profile = await this.catalog.createMachineProfile(
          input,
          tx,
          true,
        );
        const result = { id: profile.id, state: profile.state };
        await this.record(tx, operator, nodeId, idempotencyKey, profile.id, {
          eventType: "catalog.machine-profile.created",
          payload: { operation: "create", revisionKind: "MACHINE_PROFILE" },
        });
        return result;
      },
    );
  }

  activateReferenceProfile(
    operator: OperatorContext,
    id: string,
    body: CatalogReasonDto,
    key?: string,
  ): Promise<CatalogResult> {
    return this.transitionGlobalRevision(
      operator,
      id,
      body,
      key,
      "reference-profile",
      "activate",
    );
  }

  retireReferenceProfile(
    operator: OperatorContext,
    id: string,
    body: CatalogReasonDto,
    key?: string,
  ): Promise<CatalogResult> {
    return this.transitionGlobalRevision(
      operator,
      id,
      body,
      key,
      "reference-profile",
      "retire",
    );
  }

  activateMachineProfile(
    operator: OperatorContext,
    id: string,
    body: CatalogReasonDto,
    key?: string,
  ): Promise<CatalogResult> {
    return this.transitionGlobalRevision(
      operator,
      id,
      body,
      key,
      "machine-profile",
      "activate",
    );
  }

  retireMachineProfile(
    operator: OperatorContext,
    id: string,
    body: CatalogReasonDto,
    key?: string,
  ): Promise<CatalogResult> {
    return this.transitionGlobalRevision(
      operator,
      id,
      body,
      key,
      "machine-profile",
      "retire",
    );
  }

  async createMachineCalibration(
    operator: OperatorContext,
    nodeId: string,
    body: CreateMachineCalibrationDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    const input = calibrationInput(nodeId, body);
    return this.stagedCommand(
      operator,
      `cat:n:${nodeId}:c:create`,
      key,
      { nodeId, input },
      () => this.catalog.provisionSettings(input.settings),
      async (tx, idempotencyKey) => {
        const calibration = await this.catalog.createMachineCalibration(
          input,
          tx,
          true,
        );
        const result = { id: calibration.id, state: calibration.state };
        await this.record(
          tx,
          operator,
          nodeId,
          idempotencyKey,
          calibration.id,
          {
            eventType: "catalog.machine-calibration.created",
            payload: { operation: "create", machineId: input.machineId },
          },
        );
        return result;
      },
    );
  }

  activateMachineCalibration(
    operator: OperatorContext,
    nodeId: string,
    id: string,
    body: CatalogReasonDto,
    key?: string,
  ): Promise<CatalogResult> {
    return this.transitionCalibration(
      operator,
      nodeId,
      id,
      body,
      key,
      "activate",
    );
  }

  retireMachineCalibration(
    operator: OperatorContext,
    nodeId: string,
    id: string,
    body: CatalogReasonDto,
    key?: string,
  ): Promise<CatalogResult> {
    return this.transitionCalibration(
      operator,
      nodeId,
      id,
      body,
      key,
      "retire",
    );
  }

  async createInventory(
    operator: OperatorContext,
    nodeId: string,
    body: CreateInventoryDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    const input = inventoryInput(nodeId, body);
    return this.command(
      operator,
      `cat:n:${nodeId}:i:create`,
      key,
      inventoryCommandInput(input),
      async (tx, idempotencyKey) => {
        const inventory = await this.catalog.createInventory(input, tx);
        const result = { id: inventory.id, status: inventory.status };
        await this.record(tx, operator, nodeId, idempotencyKey, inventory.id, {
          eventType: "catalog.inventory.created",
          payload: { operation: "create", machineId: input.machineId },
        });
        return result;
      },
    );
  }

  async updateMachineStatus(
    operator: OperatorContext,
    nodeId: string,
    machineId: string,
    body: MachineStatusDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    machineId = uuid(machineId, "machineId");
    body = commandBody(body);
    const status = enumValue(body.status, MachineStatus, "status");
    const reason = reasonText(body);
    return this.command(
      operator,
      `cat:n:${nodeId}:m:${machineId}:s`,
      key,
      { nodeId, machineId, status, reason },
      async (tx, idempotencyKey) => {
        const machine = await this.catalog.updateMachineStatus(
          nodeId,
          machineId,
          status,
          tx,
        );
        const result = { id: machine.id, status: machine.status };
        await this.record(tx, operator, nodeId, idempotencyKey, machine.id, {
          eventType: "catalog.machine.status-changed",
          reason,
          reasonCode: "MACHINE_STATUS_CHANGE",
          payload: { operation: "status", status },
        });
        return result;
      },
    );
  }

  async updateInventoryStatus(
    operator: OperatorContext,
    nodeId: string,
    inventoryId: string,
    body: InventoryStatusDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    inventoryId = uuid(inventoryId, "inventoryId");
    body = commandBody(body);
    const status = enumValue(body.status, InventoryStatus, "status");
    const reason = reasonText(body);
    return this.command(
      operator,
      `cat:n:${nodeId}:i:${inventoryId}:s`,
      key,
      { nodeId, inventoryId, status, reason },
      async (tx, idempotencyKey) => {
        const inventory = await this.catalog.updateInventoryStatus(
          nodeId,
          inventoryId,
          status,
          tx,
        );
        const result = { id: inventory.id, status: inventory.status };
        await this.record(tx, operator, nodeId, idempotencyKey, inventory.id, {
          eventType: "catalog.inventory.status-changed",
          reason,
          reasonCode: "INVENTORY_STATUS_CHANGE",
          payload: { operation: "status", status },
        });
        return result;
      },
    );
  }

  async adjustInventory(
    operator: OperatorContext,
    nodeId: string,
    inventoryId: string,
    body: InventoryAdjustmentDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    inventoryId = uuid(inventoryId, "inventoryId");
    body = commandBody(body);
    const deltaMilligrams = integer(body.deltaMilligrams, "deltaMilligrams");
    if (deltaMilligrams === 0n)
      throw new BadRequestException("deltaMilligrams must not be zero");
    const reason = reasonText(body);
    return this.command(
      operator,
      `cat:n:${nodeId}:i:${inventoryId}:a`,
      key,
      {
        nodeId,
        inventoryId,
        deltaMilligrams: deltaMilligrams.toString(),
        reason,
      },
      async (tx, idempotencyKey) => {
        const inventory = await this.catalog.adjustInventoryRemaining(
          nodeId,
          inventoryId,
          deltaMilligrams,
          tx,
        );
        const result = { id: inventory.id, status: inventory.status };
        await this.record(tx, operator, nodeId, idempotencyKey, inventory.id, {
          eventType: "catalog.inventory.adjusted",
          reason,
          reasonCode: "INVENTORY_ADJUSTMENT",
          payload: {
            operation: "adjustment",
            deltaMilligrams: deltaMilligrams.toString(),
          },
        });
        return result;
      },
    );
  }

  private async transitionGlobalRevision(
    operator: OperatorContext,
    id: string,
    body: CatalogReasonDto,
    key: string | undefined,
    kind: "reference-profile" | "machine-profile",
    action: "activate" | "retire",
  ): Promise<CatalogResult> {
    const nodeId = this.globalNode(operator);
    id = uuid(id, "id");
    const reason = reasonText(body);
    return this.stagedCommand(
      operator,
      `catalog:${kind}:${id}:${action}`,
      key,
      { nodeId, id, action, reason },
      action === "activate"
        ? () => this.provisionGlobalRevision(kind, id)
        : undefined,
      async (tx, idempotencyKey) => {
        const revision =
          kind === "reference-profile"
            ? action === "activate"
              ? await this.catalog.activateReferenceProfile(id, tx)
              : await this.catalog.retireReferenceProfile(id, tx)
            : action === "activate"
              ? await this.catalog.activateMachineProfile(id, tx)
              : await this.catalog.retireMachineProfile(id, tx);
        const state = (revision as { state: string }).state;
        const result = { id, state };
        await this.record(tx, operator, nodeId, idempotencyKey, id, {
          eventType: `catalog.${kind}.${action}d`,
          reason,
          reasonCode: "CATALOG_REVISION_LIFECYCLE",
          payload: { operation: action, revisionKind: kind },
        });
        return result;
      },
    );
  }

  private async transitionCalibration(
    operator: OperatorContext,
    nodeId: string,
    id: string,
    body: CatalogReasonDto,
    key: string | undefined,
    action: "activate" | "retire",
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    id = uuid(id, "id");
    const reason = reasonText(body);
    return this.stagedCommand(
      operator,
      `cat:n:${nodeId}:c:${id}:${action === "activate" ? "a" : "r"}`,
      key,
      { nodeId, id, action, reason },
      action === "activate"
        ? () => this.provisionCalibration(nodeId, id)
        : undefined,
      async (tx, idempotencyKey) => {
        const scopedCalibration = await tx.machineCalibration.findFirst({
          where: { id, nodeId },
          select: { id: true },
        });
        if (!scopedCalibration) {
          throw new ResourceNotFoundError(
            "calibration was not found in the node",
          );
        }
        const calibration =
          action === "activate"
            ? await this.catalog.activateMachineCalibration(id, tx)
            : await this.catalog.retireMachineCalibration(id, tx);
        const state = (calibration as { state: string }).state;
        const result = { id, state };
        await this.record(tx, operator, nodeId, idempotencyKey, id, {
          eventType: `catalog.machine-calibration.${action}d`,
          reason,
          reasonCode: "CATALOG_REVISION_LIFECYCLE",
          payload: { operation: action, revisionKind: "machine-calibration" },
        });
        return result;
      },
    );
  }

  private globalNode(operator: OperatorContext): string {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.CATALOG_WRITE);
    return uuid(operatorNode(operator), "operator node");
  }

  private node(operator: OperatorContext, nodeId: string): string {
    const normalizedNodeId = uuid(nodeId, "nodeId");
    if (this.globalNode(operator) !== normalizedNodeId) {
      throw new NotFoundException("Node was not found");
    }
    return normalizedNodeId;
  }

  private async provisionGlobalRevision(
    kind: "reference-profile" | "machine-profile",
    id: string,
  ): Promise<void> {
    const revision =
      kind === "reference-profile"
        ? await this.prisma.referenceProfile.findUnique({
            where: { id },
            select: { settings: true },
          })
        : await this.prisma.machineProfile.findUnique({
            where: { id },
            select: { settings: true },
          });
    if (!revision) {
      throw new NotFoundException("Catalog revision was not found");
    }
    await this.catalog.provisionSettings(revision.settings);
  }

  private async provisionCalibration(
    nodeId: string,
    id: string,
  ): Promise<void> {
    const calibration = await this.prisma.machineCalibration.findFirst({
      where: { id, nodeId },
      select: { settings: true },
    });
    if (!calibration) {
      throw new NotFoundException("Calibration was not found");
    }
    await this.catalog.provisionSettings(calibration.settings);
  }

  private async stagedCommand<T extends CatalogResult>(
    operator: OperatorContext,
    namespace: string,
    key: string | undefined,
    input: unknown,
    stage: (() => Promise<unknown>) | undefined,
    execute: (tx: Transaction, idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    const preparation = await this.prepareIdempotency<T>(
      operator,
      namespace,
      key,
      input,
    );
    if ("response" in preparation) return preparation.response;
    if (preparation.stageSnapshot && stage) await stage();
    return this.command(operator, namespace, key, input, execute);
  }

  private async prepareIdempotency<T extends CatalogResult>(
    operator: OperatorContext,
    namespace: string,
    key: string | undefined,
    input: unknown,
  ): Promise<IdempotencyPreparation<T>> {
    namespace = operatorCommandNamespace(namespace, operator);
    const idempotencyKey = requiredKey(key);
    const fingerprint = fingerprintFor(input);
    const { existing, now } = await this.prisma.$transaction(async (tx) => {
      const now = await databaseNow(tx);
      const existing = await tx.idempotencyRecord.findFirst({
        where: { namespace, idempotencyKey },
        orderBy: { generation: "desc" },
      });
      return { existing, now };
    });
    if (!existing || existing.expiresAt <= now) {
      return { stageSnapshot: true };
    }
    if (existing.requestFingerprint !== fingerprint) {
      throw new ConflictException(
        "Idempotency key was already used with different input",
      );
    }
    if (
      existing.status === IdempotencyStatus.COMPLETED &&
      existing.responseBody
    ) {
      return { response: existing.responseBody as unknown as T };
    }
    return { stageSnapshot: false };
  }

  private async command<T extends CatalogResult>(
    operator: OperatorContext,
    namespace: string,
    key: string | undefined,
    input: unknown,
    execute: (tx: Transaction, idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    namespace = operatorCommandNamespace(namespace, operator);
    const idempotencyKey = requiredKey(key);
    const fingerprint = fingerprintFor(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${idempotencyKey}`}, 0))::text`;
        const now = await databaseNow(tx);
        const existing = await tx.idempotencyRecord.findFirst({
          where: { namespace, idempotencyKey },
          orderBy: { generation: "desc" },
        });
        if (existing && existing.expiresAt > now) {
          if (existing.requestFingerprint !== fingerprint) {
            throw new ConflictException(
              "Idempotency key was already used with different input",
            );
          }
          if (
            existing.status !== IdempotencyStatus.COMPLETED ||
            !existing.responseBody
          ) {
            throw new ConflictException("Idempotent command is incomplete");
          }
          return existing.responseBody as unknown as T;
        }
        const record = await tx.idempotencyRecord.create({
          data: {
            namespace,
            idempotencyKey,
            generation: (existing?.generation ?? 0) + 1,
            requestFingerprint: fingerprint,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_DAYS * 86_400_000),
          },
        });
        const result = await execute(tx, idempotencyKey);
        await tx.idempotencyRecord.update({
          where: { id: record.id },
          data: {
            status: IdempotencyStatus.COMPLETED,
            responseStatusCode: 200,
            responseBody: result as unknown as Prisma.InputJsonObject,
          },
        });
        return result;
      });
    } catch (error) {
      return catalogError(error);
    }
  }

  private record(
    tx: Transaction,
    operator: OperatorContext,
    nodeId: string,
    idempotencyKey: string,
    correlationId: string,
    input: Readonly<{
      eventType: string;
      reason?: string;
      reasonCode?: string;
      payload: Prisma.InputJsonObject;
    }>,
  ) {
    return this.audit.recordOperator(tx, operator, {
      ...input,
      nodeId,
      correlationId,
      idempotencyKey,
    });
  }
}

function operatorCommandNamespace(
  namespace: string,
  operator: OperatorContext,
): string {
  const operatorFingerprint = createHash("sha256")
    .update(operator.operatorId)
    .digest("hex")
    .slice(0, 12);
  return `${namespace.replace("catalog:", "cat:")}:o:${operatorFingerprint}`;
}

function referenceProfileInput(
  body: CreateReferenceProfileDto,
): CreateReferenceProfileInput {
  body = commandBody(body);
  return {
    material: enumValue(body.material, Material, "material"),
    quality: enumValue(body.quality, PrintQuality, "quality"),
    slicerEngine: text(body.slicerEngine, "slicerEngine", 100),
    slicerVersion: text(body.slicerVersion, "slicerVersion", 100),
    settings: settings(body.settings),
  };
}

function machineProfileInput(
  body: CreateMachineProfileDto,
): CreateMachineProfileInput {
  return {
    ...referenceProfileInput(body),
    machineCapabilityId: uuid(body.machineCapabilityId, "machineCapabilityId"),
    referenceProfileId: uuid(body.referenceProfileId, "referenceProfileId"),
    nozzleDiameterMicrometers: positiveInteger(
      body.nozzleDiameterMicrometers,
      "nozzleDiameterMicrometers",
    ),
    productionArtifactFormat: enumValue(
      body.productionArtifactFormat,
      ProductionArtifactFormat,
      "productionArtifactFormat",
    ),
  };
}

function calibrationInput(
  nodeId: string,
  body: CreateMachineCalibrationDto,
): CreateMachineCalibrationInput {
  body = commandBody(body);
  return {
    nodeId,
    machineId: uuid(body.machineId, "machineId"),
    flowRatioPartsPerMillion: positiveInteger(
      body.flowRatioPartsPerMillion,
      "flowRatioPartsPerMillion",
    ),
    xyCompensationMicrometers: integerNumber(
      body.xyCompensationMicrometers,
      "xyCompensationMicrometers",
    ),
    elephantFootCompensationMicrometers: integerNumber(
      body.elephantFootCompensationMicrometers,
      "elephantFootCompensationMicrometers",
    ),
    settings: settings(body.settings),
  };
}

function inventoryInput(
  nodeId: string,
  body: CreateInventoryDto,
): CreateInventoryInput {
  body = commandBody(body);
  return {
    nodeId,
    machineId: uuid(body.machineId, "machineId"),
    sku: text(body.sku, "sku", 100),
    material: enumValue(body.material, Material, "material"),
    vendor: text(body.vendor, "vendor", 200),
    color: optionalText(body.color, "color", 100) ?? null,
    lotCode: optionalText(body.lotCode, "lotCode", 100) ?? null,
    priceMinorUnitsNumerator: integer(
      body.priceMinorUnitsNumerator,
      "priceMinorUnitsNumerator",
    ),
    priceMinorUnitsDenominator: integer(
      body.priceMinorUnitsDenominator,
      "priceMinorUnitsDenominator",
    ),
    currency: currency(body.currency),
    remainingMilligrams: integer(
      body.remainingMilligrams,
      "remainingMilligrams",
    ),
  };
}

function inventoryCommandInput(input: CreateInventoryInput): CanonicalJson {
  return {
    nodeId: input.nodeId,
    machineId: input.machineId,
    sku: input.sku,
    material: input.material,
    vendor: input.vendor,
    color: input.color ?? null,
    lotCode: input.lotCode ?? null,
    priceMinorUnitsNumerator: input.priceMinorUnitsNumerator.toString(),
    priceMinorUnitsDenominator: input.priceMinorUnitsDenominator.toString(),
    currency: input.currency,
    remainingMilligrams: input.remainingMilligrams.toString(),
  };
}

function fingerprintFor(input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalInput(input)))
    .digest("hex");
}

function canonicalInput(value: unknown): CanonicalJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new BadRequestException("idempotency input must be finite JSON");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, canonicalInput(entry)]),
    );
  }
  throw new BadRequestException("idempotency input must be JSON");
}

function settings(value: unknown): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BadRequestException("settings must be an object");
  }
  try {
    canonicalJson(value as CanonicalJson);
  } catch (error) {
    if (error instanceof ResourceValidationError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
  return value as Prisma.InputJsonObject;
}

function enumValue<T extends Record<string, string>>(
  value: unknown,
  values: T,
  name: string,
): T[keyof T] {
  if (typeof value !== "string" || !Object.values(values).includes(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return value as T[keyof T];
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be a UUID`);
  }
  return value.toLowerCase();
}

function text(value: unknown, name: string, maxLength?: number): string {
  if (typeof value !== "string") {
    throw new BadRequestException(`${name} must not be blank`);
  }
  const normalized = value.trim();
  if (Array.from(normalized).length === 0) {
    throw new BadRequestException(`${name} must not be blank`);
  }
  if (maxLength !== undefined && Array.from(normalized).length > maxLength) {
    throw new BadRequestException(`${name} is too long`);
  }
  return normalized;
}

function currency(value: unknown): string {
  const normalized = text(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new BadRequestException("currency is invalid");
  }
  return normalized;
}

function optionalText(
  value: unknown,
  name: string,
  maxLength?: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return text(value, name, maxLength);
}

function positiveInteger(value: unknown, name: string): number {
  const number = integerNumber(value, name);
  if (number < 1) throw new BadRequestException(`${name} must be positive`);
  return number;
}

function integerNumber(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_INT32 ||
    value > MAX_INT32
  ) {
    throw new BadRequestException(`${name} must be an integer`);
  }
  return value;
}

function integer(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !INTEGER_PATTERN.test(value)) {
    throw new BadRequestException(`${name} must be an integer string`);
  }
  const parsed = BigInt(value);
  if (parsed < MIN_INT64 || parsed > MAX_INT64) {
    throw new BadRequestException(`${name} is outside the supported range`);
  }
  return parsed;
}

function commandBody<T extends object>(body: T | null | undefined): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("request body must be an object");
  }
  return body;
}

function reasonText(body: CatalogReasonDto): string {
  body = commandBody(body);
  const reason = text(body.reason, "reason");
  if (reason.length > 1_000)
    throw new BadRequestException("reason is too long");
  return reason;
}

function requiredKey(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 8 ||
    value.trim().length > 255
  ) {
    throw new BadRequestException(
      "Idempotency-Key must contain between 8 and 255 characters",
    );
  }
  return value.trim();
}

async function databaseNow(tx: Pick<Transaction, "$queryRaw">): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  const now = rows[0]?.now;
  if (!now) throw new Error("database clock is unavailable");
  return now;
}

function catalogError(error: unknown): never {
  if (
    error instanceof BadRequestException ||
    error instanceof ConflictException ||
    error instanceof NotFoundException
  ) {
    throw error;
  }
  if (error instanceof ResourceValidationError) {
    throw new BadRequestException(error.message);
  }
  if (error instanceof ResourceNotFoundError) {
    throw new NotFoundException("Catalog resource was not found");
  }
  if (error instanceof ResourceConflictError) {
    throw new ConflictException(error.message);
  }
  throw error;
}
