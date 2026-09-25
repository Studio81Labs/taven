import { Injectable } from "@nestjs/common";
import {
  InventoryStatus,
  MachineStatus,
  Prisma,
  RevisionState,
} from "@prisma/client";
import type { CandidateEstimateJob } from "@taven/slicer-contracts" with {
  "resolution-mode": "import",
};
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { candidatePlateCapacities } from "../automatic-quotes/candidate-plate-capacities";
import { toSlicerProductionArtifactFormat } from "../slicing/production-artifact-format";
import { slicerSettingsSnapshot } from "../slicing/slicer-profile-snapshot.service";

export type FrozenCandidateItem = Prisma.OrderItemGetPayload<{
  include: {
    sourceModelFile: true;
    modelGeometry: true;
    printConfigRevision: true;
  };
}>;

export type FrozenCandidateSource = {
  referenceProfileId: string;
  bodyIds: string[];
  selectionSha256: string;
};

export type FrozenCandidateInput = {
  nodeId: string;
  inventoryId: string;
  availabilityRevisionId: string;
  availabilitySelectionVersion: number;
  identity: string;
  input: CandidateEstimateJob["input"];
};

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function geometryFitsCapability(
  geometry: FrozenCandidateItem["modelGeometry"],
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
  const volume = [
    capability.buildVolumeXMicrometers,
    capability.buildVolumeYMicrometers,
    capability.buildVolumeZMicrometers,
  ].sort(compare);
  return bounds.every((bound, index) => bound <= volume[index]!);
}

function referenceOccupancies(
  quantity: number,
  partsPerPlate: number,
): number[] {
  if (quantity <= partsPerPlate) return [quantity];
  const remainder = quantity % partsPerPlate;
  return remainder === 0 ? [partsPerPlate] : [partsPerPlate, remainder];
}

@Injectable()
export class FrozenOrderCandidateInputService {
  constructor(private readonly prisma: PrismaService) {}

  /** Enumerate fresh physical options without committing dispatch or reservations. */
  async enumerate(args: {
    item: FrozenCandidateItem;
    source: FrozenCandidateSource;
    shipmentPlanId: string;
    quantity: number;
    nodeId?: string;
    expressRequested: boolean;
    observedAt: Date;
    arrangementScope: string;
    persistArrangementRevision?: boolean;
    legacyBindingId?: string;
    legacyOrigin?: "automatic" | "individual";
  }): Promise<FrozenCandidateInput[]> {
    const { item, source, shipmentPlanId, quantity, nodeId, observedAt } = args;
    const profiles = await this.prisma.machineProfile.findMany({
      where: {
        state: RevisionState.ACTIVE,
        referenceProfileId: source.referenceProfileId,
        material: item.material,
      },
      include: {
        machineCapability: {
          include: {
            machines: {
              where: {
                status: MachineStatus.ACTIVE,
                ...(nodeId ? { nodeId } : {}),
              },
              include: {
                node: true,
                availabilitySelection: {
                  include: {
                    revision: {
                      select: {
                        reason: true,
                        windows: { select: { endsAt: true } },
                      },
                    },
                  },
                },
                calibrations: {
                  where: { state: RevisionState.ACTIVE },
                  orderBy: [{ activatedAt: "desc" }, { id: "asc" }],
                },
                inventories: {
                  where: {
                    status: InventoryStatus.AVAILABLE,
                    material: item.material,
                    remainingMilligrams: { gt: 0n },
                    receipts: { some: { kind: "INITIAL" } },
                    ...(args.expressRequested
                      ? { mountStatus: "MOUNTED" as const }
                      : {}),
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
    const contracts = await import("@taven/slicer-contracts");
    const candidates: FrozenCandidateInput[] = [];
    for (const profile of profiles) {
      const productionArtifactFormat = toSlicerProductionArtifactFormat(
        profile.productionArtifactFormat,
      );
      const plateCapacities = candidatePlateCapacities(
        quantity,
        productionArtifactFormat,
      );
      if (
        !plateCapacities.length ||
        !geometryFitsCapability(item.modelGeometry, profile.machineCapability)
      )
        continue;
      for (const machine of profile.machineCapability.machines) {
        if (
          !machine.node.active ||
          !machine.availabilitySelection ||
          machine.availabilitySelection.revision.reason ===
            "LEGACY_LIVE_RESERVATION_BOOTSTRAP" ||
          !machine.availabilitySelection.revision.windows.some(
            ({ endsAt }) => endsAt > observedAt,
          ) ||
          machine.installedNozzleMicrometers !==
            profile.nozzleDiameterMicrometers
        )
          continue;
        const calibration = machine.calibrations[0];
        if (!calibration) continue;
        for (const inventory of machine.inventories) {
          if (inventory.remainingMilligrams <= inventory.reservedMilligrams)
            continue;
          for (const partsPerPlate of plateCapacities) {
            const identity = [
              item.id,
              shipmentPlanId,
              machine.id,
              profile.id,
              calibration.id,
              inventory.id,
              ...(args.legacyBindingId ? [] : [quantity]),
              partsPerPlate,
              machine.availabilitySelection.revisionId,
              machine.availabilitySelection.selectionVersion,
            ].join(":");
            const arrangementIdentity = [
              item.id,
              shipmentPlanId,
              machine.id,
              profile.id,
              calibration.id,
              quantity,
              partsPerPlate,
            ].join(":");
            const arrangementRevisionId = deterministicUuid(
              args.legacyBindingId
                ? `${args.legacyOrigin}-arrangement:${args.legacyBindingId}:${arrangementIdentity}`
                : `${args.arrangementScope}:arrangement:${arrangementIdentity}`,
            );
            const arrangementContentSha256 = createHash("sha256")
              .update(
                canonicalJson({
                  ...(args.legacyBindingId
                    ? { bindingId: args.legacyBindingId }
                    : { arrangementScope: args.arrangementScope }),
                  itemId: item.id,
                  shipmentPlanId,
                  machineId: machine.id,
                  machineProfileId: profile.id,
                  machineCalibrationId: calibration.id,
                  quantity,
                  partsPerPlate,
                }),
              )
              .digest("hex");
            if (args.persistArrangementRevision !== false) {
              await this.prisma.arrangementRevision.upsert({
                where: { id: arrangementRevisionId },
                create: {
                  id: arrangementRevisionId,
                  contentSha256: arrangementContentSha256,
                },
                update: {},
              });
            }
            const inputBase = {
              geometry: {
                sourceModelFileId: item.sourceModelFile.id,
                sourceContentSha256: item.sourceModelFile.contentHash,
                modelGeometryId: item.modelGeometry.id,
                canonicalObjectKey: item.modelGeometry.canonicalObjectKey,
                geometrySha256: item.modelGeometry.geometryHash,
                bodyIds: source.bodyIds,
                selectionSha256: source.selectionSha256,
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
              shipmentPlanId,
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
            candidates.push({
              nodeId: machine.nodeId,
              inventoryId: inventory.id,
              availabilityRevisionId: machine.availabilitySelection.revisionId,
              availabilitySelectionVersion:
                machine.availabilitySelection.selectionVersion,
              identity,
              input: { ...inputBase, occupancySliceTargets },
            });
          }
        }
      }
    }
    return candidates;
  }
}
