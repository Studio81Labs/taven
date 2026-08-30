import { Inject, Injectable } from "@nestjs/common";
import {
  InventoryStatus,
  MachineStatus,
  Material,
  Prisma,
  PrintQuality,
  RevisionKind,
  RevisionState,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ResourceConflictError,
  ResourceNotFoundError,
  ResourceValidationError,
} from "./resource-errors";
import {
  resourceRevisionDigest,
  type CanonicalJson,
} from "./resource-identity";

type JsonSettings = Prisma.InputJsonObject;

export type CreateReferenceProfileInput = {
  material: Material;
  quality: PrintQuality;
  slicerEngine: string;
  slicerVersion: string;
  settings: JsonSettings;
};

export type CreateMachineProfileInput = {
  machineCapabilityId: string;
  referenceProfileId: string;
  material: Material;
  quality: PrintQuality;
  nozzleDiameterMicrometers: number;
  slicerEngine: string;
  slicerVersion: string;
  settings: JsonSettings;
};

export type CreateMachineCalibrationInput = {
  nodeId: string;
  machineId: string;
  flowRatioPartsPerMillion: number;
  xyCompensationMicrometers: number;
  elephantFootCompensationMicrometers: number;
  settings: JsonSettings;
};

export type CreateInventoryInput = {
  nodeId: string;
  machineId: string;
  sku: string;
  material: Material;
  vendor: string;
  color?: string | null;
  lotCode?: string | null;
  priceMinorUnitsNumerator: bigint;
  priceMinorUnitsDenominator: bigint;
  currency: string;
  remainingMilligrams: bigint;
};

type RevisionTable =
  "referenceProfile" | "machineProfile" | "machineCalibration";

function nonBlank(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ResourceValidationError(`${name} must not be blank`);
  }
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ResourceValidationError(`${name} must be a positive integer`);
  }
  return value;
}

function canonicalSettings(settings: JsonSettings): CanonicalJson {
  return settings as CanonicalJson;
}

function prismaConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("meta" in error)) return;
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return;
  if ("constraint" in meta && typeof meta.constraint === "string") {
    return meta.constraint;
  }
  if ("target" in meta) {
    return Array.isArray(meta.target)
      ? meta.target.join(",")
      : typeof meta.target === "string"
        ? meta.target
        : undefined;
  }
  return;
}

function catalogWriteError(error: unknown): never {
  if (error instanceof ResourceValidationError) throw error;
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    ["P2002", "P2003", "P2010"].includes(error.code)
  ) {
    throw new ResourceConflictError(
      "resource catalog change conflicts with the current catalog",
      prismaConstraint(error),
    );
  }
  throw error;
}

async function databaseNow(
  transaction: Prisma.TransactionClient,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT clock_timestamp() AS observed_at
  `;
  const observedAt = rows[0]?.observed_at;
  if (!observedAt) throw new Error("database clock is unavailable");
  return observedAt;
}

@Injectable()
export class ResourceCatalogService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createReferenceProfile(input: CreateReferenceProfileInput) {
    const slicerEngine = nonBlank(input.slicerEngine, "slicerEngine");
    const slicerVersion = nonBlank(input.slicerVersion, "slicerVersion");
    const payload = {
      material: input.material,
      quality: input.quality,
      settings: canonicalSettings(input.settings),
      slicerEngine,
      slicerVersion,
    } satisfies CanonicalJson;
    const id = randomUUID();
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.revisionIdentity.create({
          data: {
            id,
            kind: RevisionKind.REFERENCE_PROFILE,
            digest: resourceRevisionDigest("REFERENCE_PROFILE", payload),
          },
        });
        return transaction.referenceProfile.create({
          data: { id, ...input, slicerEngine, slicerVersion },
        });
      });
    } catch (error) {
      return catalogWriteError(error);
    }
  }

  async createMachineProfile(input: CreateMachineProfileInput) {
    const slicerEngine = nonBlank(input.slicerEngine, "slicerEngine");
    const slicerVersion = nonBlank(input.slicerVersion, "slicerVersion");
    const nozzleDiameterMicrometers = positiveInteger(
      input.nozzleDiameterMicrometers,
      "nozzleDiameterMicrometers",
    );
    const payload = {
      machineCapabilityId: input.machineCapabilityId,
      material: input.material,
      nozzleDiameterMicrometers,
      quality: input.quality,
      referenceProfileId: input.referenceProfileId,
      settings: canonicalSettings(input.settings),
      slicerEngine,
      slicerVersion,
    } satisfies CanonicalJson;
    const id = randomUUID();
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.revisionIdentity.create({
          data: {
            id,
            kind: RevisionKind.MACHINE_PROFILE,
            digest: resourceRevisionDigest("MACHINE_PROFILE", payload),
          },
        });
        return transaction.machineProfile.create({
          data: {
            id,
            ...input,
            nozzleDiameterMicrometers,
            slicerEngine,
            slicerVersion,
          },
        });
      });
    } catch (error) {
      return catalogWriteError(error);
    }
  }

  async createMachineCalibration(input: CreateMachineCalibrationInput) {
    const flowRatioPartsPerMillion = positiveInteger(
      input.flowRatioPartsPerMillion,
      "flowRatioPartsPerMillion",
    );
    for (const [name, value] of [
      ["xyCompensationMicrometers", input.xyCompensationMicrometers],
      [
        "elephantFootCompensationMicrometers",
        input.elephantFootCompensationMicrometers,
      ],
    ] as const) {
      if (!Number.isSafeInteger(value)) {
        throw new ResourceValidationError(`${name} must be an integer`);
      }
    }
    const payload = {
      elephantFootCompensationMicrometers:
        input.elephantFootCompensationMicrometers,
      flowRatioPartsPerMillion,
      machineId: input.machineId,
      nodeId: input.nodeId,
      settings: canonicalSettings(input.settings),
      xyCompensationMicrometers: input.xyCompensationMicrometers,
    } satisfies CanonicalJson;
    const id = randomUUID();
    try {
      return await this.prisma.$transaction(async (transaction) => {
        await transaction.revisionIdentity.create({
          data: {
            id,
            kind: RevisionKind.MACHINE_CALIBRATION,
            digest: resourceRevisionDigest("MACHINE_CALIBRATION", payload),
          },
        });
        return transaction.machineCalibration.create({
          data: { id, ...input, flowRatioPartsPerMillion },
        });
      });
    } catch (error) {
      return catalogWriteError(error);
    }
  }

  listReferenceProfiles(state?: RevisionState) {
    return this.prisma.referenceProfile.findMany({
      ...(state ? { where: { state } } : {}),
      orderBy: [
        { material: "asc" },
        { quality: "asc" },
        { createdAt: "desc" },
        { id: "asc" },
      ],
    });
  }

  listMachineProfiles(state?: RevisionState) {
    return this.prisma.machineProfile.findMany({
      ...(state ? { where: { state } } : {}),
      orderBy: [
        { machineCapabilityId: "asc" },
        { material: "asc" },
        { quality: "asc" },
        { nozzleDiameterMicrometers: "asc" },
        { createdAt: "desc" },
        { id: "asc" },
      ],
    });
  }

  listMachineCalibrations(nodeId: string, machineId?: string) {
    return this.prisma.machineCalibration.findMany({
      where: { nodeId, ...(machineId ? { machineId } : {}) },
      orderBy: [{ machineId: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    });
  }

  activateReferenceProfile(id: string) {
    return this.transitionRevision("referenceProfile", id, "activate");
  }

  retireReferenceProfile(id: string) {
    return this.transitionRevision("referenceProfile", id, "retire");
  }

  activateMachineProfile(id: string) {
    return this.transitionRevision("machineProfile", id, "activate");
  }

  retireMachineProfile(id: string) {
    return this.transitionRevision("machineProfile", id, "retire");
  }

  activateMachineCalibration(id: string) {
    return this.transitionRevision("machineCalibration", id, "activate");
  }

  retireMachineCalibration(id: string) {
    return this.transitionRevision("machineCalibration", id, "retire");
  }

  listMachines(nodeId: string) {
    return this.prisma.machine.findMany({
      where: { nodeId },
      orderBy: [{ code: "asc" }, { id: "asc" }],
    });
  }

  async updateMachineStatus(
    nodeId: string,
    machineId: string,
    status: MachineStatus,
  ) {
    const result = await this.prisma.machine.updateMany({
      where: { id: machineId, nodeId },
      data: { status },
    });
    if (result.count !== 1) {
      throw new ResourceNotFoundError("machine was not found in the node");
    }
    return this.prisma.machine.findUniqueOrThrow({ where: { id: machineId } });
  }

  async createInventory(input: CreateInventoryInput) {
    if (input.remainingMilligrams < 0n) {
      throw new ResourceValidationError(
        "remainingMilligrams must not be negative",
      );
    }
    if (input.priceMinorUnitsNumerator < 0n) {
      throw new ResourceValidationError(
        "priceMinorUnitsNumerator must not be negative",
      );
    }
    if (input.priceMinorUnitsDenominator <= 0n) {
      throw new ResourceValidationError(
        "priceMinorUnitsDenominator must be positive",
      );
    }
    const currency = nonBlank(input.currency, "currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ResourceValidationError("currency must be a three-letter code");
    }
    try {
      return await this.prisma.inventory.create({
        data: {
          ...input,
          id: randomUUID(),
          sku: nonBlank(input.sku, "sku"),
          vendor: nonBlank(input.vendor, "vendor"),
          currency,
        },
      });
    } catch (error) {
      return catalogWriteError(error);
    }
  }

  listInventories(nodeId: string, machineId?: string) {
    return this.prisma.inventory.findMany({
      where: { nodeId, ...(machineId ? { machineId } : {}) },
      orderBy: [
        { machineId: "asc" },
        { material: "asc" },
        { color: "asc" },
        { sku: "asc" },
      ],
    });
  }

  async adjustInventoryRemaining(
    nodeId: string,
    inventoryId: string,
    deltaMilligrams: bigint,
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const rows = await transaction.$queryRaw<
          Array<{
            remaining_milligrams: bigint;
            reserved_milligrams: bigint;
          }>
        >`
          SELECT remaining_milligrams, reserved_milligrams
          FROM inventories
          WHERE id = ${inventoryId}::uuid AND node_id = ${nodeId}::uuid
          FOR UPDATE
        `;
        const inventory = rows[0];
        if (!inventory) {
          throw new ResourceNotFoundError(
            "inventory was not found in the node",
          );
        }
        const remainingMilligrams =
          inventory.remaining_milligrams + deltaMilligrams;
        if (
          remainingMilligrams < 0n ||
          remainingMilligrams < inventory.reserved_milligrams
        ) {
          throw new ResourceConflictError(
            "inventory adjustment would consume reserved material",
            "inventories_balance_check",
          );
        }
        return transaction.inventory.update({
          where: { id: inventoryId },
          data: { remainingMilligrams },
        });
      });
    } catch (error) {
      if (
        error instanceof ResourceConflictError ||
        error instanceof ResourceNotFoundError
      ) {
        throw error;
      }
      return catalogWriteError(error);
    }
  }

  async updateInventoryStatus(
    nodeId: string,
    inventoryId: string,
    status: InventoryStatus,
  ) {
    const result = await this.prisma.inventory.updateMany({
      where: { id: inventoryId, nodeId },
      data: { status },
    });
    if (result.count !== 1) {
      throw new ResourceNotFoundError("inventory was not found in the node");
    }
    return this.prisma.inventory.findUniqueOrThrow({
      where: { id: inventoryId },
    });
  }

  private async transitionRevision(
    table: RevisionTable,
    id: string,
    action: "activate" | "retire",
  ) {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const observedAt = await databaseNow(transaction);
        const delegate = transaction[table] as unknown as {
          updateMany(args: {
            where: { id: string; state: RevisionState };
            data: {
              state: RevisionState;
              activatedAt?: Date;
              retiredAt?: Date;
            };
          }): Promise<{ count: number }>;
          findUniqueOrThrow(args: { where: { id: string } }): Promise<unknown>;
        };
        const expectedState =
          action === "activate" ? RevisionState.DRAFT : RevisionState.ACTIVE;
        const result = await delegate.updateMany({
          where: { id, state: expectedState },
          data:
            action === "activate"
              ? { state: RevisionState.ACTIVE, activatedAt: observedAt }
              : { state: RevisionState.RETIRED, retiredAt: observedAt },
        });
        if (result.count !== 1) {
          throw new ResourceConflictError(
            `${table} is missing or cannot ${action} from its current state`,
            "revision_lifecycle_transition_check",
          );
        }
        return delegate.findUniqueOrThrow({ where: { id } });
      });
    } catch (error) {
      if (error instanceof ResourceConflictError) throw error;
      return catalogWriteError(error);
    }
  }
}
