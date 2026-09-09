import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  Material,
  Prisma,
  PrismaClient,
  PrintQuality,
  ProductionArtifactFormat,
  RevisionKind,
  RevisionState,
  MachineStatus,
  InventoryStatus,
} from "@prisma/client";
import {
  resourceRevisionDigest,
  type CanonicalJson,
} from "../src/modules/resources/resource-identity";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for seeding");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: databaseUrl }),
});
const at = new Date("2026-01-01T00:00:00.000Z");

const ids = {
  node: "11111111-1111-4111-8111-111111111111",
  capability: "22222222-2222-4222-8222-222222222222",
  machine: "33333333-3333-4333-8333-333333333333",
  inventoryPla: "44444444-4444-4444-8444-444444444444",
  inventoryPetg: "55555555-5555-4555-8555-555555555555",
  refPla: "61111111-1111-4111-8111-111111111111",
  refPetg: "62222222-2222-4222-8222-222222222222",
  machinePla: "71111111-1111-4111-8111-111111111111",
  machinePetg: "72222222-2222-4222-8222-222222222222",
  calibration: "83333333-3333-4333-8333-333333333333",
  print10: "91111111-1111-4111-8111-111111111111",
  print20: "92222222-2222-4222-8222-222222222222",
  print40: "93333333-3333-4333-8333-333333333333",
} as const;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
};
const jsonEqual = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const same = (actual: unknown, expected: unknown) =>
  actual instanceof Date && expected instanceof Date
    ? actual.getTime() === expected.getTime()
    : typeof actual === "bigint" || typeof expected === "bigint"
      ? String(actual) === String(expected)
      : jsonEqual(actual, expected);

async function revision<T extends RevisionKind>(
  tx: Prisma.TransactionClient,
  id: string,
  kind: T,
  payload: CanonicalJson,
  create: () => Promise<unknown>,
) {
  const expectedDigest = resourceRevisionDigest(kind, payload);
  const byId = await tx.revisionIdentity.findUnique({ where: { id } });
  const byDigest = await tx.revisionIdentity.findUnique({
    where: { digest: expectedDigest },
  });
  if (byDigest && byDigest.id !== id)
    throw new Error(
      `Seed revision digest ${expectedDigest} belongs to ${byDigest.id}`,
    );
  if (byId) {
    if (byId.kind !== kind || byId.digest !== expectedDigest)
      throw new Error(
        `Seed revision identity ${id} is immutable and does not match`,
      );
  } else {
    await tx.revisionIdentity.create({
      data: { id, kind, digest: expectedDigest, createdAt: at },
    });
  }
  await create();
}

async function main() {
  await prisma.$transaction(async (tx) => {
    const nodeData = {
      id: ids.node,
      code: "PRG-01",
      name: "Prague",
      timeZone: "Europe/Prague",
      active: true,
      createdAt: at,
      updatedAt: at,
    };
    const node = await tx.node.findUnique({ where: { id: ids.node } });
    if (node) {
      for (const key of ["code", "name", "timeZone", "active"] as const)
        if (!same(node[key], nodeData[key]))
          throw new Error(`Seed node ${ids.node} does not match`);
    } else await tx.node.create({ data: nodeData });

    const capData = {
      id: ids.capability,
      capabilityKey: "bambu-lab-h2s",
      manufacturer: "Bambu Lab",
      model: "H2S",
      buildVolumeXMicrometers: BigInt(340000),
      buildVolumeYMicrometers: BigInt(320000),
      buildVolumeZMicrometers: BigInt(340000),
      supportedNozzleMicrometers: [200, 400, 600, 800],
      supportedMaterials: [Material.PLA, Material.PETG],
      createdAt: at,
    };
    const cap = await tx.machineCapability.findUnique({
      where: { capabilityKey: capData.capabilityKey },
    });
    if (cap) {
      for (const key of [
        "id",
        "manufacturer",
        "model",
        "buildVolumeXMicrometers",
        "buildVolumeYMicrometers",
        "buildVolumeZMicrometers",
        "supportedNozzleMicrometers",
        "supportedMaterials",
      ] as const)
        if (!same(cap[key], capData[key]))
          throw new Error(`Seed machine capability does not match`);
    } else await tx.machineCapability.create({ data: capData });

    const machineData = {
      id: ids.machine,
      nodeId: ids.node,
      machineCapabilityId: ids.capability,
      code: "H2S-01",
      displayName: "Bambu Lab H2S",
      status: MachineStatus.ACTIVE,
      installedNozzleMicrometers: 400,
      createdAt: at,
      updatedAt: at,
    };
    const machine = await tx.machine.findUnique({ where: { id: ids.machine } });
    if (machine) {
      for (const key of [
        "nodeId",
        "machineCapabilityId",
        "code",
        "displayName",
        "status",
        "installedNozzleMicrometers",
      ] as const)
        if (!same(machine[key], machineData[key]))
          throw new Error(`Seed machine ${ids.machine} does not match`);
    } else await tx.machine.create({ data: machineData });

    for (const [id, material, sku] of [
      [ids.inventoryPla, Material.PLA, "PLA-NATURAL"],
      [ids.inventoryPetg, Material.PETG, "PETG-BLACK"],
    ] as const) {
      const data = {
        id,
        nodeId: ids.node,
        machineId: ids.machine,
        sku,
        material,
        vendor: "Bambu Lab",
        color: material === Material.PLA ? "Natural" : "Black",
        lotCode: "SEED-2026",
        priceMinorUnitsNumerator: BigInt(2500),
        priceMinorUnitsDenominator: BigInt(1000),
        currency: "CZK",
        remainingMilligrams: BigInt(1000000),
        reservedMilligrams: BigInt(0),
        status: InventoryStatus.AVAILABLE,
        createdAt: at,
        updatedAt: at,
      };
      const existing = await tx.inventory.findUnique({
        where: {
          nodeId_machineId_sku: {
            nodeId: ids.node,
            machineId: ids.machine,
            sku,
          },
        },
      });
      if (existing) {
        for (const key of [
          "id",
          "machineId",
          "material",
          "vendor",
          "color",
          "lotCode",
          "priceMinorUnitsNumerator",
          "priceMinorUnitsDenominator",
          "currency",
          "remainingMilligrams",
          "reservedMilligrams",
          "status",
        ] as const)
          if (!same(existing[key], data[key]))
            throw new Error(`Seed inventory ${sku} does not match`);
      } else await tx.inventory.create({ data });
    }

    const refs = [
      [ids.refPla, Material.PLA],
      [ids.refPetg, Material.PETG],
    ] as const;
    for (const [id, material] of refs) {
      const data = {
        id,
        material,
        quality: PrintQuality.STANDARD,
        slicerEngine: "orca-slicer",
        slicerVersion: "2.3.1",
        settings: { profile: "standard", material },
        state: RevisionState.ACTIVE,
        activatedAt: at,
        createdAt: at,
      };
      const revisionPayload = {
        material: data.material,
        quality: data.quality,
        settings: data.settings,
        slicerEngine: data.slicerEngine,
        slicerVersion: data.slicerVersion,
      } satisfies CanonicalJson;
      await revision(
        tx,
        id,
        RevisionKind.REFERENCE_PROFILE,
        revisionPayload,
        async () => {
          const existing = await tx.referenceProfile.findUnique({
            where: { id },
          });
          if (existing) {
            if (
              ![
                "material",
                "quality",
                "slicerEngine",
                "slicerVersion",
                "settings",
                "state",
                "activatedAt",
              ].every((k) =>
                same(
                  existing[k as keyof typeof existing],
                  data[k as keyof typeof data],
                ),
              )
            )
              throw new Error(`Seed reference profile ${id} does not match`);
          } else await tx.referenceProfile.create({ data });
        },
      );
    }

    for (const [id, material, referenceProfileId] of [
      [ids.machinePla, Material.PLA, ids.refPla],
      [ids.machinePetg, Material.PETG, ids.refPetg],
    ] as const) {
      const revisionPayload = {
        machineCapabilityId: ids.capability,
        referenceProfileId,
        material,
        quality: PrintQuality.STANDARD,
        nozzleDiameterMicrometers: 400,
        slicerEngine: "orca-slicer",
        slicerVersion: "2.3.1",
        settings: { profile: "standard", material, nozzle: 400 },
        productionArtifactFormat: ProductionArtifactFormat.GCODE_3MF,
      } satisfies CanonicalJson;
      const data = {
        id,
        ...revisionPayload,
        state: RevisionState.ACTIVE,
        activatedAt: at,
        createdAt: at,
      };
      await revision(
        tx,
        id,
        RevisionKind.MACHINE_PROFILE,
        revisionPayload,
        async () => {
          const existing = await tx.machineProfile.findUnique({
            where: { id },
          });
          if (existing) {
            if (
              ![
                "machineCapabilityId",
                "referenceProfileId",
                "material",
                "quality",
                "nozzleDiameterMicrometers",
                "slicerEngine",
                "slicerVersion",
                "productionArtifactFormat",
                "settings",
                "state",
                "activatedAt",
              ].every((k) =>
                same(
                  existing[k as keyof typeof existing],
                  data[k as keyof typeof data],
                ),
              )
            )
              throw new Error(`Seed machine profile ${id} does not match`);
          } else await tx.machineProfile.create({ data });
        },
      );
    }

    const calibrationPayload = {
      nodeId: ids.node,
      machineId: ids.machine,
      flowRatioPartsPerMillion: 1000000,
      xyCompensationMicrometers: 0,
      elephantFootCompensationMicrometers: 0,
      settings: { source: "seed" },
    } satisfies CanonicalJson;
    const calData = {
      id: ids.calibration,
      ...calibrationPayload,
      state: RevisionState.ACTIVE,
      activatedAt: at,
      createdAt: at,
    };
    await revision(
      tx,
      ids.calibration,
      RevisionKind.MACHINE_CALIBRATION,
      calibrationPayload,
      async () => {
        const existing = await tx.machineCalibration.findUnique({
          where: { id: ids.calibration },
        });
        if (existing) {
          if (
            ![
              "nodeId",
              "machineId",
              "flowRatioPartsPerMillion",
              "xyCompensationMicrometers",
              "elephantFootCompensationMicrometers",
              "settings",
              "state",
              "activatedAt",
            ].every((k) =>
              same(
                existing[k as keyof typeof existing],
                calData[k as keyof typeof calData],
              ),
            )
          )
            throw new Error("Seed machine calibration does not match");
        } else await tx.machineCalibration.create({ data: calData });
      },
    );

    for (const [id, infillPercent] of [
      [ids.print10, 10],
      [ids.print20, 20],
      [ids.print40, 40],
    ] as const) {
      const data = {
        id,
        quality: PrintQuality.STANDARD,
        infillPercent,
        layerHeightMicrometers: 200,
        supportsEnabled: false,
        brimEnabled: false,
        settings: { preset: `standard-${infillPercent}` },
        createdAt: at,
      };
      const revisionPayload = {
        quality: data.quality,
        infillPercent: data.infillPercent,
        layerHeightMicrometers: data.layerHeightMicrometers,
        supportsEnabled: data.supportsEnabled,
        brimEnabled: data.brimEnabled,
        settings: data.settings,
      } satisfies CanonicalJson;
      await revision(
        tx,
        id,
        RevisionKind.PRINT_CONFIG,
        revisionPayload,
        async () => {
          const existing = await tx.printConfigRevision.findUnique({
            where: { id },
          });
          if (existing) {
            if (
              ![
                "quality",
                "infillPercent",
                "layerHeightMicrometers",
                "supportsEnabled",
                "brimEnabled",
                "settings",
              ].every((k) =>
                same(
                  existing[k as keyof typeof existing],
                  data[k as keyof typeof data],
                ),
              )
            )
              throw new Error(
                `Seed print config ${infillPercent} does not match`,
              );
          } else await tx.printConfigRevision.create({ data });
        },
      );
    }
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
