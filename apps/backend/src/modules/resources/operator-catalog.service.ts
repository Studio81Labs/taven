import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  IdempotencyStatus,
  InventoryStatus,
  InventoryMountStatus,
  InventoryReceiptKind,
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
  ResourceSnapshotIntegrityError,
  ResourceSnapshotUnavailableError,
  ResourceValidationError,
} from "./resource-errors";
import {
  ResourceCatalogService,
  type CreateInventoryInput,
  type CreateMachineCapabilityInput,
  type CreateMachineCalibrationInput,
  type CreateMachineProfileInput,
  type CreatePrintConfigRevisionInput,
  type CreatePriceListInput,
  type CreateReferenceProfileInput,
  type RegisterMachineInput,
  type VerifiedCatalogSnapshot,
} from "./resource-catalog.service";
import {
  referenceProfileActivationNotice,
  type ReferenceProfileActivationNoticeDto,
  type ReferenceProfileActivationNoticeSource,
} from "./reference-profile-activation-notice.dto";
import type {
  CatalogCommandResultDto,
  CatalogReasonDto,
  ActivateCommercialPolicyDto,
  CommercialPolicyActivationResultDto,
  CreateInventoryDto,
  ReceiveInventoryDto,
  RecordInitialInventoryReceiptDto,
  CorrectInventoryReceiptDto,
  InventoryMountDto,
  ReplaceMachineAvailabilityDto,
  CreateMachineCapabilityDto,
  CreateMachineCalibrationDto,
  CreateMachineProfileDto,
  CreatePrintConfigRevisionDto,
  CreatePriceListDto,
  CreateReferenceProfileDto,
  InventoryStatusDto,
  InventoryAdjustmentDto,
  MachineStatusDto,
  RegisterMachineDto,
} from "./operator-catalog.dto";
import { validatePriceListParameters } from "./price-list-validation";
import { currentCommercialPolicy } from "./commercial-policy-selection";

type Transaction = Prisma.TransactionClient;
type CatalogResult = CatalogCommandResultDto;
type ReferenceProfileActivationResult = CatalogResult &
  Readonly<{ notice: ReferenceProfileActivationNoticeDto }>;
type IdempotencyPreparation<T> = { response: T } | { needsVerification: true };

const IDEMPOTENCY_DAYS = 30;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_PATTERN = /^(?:0|-?[1-9][0-9]*)$/;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MAX_INT32 = 2_147_483_647;
const MIN_INT32 = -2_147_483_648;
const JSON_MAXIMUM_DEPTH = 64;

@Injectable()
export class OperatorCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: ResourceCatalogService,
    private readonly audit: AuditService,
  ) {}

  async createMachineCapability(
    operator: OperatorContext,
    body: CreateMachineCapabilityDto,
    key?: string,
  ): Promise<CatalogResult> {
    const nodeId = this.globalNode(operator);
    const input = machineCapabilityInput(body);
    return this.command(
      operator,
      "catalog:machine-capability:create",
      key,
      {
        nodeId,
        ...input,
        buildVolumeXMicrometers: input.buildVolumeXMicrometers.toString(),
        buildVolumeYMicrometers: input.buildVolumeYMicrometers.toString(),
        buildVolumeZMicrometers: input.buildVolumeZMicrometers.toString(),
      },
      async (tx, idempotencyKey) => {
        const capability = await this.catalog.createMachineCapability(
          input,
          tx,
        );
        await this.record(tx, operator, nodeId, idempotencyKey, capability.id, {
          eventType: "catalog.machine-capability.created",
          payload: {
            operation: "create",
            capabilityKey: capability.capabilityKey,
          },
        });
        return { id: capability.id };
      },
    );
  }

  async registerMachine(
    operator: OperatorContext,
    nodeId: string,
    body: RegisterMachineDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    const input = registerMachineInput(nodeId, body);
    return this.command(
      operator,
      `cat:n:${nodeId}:m:create`,
      key,
      input,
      async (tx, idempotencyKey) => {
        const capability = await tx.machineCapability.findUnique({
          where: { id: input.machineCapabilityId },
          select: { supportedNozzleMicrometers: true },
        });
        if (!capability)
          throw new NotFoundException("Machine capability was not found");
        if (
          !capability.supportedNozzleMicrometers.includes(
            input.installedNozzleMicrometers,
          )
        ) {
          throw new BadRequestException(
            "Installed nozzle is not supported by capability",
          );
        }
        const machine = await this.catalog.registerMachine(input, tx);
        await this.record(tx, operator, nodeId, idempotencyKey, machine.id, {
          eventType: "catalog.machine.registered",
          payload: {
            operation: "register",
            capabilityId: input.machineCapabilityId,
          },
        });
        return { id: machine.id, status: machine.status };
      },
    );
  }

  async createPrintConfigRevision(
    operator: OperatorContext,
    body: CreatePrintConfigRevisionDto,
    key?: string,
  ): Promise<CatalogResult> {
    const nodeId = this.globalNode(operator);
    const input = printConfigRevisionInput(body);
    return this.command(
      operator,
      "catalog:print-config:create",
      key,
      { nodeId, input },
      async (tx, idempotencyKey) => {
        const revision = await this.catalog.createPrintConfigRevision(
          input,
          tx,
        );
        await this.record(tx, operator, nodeId, idempotencyKey, revision.id, {
          eventType: "catalog.print-config.created",
          payload: { operation: "create", revisionKind: "PRINT_CONFIG" },
        });
        return { id: revision.id };
      },
    );
  }

  async createPriceList(
    operator: OperatorContext,
    body: CreatePriceListDto,
    key?: string,
  ): Promise<CatalogResult> {
    const nodeId = this.globalNode(operator);
    const input = await priceListInput(body);
    return this.command(
      operator,
      "catalog:price-list:create",
      key,
      { nodeId, input },
      async (tx, idempotencyKey) => {
        const priceList = await this.catalog.createPriceList(input, tx);
        await this.record(tx, operator, nodeId, idempotencyKey, priceList.id, {
          eventType: "catalog.price-list.created",
          payload: {
            operation: "create",
            currency: input.currency,
            revision: input.revision,
          },
        });
        return { id: priceList.id };
      },
    );
  }

  async activateCommercialPolicy(
    operator: OperatorContext,
    priceListId: string,
    body: ActivateCommercialPolicyDto,
    key?: string,
  ): Promise<CommercialPolicyActivationResultDto> {
    const nodeId = this.globalNode(operator);
    priceListId = uuid(priceListId, "priceListId");
    const reason = reasonText(body);
    const expectedSelectionVersion = positiveInteger(
      body.expectedSelectionVersion,
      "expectedSelectionVersion",
    );
    if (expectedSelectionVersion >= MAX_INT32) {
      throw new BadRequestException("selection version is exhausted");
    }
    return this.command(
      operator,
      "catalog:commercial-policy:activate",
      key,
      { nodeId, priceListId, expectedSelectionVersion, reason },
      async (tx, idempotencyKey) => {
        const rows = await tx.$queryRaw<Array<{ currency: string }>>`
          SELECT "currency" FROM "commercial_policy_selections"
          WHERE "currency" = 'CZK' FOR UPDATE
        `;
        if (rows.length !== 1) {
          throw new ServiceUnavailableException(
            "Commercial policy selection is unavailable",
          );
        }
        const selection = await currentCommercialPolicy(tx);
        if (selection.selectionVersion !== expectedSelectionVersion) {
          throw new ConflictException("Commercial policy selection changed");
        }
        const target = await tx.priceList.findUnique({
          where: { id: priceListId },
        });
        if (!target) throw new NotFoundException("Price list was not found");
        if (target.currency !== selection.currency) {
          throw new BadRequestException("Price list currency does not match");
        }
        await validatePriceListParameters(
          target.parameters as Prisma.InputJsonObject,
        );
        const updated = await tx.commercialPolicySelection.update({
          where: { currency: selection.currency },
          data: {
            priceListId,
            selectionVersion: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        await this.record(tx, operator, nodeId, idempotencyKey, priceListId, {
          eventType: "catalog.commercial-policy.activated",
          reason,
          reasonCode: "COMMERCIAL_POLICY_ACTIVATION",
          payload: {
            operation: "activate",
            currency: updated.currency,
            previousPriceListId: selection.priceListId,
            priceListId,
            previousSelectionVersion: selection.selectionVersion,
            selectionVersion: updated.selectionVersion,
          },
        });
        return {
          id: priceListId,
          currency: updated.currency,
          priceListId,
          selectionVersion: updated.selectionVersion,
        };
      },
    );
  }

  async createReferenceProfile(
    operator: OperatorContext,
    body: CreateReferenceProfileDto,
    key?: string,
  ): Promise<CatalogResult> {
    const nodeId = this.globalNode(operator);
    const input = referenceProfileInput(body);
    return this.command(
      operator,
      "catalog:reference-profile:create",
      key,
      { nodeId, input },
      async (tx, idempotencyKey) => {
        const profile = await this.catalog.createReferenceProfile(input, tx);
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
    return this.command(
      operator,
      "catalog:machine-profile:create",
      key,
      { nodeId, input },
      async (tx, idempotencyKey) => {
        await this.requireMachineProfileCompatibility(input, tx);
        const profile = await this.catalog.createMachineProfile(input, tx);
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
  ): Promise<ReferenceProfileActivationResult> {
    return this.transitionGlobalRevision(
      operator,
      id,
      body,
      key,
      "reference-profile",
      "activate",
    ) as Promise<ReferenceProfileActivationResult>;
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
    return this.command(
      operator,
      `cat:n:${nodeId}:c:create`,
      key,
      { nodeId, input },
      async (tx, idempotencyKey) => {
        await this.requireMachineInNode(nodeId, input.machineId, tx);
        const calibration = await this.catalog.createMachineCalibration(
          input,
          tx,
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

  async receiveInventory(
    operator: OperatorContext,
    nodeId: string,
    body: ReceiveInventoryDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    const input = inventoryInput(nodeId, body);
    if (input.remainingMilligrams <= 0n) {
      throw new BadRequestException("received lot mass must be positive");
    }
    const purchasedAt = explicitInstant(body.purchasedAt, "purchasedAt");
    return this.command(
      operator,
      `cat:n:${nodeId}:i:receive`,
      key,
      {
        inventory: inventoryCommandInput(input),
        purchasedAt: purchasedAt.toISOString(),
      },
      async (tx, idempotencyKey) => {
        const inventory = await this.catalog.createInventory(input, tx);
        await tx.inventory.update({
          where: { id: inventory.id },
          data: { mountStatus: InventoryMountStatus.UNMOUNTED },
        });
        const receipt = await tx.inventoryReceipt.create({
          data: {
            nodeId,
            machineId: inventory.machineId,
            inventoryId: inventory.id,
            kind: InventoryReceiptKind.INITIAL,
            receivedMilligrams: inventory.remainingMilligrams,
            vendor: inventory.vendor,
            currency: inventory.currency,
            priceMinorUnitsNumerator: inventory.priceMinorUnitsNumerator,
            priceMinorUnitsDenominator: inventory.priceMinorUnitsDenominator,
            purchasedAt,
          },
        });
        await this.record(tx, operator, nodeId, idempotencyKey, inventory.id, {
          eventType: "catalog.inventory.received",
          payload: {
            operation: "receive",
            machineId: inventory.machineId,
            receiptId: receipt.id,
          },
        });
        return { id: inventory.id, status: inventory.status };
      },
    );
  }

  async recordInitialInventoryReceipt(
    operator: OperatorContext,
    nodeId: string,
    inventoryId: string,
    body: RecordInitialInventoryReceiptDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    inventoryId = uuid(inventoryId, "inventoryId");
    body = commandBody(body);
    const receivedMilligrams = integer(
      body.receivedMilligrams,
      "receivedMilligrams",
    );
    const priceMinorUnitsNumerator = integer(
      body.priceMinorUnitsNumerator,
      "priceMinorUnitsNumerator",
    );
    const priceMinorUnitsDenominator = integer(
      body.priceMinorUnitsDenominator,
      "priceMinorUnitsDenominator",
    );
    if (
      receivedMilligrams <= 0n ||
      priceMinorUnitsNumerator < 0n ||
      priceMinorUnitsDenominator <= 0n
    ) {
      throw new BadRequestException(
        "receipt mass and purchase rate are invalid",
      );
    }
    const vendor = text(body.vendor, "vendor", 200);
    const receiptCurrency = currency(body.currency);
    const purchasedAt = explicitInstant(body.purchasedAt, "purchasedAt");
    const reason = reasonText(body);
    return this.command(
      operator,
      `cat:n:${nodeId}:i:${inventoryId}:receipt-initial`,
      key,
      {
        nodeId,
        inventoryId,
        receivedMilligrams: receivedMilligrams.toString(),
        priceMinorUnitsNumerator: priceMinorUnitsNumerator.toString(),
        priceMinorUnitsDenominator: priceMinorUnitsDenominator.toString(),
        vendor,
        currency: receiptCurrency,
        purchasedAt: purchasedAt.toISOString(),
        reason,
      },
      async (tx, idempotencyKey) => {
        const rows = await tx.$queryRaw<
          Array<{ machine_id: string; remaining_milligrams: bigint }>
        >`
          SELECT machine_id, remaining_milligrams FROM inventories
          WHERE id = ${inventoryId}::uuid AND node_id = ${nodeId}::uuid FOR UPDATE
        `;
        const inventory = rows[0];
        if (!inventory) throw new NotFoundException("Inventory was not found");
        if (receivedMilligrams < inventory.remaining_milligrams) {
          throw new ConflictException(
            "Attested receipt mass is below current lot balance",
          );
        }
        const existing = await tx.inventoryReceipt.findFirst({
          where: { inventoryId, nodeId },
          select: { id: true },
        });
        if (existing)
          throw new ConflictException(
            "Inventory already has purchase evidence",
          );
        const receipt = await tx.inventoryReceipt.create({
          data: {
            nodeId,
            machineId: inventory.machine_id,
            inventoryId,
            kind: InventoryReceiptKind.INITIAL,
            receivedMilligrams,
            vendor,
            currency: receiptCurrency,
            priceMinorUnitsNumerator,
            priceMinorUnitsDenominator,
            purchasedAt,
          },
        });
        await tx.inventory.update({
          where: { id: inventoryId },
          data: {
            vendor,
            currency: receiptCurrency,
            priceMinorUnitsNumerator,
            priceMinorUnitsDenominator,
          },
        });
        await this.record(tx, operator, nodeId, idempotencyKey, inventoryId, {
          eventType: "catalog.inventory.receipt-recorded",
          reason,
          reasonCode: "INVENTORY_RECEIPT_ATTESTATION",
          payload: { operation: "receipt-initial", receiptId: receipt.id },
        });
        return { id: inventoryId, status: "RECORDED" };
      },
    );
  }

  async correctInventoryReceipt(
    operator: OperatorContext,
    nodeId: string,
    inventoryId: string,
    body: CorrectInventoryReceiptDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    inventoryId = uuid(inventoryId, "inventoryId");
    body = commandBody(body);
    const supersedesReceiptId = uuid(
      body.supersedesReceiptId,
      "supersedesReceiptId",
    );
    const receivedMilligrams = integer(
      body.receivedMilligrams,
      "receivedMilligrams",
    );
    const priceMinorUnitsNumerator = integer(
      body.priceMinorUnitsNumerator,
      "priceMinorUnitsNumerator",
    );
    const priceMinorUnitsDenominator = integer(
      body.priceMinorUnitsDenominator,
      "priceMinorUnitsDenominator",
    );
    if (
      receivedMilligrams <= 0n ||
      priceMinorUnitsNumerator < 0n ||
      priceMinorUnitsDenominator <= 0n
    ) {
      throw new BadRequestException(
        "receipt mass and purchase rate are invalid",
      );
    }
    const vendor = text(body.vendor, "vendor", 200);
    const receiptCurrency = currency(body.currency);
    const purchasedAt = explicitInstant(body.purchasedAt, "purchasedAt");
    const reason = reasonText(body);
    if (codePointLength(reason) > 500)
      throw new BadRequestException("reason is too long");
    return this.command(
      operator,
      `cat:n:${nodeId}:i:${inventoryId}:receipt-correct`,
      key,
      {
        nodeId,
        inventoryId,
        supersedesReceiptId,
        receivedMilligrams: receivedMilligrams.toString(),
        priceMinorUnitsNumerator: priceMinorUnitsNumerator.toString(),
        priceMinorUnitsDenominator: priceMinorUnitsDenominator.toString(),
        vendor,
        currency: receiptCurrency,
        purchasedAt: purchasedAt.toISOString(),
        reason,
      },
      async (tx, idempotencyKey) => {
        const rows = await tx.$queryRaw<
          Array<{ machine_id: string; remaining_milligrams: bigint }>
        >`
          SELECT machine_id, remaining_milligrams FROM inventories
          WHERE id = ${inventoryId}::uuid AND node_id = ${nodeId}::uuid
          FOR UPDATE
        `;
        if (rows.length !== 1)
          throw new NotFoundException("Inventory was not found");
        if (receivedMilligrams < rows[0]!.remaining_milligrams) {
          throw new ConflictException(
            "Corrected receipt mass is below current lot balance",
          );
        }
        const activeReceipt = await tx.inventoryReceipt.findFirst({
          where: { inventoryId, nodeId, corrections: { none: {} } },
          select: { id: true },
        });
        if (activeReceipt?.id !== supersedesReceiptId) {
          throw new ConflictException("Inventory receipt has changed");
        }
        const receipt = await tx.inventoryReceipt.create({
          data: {
            nodeId,
            machineId: rows[0]!.machine_id,
            inventoryId,
            kind: InventoryReceiptKind.CORRECTION,
            supersedesReceiptId,
            receivedMilligrams,
            vendor,
            currency: receiptCurrency,
            priceMinorUnitsNumerator,
            priceMinorUnitsDenominator,
            purchasedAt,
            reason,
          },
        });
        await tx.inventory.update({
          where: { id: inventoryId },
          data: {
            vendor,
            currency: receiptCurrency,
            priceMinorUnitsNumerator,
            priceMinorUnitsDenominator,
          },
        });
        await this.record(tx, operator, nodeId, idempotencyKey, inventoryId, {
          eventType: "catalog.inventory.receipt-corrected",
          reason,
          reasonCode: "INVENTORY_RECEIPT_CORRECTION",
          payload: {
            operation: "receipt-correction",
            receiptId: receipt.id,
            supersedesReceiptId,
          },
        });
        return { id: inventoryId, status: "RECEIPT_CORRECTED" };
      },
    );
  }

  async setInventoryMount(
    operator: OperatorContext,
    nodeId: string,
    inventoryId: string,
    body: InventoryMountDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    inventoryId = uuid(inventoryId, "inventoryId");
    body = commandBody(body);
    if (body.mountStatus !== "MOUNTED" && body.mountStatus !== "UNMOUNTED") {
      throw new BadRequestException("mountStatus is invalid");
    }
    const mountStatus = body.mountStatus;
    const reason = reasonText(body);
    return this.command(
      operator,
      `cat:n:${nodeId}:i:${inventoryId}:mount`,
      key,
      { nodeId, inventoryId, mountStatus, reason },
      async (tx, idempotencyKey) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM inventories
          WHERE id = ${inventoryId}::uuid AND node_id = ${nodeId}::uuid FOR UPDATE
        `;
        if (rows.length !== 1)
          throw new NotFoundException("Inventory was not found");
        if (mountStatus === "UNMOUNTED") {
          const printing = await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM production_reservations
            WHERE inventory_id = ${inventoryId}::uuid
              AND node_id = ${nodeId}::uuid
              AND status = 'PRINTING'
            LIMIT 1
          `;
          if (printing.length > 0) {
            throw new ConflictException(
              "Printing inventory cannot be unmounted",
            );
          }
        }
        const inventory = await tx.inventory.update({
          where: { id: inventoryId },
          data: { mountStatus },
        });
        await this.record(tx, operator, nodeId, idempotencyKey, inventoryId, {
          eventType: "catalog.inventory.mount-changed",
          reason,
          reasonCode: "INVENTORY_MOUNT_CHANGE",
          payload: { operation: "mount", mountStatus },
        });
        return { id: inventoryId, status: inventory.mountStatus };
      },
    );
  }

  async replaceMachineAvailability(
    operator: OperatorContext,
    nodeId: string,
    machineId: string,
    body: ReplaceMachineAvailabilityDto,
    key?: string,
  ): Promise<CatalogResult> {
    nodeId = this.node(operator, nodeId);
    machineId = uuid(machineId, "machineId");
    body = commandBody(body);
    const reason = reasonText(body);
    if (codePointLength(reason) > 500)
      throw new BadRequestException("reason is too long");
    if (reason === "LEGACY_LIVE_RESERVATION_BOOTSTRAP") {
      throw new BadRequestException(
        "reason is reserved for migration bootstrap",
      );
    }
    const expectedVersion = body.expectedVersion;
    if (
      expectedVersion !== null &&
      (!Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        expectedVersion >= MAX_INT32)
    ) {
      throw new BadRequestException("expectedVersion is invalid");
    }
    if (!Array.isArray(body.windows) || body.windows.length > 1000) {
      throw new BadRequestException(
        "windows must contain at most 1000 intervals",
      );
    }
    const windows = body.windows
      .map((window, index) => ({
        startsAt: explicitInstant(
          window?.startsAt,
          `windows[${index}].startsAt`,
        ),
        endsAt: explicitInstant(window?.endsAt, `windows[${index}].endsAt`),
      }))
      .sort(
        (left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
      );
    for (const [index, window] of windows.entries()) {
      if (
        window.endsAt <= window.startsAt ||
        (index > 0 && window.startsAt < windows[index - 1]!.endsAt)
      ) {
        throw new BadRequestException(
          "availability windows must be positive and nonoverlapping",
        );
      }
    }
    return this.command(
      operator,
      `cat:n:${nodeId}:m:${machineId}:availability`,
      key,
      {
        nodeId,
        machineId,
        expectedVersion,
        reason,
        windows: windows.map(({ startsAt, endsAt }) => ({
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        })),
      },
      async (tx, idempotencyKey) => {
        const machineRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM machines WHERE id = ${machineId}::uuid
            AND node_id = ${nodeId}::uuid FOR UPDATE
        `;
        if (machineRows.length !== 1)
          throw new NotFoundException("Machine was not found");
        const selected = await tx.machineAvailabilitySelection.findUnique({
          where: { machineId_nodeId: { machineId, nodeId } },
        });
        if ((selected?.selectionVersion ?? null) !== expectedVersion) {
          throw new ConflictException("Machine availability selection changed");
        }
        const now = await databaseNow(tx);
        const horizon = 366 * 86_400_000;
        if (
          (windows.length > 0 &&
            windows[windows.length - 1]!.endsAt.getTime() -
              windows[0]!.startsAt.getTime() >
              horizon) ||
          windows.some(
            ({ startsAt, endsAt }) =>
              startsAt.getTime() < now.getTime() - horizon ||
              endsAt.getTime() > now.getTime() + horizon ||
              endsAt.getTime() - startsAt.getTime() > horizon,
          )
        ) {
          throw new BadRequestException(
            "availability windows exceed the 366-day bound",
          );
        }
        const revision = await tx.machineAvailabilityRevision.create({
          data: { nodeId, machineId, reason },
        });
        await tx.machineAvailabilityWindow.createMany({
          data: windows.map((window, ordinal) => ({
            revisionId: revision.id,
            nodeId,
            machineId,
            ordinal,
            ...window,
          })),
        });
        const excluded = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT reservation.id
          FROM capacity_reservations reservation
          WHERE reservation.machine_id = ${machineId}::uuid
            AND reservation.node_id = ${nodeId}::uuid
            AND reservation.status IN ('RESERVED', 'HELD', 'SCHEDULED', 'PRINTING')
            AND NOT EXISTS (
              SELECT 1 FROM machine_availability_windows available
              WHERE available.revision_id = ${revision.id}::uuid
                AND available.starts_at <= reservation.starts_at
                AND available.ends_at >= reservation.ends_at
            )
          ORDER BY reservation.id LIMIT 101
        `;
        if (excluded.length > 0) {
          throw new ConflictException({
            message: "Availability excludes live reservations",
            conflictReservationIds: excluded.slice(0, 100).map(({ id }) => id),
            moreConflicts: excluded.length > 100,
          });
        }
        if (selected) {
          await tx.machineAvailabilitySelection.update({
            where: { machineId_nodeId: { machineId, nodeId } },
            data: {
              revisionId: revision.id,
              selectionVersion: { increment: 1 },
              updatedAt: now,
            },
          });
        } else {
          await tx.machineAvailabilitySelection.create({
            data: {
              machineId,
              nodeId,
              revisionId: revision.id,
              selectionVersion: 1,
            },
          });
        }
        await this.record(tx, operator, nodeId, idempotencyKey, machineId, {
          eventType: "catalog.machine.availability-changed",
          reason,
          reasonCode: "MACHINE_AVAILABILITY_CHANGE",
          payload: {
            operation: "availability",
            revisionId: revision.id,
            previousRevisionId: selected?.revisionId ?? null,
            selectionVersion: (selected?.selectionVersion ?? 0) + 1,
          },
        });
        return { id: revision.id, status: "ACTIVE" };
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
    const input = { nodeId, id, action, reason };
    const execute = async (
      tx: Transaction,
      idempotencyKey: string,
      verification?: VerifiedCatalogSnapshot,
    ) => {
      const revision =
        kind === "reference-profile"
          ? action === "activate"
            ? await this.catalog.activateReferenceProfile(id, tx, verification)
            : await this.catalog.retireReferenceProfile(id, tx)
          : action === "activate"
            ? await this.catalog.activateMachineProfile(id, tx, verification)
            : await this.catalog.retireMachineProfile(id, tx);
      const state = (revision as { state: string }).state;
      const result = {
        id,
        state,
        ...(kind === "reference-profile" && action === "activate"
          ? {
              notice: referenceProfileActivationNotice(
                revision as ReferenceProfileActivationNoticeSource,
              ),
            }
          : {}),
      };
      await this.record(tx, operator, nodeId, idempotencyKey, id, {
        eventType: `catalog.${kind}.${action}d`,
        reason,
        reasonCode: "CATALOG_REVISION_LIFECYCLE",
        payload: { operation: action, revisionKind: kind },
      });
      return result;
    };
    const namespace = `catalog:${kind}:${id}:${action}`;
    if (action === "retire") {
      return this.command(operator, namespace, key, input, execute);
    }
    return this.activationCommand(
      operator,
      namespace,
      key,
      input,
      () =>
        kind === "reference-profile"
          ? this.catalog.verifyReferenceProfileSnapshot(id)
          : this.catalog.verifyMachineProfileSnapshot(id),
      execute,
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
    const input = { nodeId, id, action, reason };
    const execute = async (
      tx: Transaction,
      idempotencyKey: string,
      verification?: VerifiedCatalogSnapshot,
    ) => {
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
          ? await this.catalog.activateMachineCalibration(id, tx, verification)
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
    };
    const namespace = `cat:n:${nodeId}:c:${id}:${action === "activate" ? "a" : "r"}`;
    if (action === "retire") {
      return this.command(operator, namespace, key, input, execute);
    }
    return this.activationCommand(
      operator,
      namespace,
      key,
      input,
      () => this.catalog.verifyMachineCalibrationSnapshot(id, nodeId),
      execute,
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

  private async requireMachineInNode(
    nodeId: string,
    machineId: string,
    client: Pick<Transaction, "machine"> = this.prisma,
  ): Promise<void> {
    const machine = await client.machine.findFirst({
      where: { id: machineId, nodeId },
      select: { id: true },
    });
    if (!machine)
      throw new NotFoundException("Machine was not found in the node");
  }

  private async requireMachineProfileCompatibility(
    input: CreateMachineProfileInput,
    client: Pick<Transaction, "referenceProfile" | "machineCapability"> = this
      .prisma,
  ): Promise<void> {
    const [referenceProfile, machineCapability] = await Promise.all([
      client.referenceProfile.findFirst({
        where: {
          id: input.referenceProfileId,
          material: input.material,
          quality: input.quality,
        },
        select: { id: true },
      }),
      client.machineCapability.findFirst({
        where: {
          id: input.machineCapabilityId,
          supportedMaterials: { has: input.material },
          supportedNozzleMicrometers: {
            has: input.nozzleDiameterMicrometers,
          },
        },
        select: { id: true },
      }),
    ]);
    if (!referenceProfile || !machineCapability) {
      throw new ConflictException(
        "machine profile material, quality, or nozzle is incompatible",
      );
    }
  }

  private async activationCommand<T extends CatalogResult>(
    operator: OperatorContext,
    namespace: string,
    key: string | undefined,
    input: unknown,
    verify: () => Promise<VerifiedCatalogSnapshot>,
    execute: (
      tx: Transaction,
      idempotencyKey: string,
      verification: VerifiedCatalogSnapshot,
    ) => Promise<T>,
  ): Promise<T> {
    const preparation = await this.prepareIdempotency<T>(
      operator,
      namespace,
      key,
      input,
    );
    if ("response" in preparation) return preparation.response;
    try {
      const verification = await verify();
      return this.command(
        operator,
        namespace,
        key,
        input,
        (tx, idempotencyKey) => execute(tx, idempotencyKey, verification),
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundError) {
        throw new NotFoundException("Catalog resource was not found");
      }
      if (error instanceof ResourceSnapshotIntegrityError) {
        throw new ConflictException(
          "Catalog revision snapshot verification failed",
        );
      }
      if (error instanceof ResourceSnapshotUnavailableError) {
        throw new ServiceUnavailableException(
          "Catalog revision snapshot verification is unavailable",
        );
      }
      throw error;
    }
  }

  private async prepareIdempotency<T extends CatalogResult>(
    operator: OperatorContext,
    namespace: string,
    key: string | undefined,
    input: unknown,
  ): Promise<IdempotencyPreparation<T>> {
    namespace = operatorCommandNamespace(namespace);
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
    if (!existing || existing.expiresAt <= now)
      return { needsVerification: true };
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
    return { needsVerification: true };
  }

  private async command<T extends CatalogResult>(
    operator: OperatorContext,
    namespace: string,
    key: string | undefined,
    input: unknown,
    execute: (tx: Transaction, idempotencyKey: string) => Promise<T>,
  ): Promise<T> {
    namespace = operatorCommandNamespace(namespace);
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

function operatorCommandNamespace(namespace: string): string {
  return namespace.replace("catalog:", "cat:");
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

function machineCapabilityInput(
  body: CreateMachineCapabilityDto,
): CreateMachineCapabilityInput {
  body = commandBody(body);
  if (
    !Array.isArray(body.supportedNozzleMicrometers) ||
    body.supportedNozzleMicrometers.length === 0
  ) {
    throw new BadRequestException(
      "supportedNozzleMicrometers must not be empty",
    );
  }
  if (
    !Array.isArray(body.supportedMaterials) ||
    body.supportedMaterials.length === 0
  ) {
    throw new BadRequestException("supportedMaterials must not be empty");
  }
  const nozzles = body.supportedNozzleMicrometers.map((value) =>
    positiveInteger(value, "supportedNozzleMicrometers"),
  );
  const materials = body.supportedMaterials.map((value) =>
    enumValue(value, Material, "supportedMaterials"),
  );
  if (
    new Set(nozzles).size !== nozzles.length ||
    new Set(materials).size !== materials.length
  ) {
    throw new BadRequestException(
      "Supported nozzle and material values must be unique",
    );
  }
  const buildVolumeXMicrometers = integer(
    body.buildVolumeXMicrometers,
    "buildVolumeXMicrometers",
  );
  const buildVolumeYMicrometers = integer(
    body.buildVolumeYMicrometers,
    "buildVolumeYMicrometers",
  );
  const buildVolumeZMicrometers = integer(
    body.buildVolumeZMicrometers,
    "buildVolumeZMicrometers",
  );
  if (
    [
      buildVolumeXMicrometers,
      buildVolumeYMicrometers,
      buildVolumeZMicrometers,
    ].some((value) => value <= 0n)
  ) {
    throw new BadRequestException("Build volume dimensions must be positive");
  }
  return {
    capabilityKey: text(body.capabilityKey, "capabilityKey", 100),
    manufacturer: text(body.manufacturer, "manufacturer", 100),
    model: text(body.model, "model", 100),
    buildVolumeXMicrometers,
    buildVolumeYMicrometers,
    buildVolumeZMicrometers,
    supportedNozzleMicrometers: nozzles,
    supportedMaterials: materials,
  };
}

function registerMachineInput(
  nodeId: string,
  body: RegisterMachineDto,
): RegisterMachineInput {
  body = commandBody(body);
  return {
    nodeId,
    machineCapabilityId: uuid(body.machineCapabilityId, "machineCapabilityId"),
    code: text(body.code, "code", 50),
    displayName: text(body.displayName, "displayName", 200),
    installedNozzleMicrometers: positiveInteger(
      body.installedNozzleMicrometers,
      "installedNozzleMicrometers",
    ),
  };
}

function printConfigRevisionInput(
  body: CreatePrintConfigRevisionDto,
): CreatePrintConfigRevisionInput {
  body = commandBody(body);
  const infillPercent = integerNumber(body.infillPercent, "infillPercent");
  if (infillPercent < 0 || infillPercent > 100) {
    throw new BadRequestException("infillPercent must be between 0 and 100");
  }
  if (
    typeof body.supportsEnabled !== "boolean" ||
    typeof body.brimEnabled !== "boolean"
  ) {
    throw new BadRequestException(
      "supportsEnabled and brimEnabled must be booleans",
    );
  }
  return {
    quality: enumValue(body.quality, PrintQuality, "quality"),
    infillPercent,
    layerHeightMicrometers: positiveInteger(
      body.layerHeightMicrometers,
      "layerHeightMicrometers",
    ),
    supportsEnabled: body.supportsEnabled,
    brimEnabled: body.brimEnabled,
    settings: settings(body.settings),
  };
}

async function priceListInput(
  body: CreatePriceListDto,
): Promise<CreatePriceListInput> {
  body = commandBody(body);
  if (body.currency !== "CZK") {
    throw new BadRequestException("currency must be CZK in v0");
  }
  const parameters = settings(body.parameters);
  await validatePriceListParameters(parameters);
  return {
    revision: text(body.revision, "revision", 100),
    termsRevision: text(body.termsRevision, "termsRevision", 100),
    currency: "CZK",
    parameters,
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
    assertSettingsDepth(value, "settings");
    rejectInvalidSettingsText(value as CanonicalJson, "settings");
    canonicalJson(value as CanonicalJson);
  } catch (error) {
    if (error instanceof ResourceValidationError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
  return value as Prisma.InputJsonObject;
}

function assertSettingsDepth(value: object, name: string): void {
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 1, value },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > JSON_MAXIMUM_DEPTH) {
      throw new BadRequestException(
        `${name} must not exceed ${JSON_MAXIMUM_DEPTH} levels`,
      );
    }
    if (current.value === null || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === "object") {
        pending.push({ depth: current.depth + 1, value: child });
      }
    }
  }
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
  rejectInvalidText(normalized, name);
  const length = codePointLength(normalized);
  if (length === 0) {
    throw new BadRequestException(`${name} must not be blank`);
  }
  if (maxLength !== undefined && length > maxLength) {
    throw new BadRequestException(`${name} is too long`);
  }
  return normalized;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function rejectInvalidSettingsText(value: CanonicalJson, name: string): void {
  if (typeof value === "string") {
    rejectInvalidText(value, name);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) rejectInvalidSettingsText(entry, name);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      rejectInvalidText(key, name);
      rejectInvalidSettingsText(entry, name);
    }
  }
}

function rejectInvalidText(value: string, name: string): void {
  if (value.includes("\u0000")) {
    throw new BadRequestException(`${name} must not contain NUL characters`);
  }
  if (hasUnpairedSurrogate(value)) {
    throw new BadRequestException(
      `${name} must not contain unpaired UTF-16 surrogates`,
    );
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) return true;
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return true;
  }
  return false;
}

function currency(value: unknown): string {
  const normalized = text(value, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) {
    throw new BadRequestException("currency is invalid");
  }
  return normalized;
}

function explicitInstant(value: unknown, name: string): Date {
  const parts =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
          value,
        )
      : null;
  if (typeof value !== "string" || !parts) {
    throw new BadRequestException(
      `${name} requires an ISO date-time with offset`,
    );
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6]);
  const offsetHour = parts[7] === undefined ? 0 : Number(parts[7]);
  const offsetMinute = parts[8] === undefined ? 0 : Number(parts[8]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new BadRequestException(`${name} is invalid`);
  }
  // JavaScript Date and PostgreSQL inputs have millisecond precision. Accept
  // RFC 3339 fractions and truncate only the sub-millisecond digits.
  const instant = new Date(
    value.replace(/(\.\d{3})\d+(?=Z|[+-]\d{2}:\d{2}$)/, "$1"),
  );
  if (Number.isNaN(instant.getTime())) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return instant;
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
  if (codePointLength(reason) > 1_000)
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
