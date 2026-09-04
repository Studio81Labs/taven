import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

type Sql = Pick<PoolClient, "query">;

export type PersistenceFoundation = {
  nodeId: string;
  machineId: string;
  inventoryId: string;
  modelFileId: string;
  modelGeometryId: string;
  modelGeometryIds: string[];
  sliceResultId: string;
  sliceResultIds: string[];
  referenceSliceResultId: string;
  referenceSliceResultIds: string[];
  referenceTailSliceResultId: string | null;
  referenceTailSliceResultIds: Array<string | null>;
  printConfigRevisionId: string;
  printConfigRevisionIds: string[];
  machineProfileId: string;
  machineCalibrationId: string;
  eligibilitySnapshotId: string;
  phaseResourcePlanId: string;
  phaseReservationSetId: string;
  customerId: string;
  quoteSessionId: string;
  quoteRequestId: string;
  quoteId: string;
  quoteItemId: string;
  quoteItemIds: string[];
  priceSnapshotId: string;
  priceSnapshotComponentIds: string[];
  paymentScheduleId: string;
  orderId: string;
  automaticOrderOriginId: string;
  deliveryDestinationId: string;
  orderPriceBindingId: string;
  orderItemId: string;
  orderItemIds: string[];
  orderPhaseId: string;
  shipmentPlanId: string;
  shipmentPlanIds: string[];
  shipmentId: string;
  shipmentIds: string[];
  fulfilmentSlotId: string;
  fulfilmentSlotIds: string[];
  fulfilmentSlotShipmentPlanIds: string[];
  fulfilmentSlotModelGeometryIds: string[];
  fulfilmentSlotSliceResultIds: string[];
  fulfilmentSlotPrintConfigRevisionIds: string[];
  fulfilmentSlotPartsPerPlate: number[];
  fulfilmentSlotQuantities: number[];
  paymentId: string;
};

export type ProductionReservationFixture = {
  candidateResourceEstimateId: string;
  phaseResourcePlanJobId: string;
  plannedJobKey: string;
  fulfilmentSlotId: string;
  shipmentPlanId: string;
  jobId: string;
  productionReservationId: string;
  inventoryReservationId: string;
  candidateCapacityIntervalId: string;
  candidateCapacityIntervalIds: string[];
  requiredMaterialMilligrams: number;
  requiredMachineSeconds: number;
};

export type AutomaticCheckoutFixtureOptions = Readonly<{
  publicTokenHash: string;
  configurationRevision?: number;
  expressRequested?: boolean;
}>;

type CapacityInterval = { startsAt: Date; endsAt: Date };
export type SourceRetention = {
  uploadedAt?: Date;
  deleteAfter?: Date;
  hold?: "NONE" | "ACTIVE_ORDER" | "ACTIVE_CLAIM" | "LEGAL";
  quoteExpiresAt?: Date;
};
export type ReservationTiming = {
  createdAt: Date;
  expiresAt: Date;
};
export type GeometryBounds = {
  xMicrometers: number;
  yMicrometers: number;
  zMicrometers: number;
};
export type SliceMetrics = {
  partsPerPlate: number;
  estimatedPrintSeconds: number;
  estimatedMaterialMilligrams: number;
};
export type CandidateOccupancyPlan = {
  partsPerPlate?: number;
  tailSliceResultId?: string | null;
};
export type CommerceItem = {
  quantity?: number;
  color?: string;
  geometryBounds?: GeometryBounds;
  sliceMetrics?: SliceMetrics;
  priced?: boolean;
};
type CommercePricing = {
  orderMinimum?: number;
  priceListRevision?: string;
  smallSurcharge?: number;
};

const defaultGeometryBounds: GeometryBounds = {
  xMicrometers: 1,
  yMicrometers: 1,
  zMicrometers: 1,
};
const defaultBuildVolume: GeometryBounds = {
  xMicrometers: 200_000,
  yMicrometers: 200_000,
  zMicrometers: 200_000,
};
const defaultSliceMetrics: SliceMetrics = {
  partsPerPlate: 1,
  estimatedPrintSeconds: 60,
  estimatedMaterialMilligrams: 60,
};

const hourInMilliseconds = 60 * 60 * 1_000;
const dayInMilliseconds = 24 * hourInMilliseconds;
const testRunStartedAt = Date.now();
export const testTimes = Object.freeze({
  beforeCreatedAt: new Date(testRunStartedAt - dayInMilliseconds - 1_000),
  createdAt: new Date(testRunStartedAt - dayInMilliseconds),
  capacityStart: new Date(testRunStartedAt + 7 * dayInMilliseconds),
  capacityHalfHour: new Date(
    testRunStartedAt + 7 * dayInMilliseconds + hourInMilliseconds / 2,
  ),
  capacityEnd: new Date(
    testRunStartedAt + 7 * dayInMilliseconds + hourInMilliseconds,
  ),
  capacityOneAndHalfHours: new Date(
    testRunStartedAt + 7 * dayInMilliseconds + 1.5 * hourInMilliseconds,
  ),
  capacityTwoHours: new Date(
    testRunStartedAt + 7 * dayInMilliseconds + 2 * hourInMilliseconds,
  ),
  beforeExpiresAt: new Date(
    testRunStartedAt + 365 * dayInMilliseconds - hourInMilliseconds,
  ),
  expiresAt: new Date(testRunStartedAt + 365 * dayInMilliseconds),
  afterExpiresAt: new Date(testRunStartedAt + 365 * dayInMilliseconds + 1_000),
});
const createdAt = testTimes.createdAt;
const expiresAt = testTimes.expiresAt;
const digest = "a".repeat(64);

/**
 * Builds a complete commerce and node-scoped reservation graph. IDs are stable
 * for a supplied scope so assertions can name the exact aggregate topology.
 */
export class PersistenceFactory {
  constructor(
    private readonly sql: Sql,
    private readonly scope: string,
    private readonly automaticCheckout?: AutomaticCheckoutFixtureOptions,
  ) {}

  id(name: string): string {
    const hex = createHash("sha256")
      .update(`${this.scope}:${name}`)
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }

  async createFoundation(
    name = "foundation",
    sourceRetention: SourceRetention = {},
    geometryBounds: GeometryBounds = defaultGeometryBounds,
    buildVolume: GeometryBounds = defaultBuildVolume,
    sliceMetrics: SliceMetrics = defaultSliceMetrics,
    slotCount = 1,
    commerceItems?: CommerceItem[],
    finalOrderStatus: "DRAFT" | "QUOTED" = "QUOTED",
    beforeOrderPricing?: (foundation: PersistenceFoundation) => Promise<void>,
    pricing: CommercePricing = {},
    orderOrigin: "AUTOMATIC" | "INDIVIDUAL" = "AUTOMATIC",
    includeActivePriceBinding = true,
    customerOwned = true,
    includeShipments = true,
    paymentScheduleKind?: "FULL" | "DEPOSIT_BALANCE",
  ): Promise<PersistenceFoundation> {
    if (!customerOwned && orderOrigin !== "AUTOMATIC") {
      throw new Error("only automatic foundations may begin anonymously");
    }

    const items: CommerceItem[] =
      commerceItems ?? Array.from({ length: slotCount }, () => ({}));
    if (items.length < 1) {
      throw new Error("a commerce foundation requires at least one slot");
    }
    const resolvedItems = items.map((item) => ({
      color: item.color ?? "red",
      geometryBounds: item.geometryBounds ?? geometryBounds,
      priced: item.priced ?? true,
      quantity: item.quantity ?? 1,
      sliceMetrics: item.sliceMetrics ?? sliceMetrics,
    }));
    if (resolvedItems.some((item) => item.quantity < 1)) {
      throw new Error("a commerce item requires a positive quantity");
    }
    const nodeId = this.id(`${name}:node`);
    const capabilityId = this.id(`${name}:capability`);
    const machineId = this.id(`${name}:machine`);
    const inventoryId = this.id(`${name}:inventory`);
    const modelFileId = this.id(`${name}:model-file`);
    let referenceProfileId = this.id(`${name}:reference-profile`);
    let referenceSlicerEngine: string;
    let referenceSlicerVersion: string;
    const machineProfileId = this.id(`${name}:machine-profile`);
    const machineCalibrationId = this.id(`${name}:machine-calibration`);
    const eligibilitySnapshotId = this.id(`${name}:eligibility-snapshot`);
    const phaseResourcePlanId = this.id(`${name}:phase-resource-plan`);
    const phaseReservationSetId = this.id(`${name}:phase-reservation-set`);
    const customerId = this.id(`${name}:customer`);
    const quoteSessionId = this.id(`${name}:quote-session`);
    const quoteRequestId = this.id(`${name}:quote-request`);
    const quoteId = this.id(`${name}:quote`);
    const quoteItemIds = resolvedItems.map((_, index) =>
      this.id(`${name}:quote-item:${index}`),
    );
    const quoteItemId = quoteItemIds[0]!;
    const priceSnapshotId = this.id(`${name}:price-snapshot`);
    const paymentScheduleId = this.id(`${name}:payment-schedule`);
    const orderId = this.id(`${name}:order`);
    const deliveryDestinationId = this.id(`${name}:delivery-destination`);
    const orderPriceBindingId = this.id(`${name}:order-price-binding`);
    const orderItemIds = resolvedItems.map((_, index) =>
      this.id(`${name}:order-item:${index}`),
    );
    const orderItemId = orderItemIds[0]!;
    const orderPhaseId = this.id(`${name}:order-phase`);
    const shipmentPlanIds = resolvedItems.map((_, index) =>
      this.id(`${name}:shipment-plan:${index}`),
    );
    const shipmentPlanId = shipmentPlanIds[0]!;
    const shipmentIds = resolvedItems.map((_, index) =>
      this.id(`${name}:shipment:${index}`),
    );
    const shipmentId = shipmentIds[0]!;
    const modelGeometryIds = resolvedItems.map((_, index) =>
      this.id(index === 0 ? `${name}:geometry` : `${name}:geometry:${index}`),
    );
    const printConfigRevisionIds = resolvedItems.map((_, index) =>
      this.id(
        index === 0 ? `${name}:print-config` : `${name}:print-config:${index}`,
      ),
    );
    const sliceResultIds = resolvedItems.map((_, index) =>
      this.id(
        index === 0 ? `${name}:slice-result` : `${name}:slice-result:${index}`,
      ),
    );
    const referenceSliceResultIds = resolvedItems.map((_, index) =>
      this.id(
        index === 0
          ? `${name}:reference-slice-result`
          : `${name}:reference-slice-result:${index}`,
      ),
    );
    const referenceTailSliceResultIds = resolvedItems.map((item, index) => {
      const remainder = item.quantity % item.sliceMetrics.partsPerPlate;
      return item.quantity >= item.sliceMetrics.partsPerPlate && remainder > 0
        ? this.id(`${name}:reference-tail-slice-result:${index}`)
        : null;
    });
    const fulfilmentSlotIds: string[] = [];
    const fulfilmentSlotShipmentPlanIds: string[] = [];
    const fulfilmentSlotModelGeometryIds: string[] = [];
    const fulfilmentSlotSliceResultIds: string[] = [];
    const fulfilmentSlotPrintConfigRevisionIds: string[] = [];
    const fulfilmentSlotPartsPerPlate: number[] = [];
    const fulfilmentSlotQuantities: number[] = [];
    for (const [itemIndex, item] of resolvedItems.entries()) {
      for (
        let quantityOrdinal = 1;
        quantityOrdinal <= item.quantity;
        quantityOrdinal += 1
      ) {
        fulfilmentSlotIds.push(
          this.id(`${name}:fulfilment-slot:${itemIndex}:${quantityOrdinal}`),
        );
        fulfilmentSlotShipmentPlanIds.push(shipmentPlanIds[itemIndex]!);
        fulfilmentSlotModelGeometryIds.push(modelGeometryIds[itemIndex]!);
        fulfilmentSlotSliceResultIds.push(sliceResultIds[itemIndex]!);
        fulfilmentSlotPrintConfigRevisionIds.push(
          printConfigRevisionIds[itemIndex]!,
        );
        fulfilmentSlotPartsPerPlate.push(item.sliceMetrics.partsPerPlate);
        fulfilmentSlotQuantities.push(1);
      }
    }
    const fulfilmentSlotId = fulfilmentSlotIds[0]!;
    const paymentId = this.id(`${name}:payment`);

    await this.sql.query(
      'INSERT INTO "nodes" ("id", "code", "name", "time_zone", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6)',
      [
        nodeId,
        `node-${this.hash(`${name}:node-code`).slice(0, 24)}`,
        "Test node",
        "UTC",
        createdAt,
        createdAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "machine_capabilities" ("id", "capability_key", "manufacturer", "model", "build_volume_x_micrometers", "build_volume_y_micrometers", "build_volume_z_micrometers", "supported_nozzle_micrometers", "supported_materials") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        capabilityId,
        `capability-${this.hash(`${name}:capability-key`).slice(0, 32)}`,
        "Test manufacturer",
        "Test model",
        buildVolume.xMicrometers,
        buildVolume.yMicrometers,
        buildVolume.zMicrometers,
        [400, 600],
        ["PLA"],
      ],
    );
    await this.sql.query(
      'INSERT INTO "machines" ("id", "node_id", "machine_capability_id", "code", "display_name", "installed_nozzle_micrometers", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        machineId,
        nodeId,
        capabilityId,
        `machine-${name}`,
        "Test machine",
        400,
        createdAt,
        createdAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "inventories" ("id", "node_id", "machine_id", "sku", "material", "color", "vendor", "price_minor_units_numerator", "price_minor_units_denominator", "currency", "remaining_milligrams", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
      [
        inventoryId,
        nodeId,
        machineId,
        `sku-${this.hash(`${name}:sku`).slice(0, 32)}`,
        "PLA",
        resolvedItems[0]!.color,
        "Test vendor",
        1,
        1,
        "EUR",
        100,
        createdAt,
        createdAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "model_files" ("id", "format", "original_filename", "storage_object_key", "content_hash", "size_bytes", "uploaded_at", "source_delete_after", "retention_hold") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        modelFileId,
        "STL",
        "test.stl",
        `models/${this.scope}/${name}.stl`,
        digest,
        1,
        sourceRetention.uploadedAt ?? createdAt,
        sourceRetention.deleteAfter ?? expiresAt,
        sourceRetention.hold ?? "NONE",
      ],
    );
    const activeReferenceProfile = await this.sql.query<{
      id: string;
      slicer_engine: string;
      slicer_version: string;
    }>(
      'SELECT "id", "slicer_engine", "slicer_version" FROM "reference_profiles" WHERE "material" = $1 AND "quality" = $2 AND "state" = $3',
      ["PLA", "STANDARD", "ACTIVE"],
    );
    if (activeReferenceProfile.rows[0]) {
      referenceProfileId = activeReferenceProfile.rows[0].id;
      referenceSlicerEngine = activeReferenceProfile.rows[0].slicer_engine;
      referenceSlicerVersion = activeReferenceProfile.rows[0].slicer_version;
    } else {
      const candidateReferenceProfileId = referenceProfileId;
      await this.createRevisionIdentity(
        candidateReferenceProfileId,
        "REFERENCE_PROFILE",
      );
      await this.sql.query(
        'INSERT INTO "reference_profiles" ("id", "material", "quality", "slicer_engine", "slicer_version", "settings", "state", "activated_at", "created_at") VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8) ON CONFLICT DO NOTHING',
        [
          candidateReferenceProfileId,
          "PLA",
          "STANDARD",
          "orca",
          "test",
          JSON.stringify({}),
          "ACTIVE",
          createdAt,
        ],
      );
      const resolvedReferenceProfile = await this.sql.query<{
        id: string;
        slicer_engine: string;
        slicer_version: string;
      }>(
        'SELECT "id", "slicer_engine", "slicer_version" FROM "reference_profiles" WHERE "material" = $1 AND "quality" = $2 AND "state" = $3',
        ["PLA", "STANDARD", "ACTIVE"],
      );
      if (!resolvedReferenceProfile.rows[0]) {
        throw new Error("an active PLA/STANDARD reference profile is required");
      }
      referenceProfileId = resolvedReferenceProfile.rows[0].id;
      referenceSlicerEngine = resolvedReferenceProfile.rows[0].slicer_engine;
      referenceSlicerVersion = resolvedReferenceProfile.rows[0].slicer_version;
    }
    await this.createRevisionIdentity(machineProfileId, "MACHINE_PROFILE");
    await this.sql.query(
      'INSERT INTO "machine_profiles" ("id", "machine_capability_id", "reference_profile_id", "material", "quality", "nozzle_diameter_micrometers", "slicer_engine", "slicer_version", "production_artifact_format", "settings", "state", "activated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)',
      [
        machineProfileId,
        capabilityId,
        referenceProfileId,
        "PLA",
        "STANDARD",
        400,
        "orca",
        "test",
        "gcode_3mf",
        JSON.stringify({}),
        "ACTIVE",
        createdAt,
      ],
    );
    await this.createRevisionIdentity(
      machineCalibrationId,
      "MACHINE_CALIBRATION",
    );
    await this.sql.query(
      'INSERT INTO "machine_calibrations" ("id", "node_id", "machine_id", "flow_ratio_parts_per_million", "xy_compensation_micrometers", "elephant_foot_compensation_micrometers", "settings", "state", "activated_at") VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)',
      [
        machineCalibrationId,
        nodeId,
        machineId,
        1_000_000,
        0,
        0,
        JSON.stringify({}),
        "ACTIVE",
        createdAt,
      ],
    );
    for (const [index, item] of resolvedItems.entries()) {
      const itemGeometryId = modelGeometryIds[index]!;
      const configId = printConfigRevisionIds[index]!;
      const itemSliceResultId = sliceResultIds[index]!;
      const itemReferenceSliceResultId = referenceSliceResultIds[index]!;
      const itemReferenceTailSliceResultId = referenceTailSliceResultIds[index];
      const referencePrimaryPartsPerPlate = Math.min(
        item.quantity,
        item.sliceMetrics.partsPerPlate,
      );
      await this.sql.query(
        'INSERT INTO "model_geometries" ("id", "source_model_file_id", "canonical_object_key", "geometry_hash", "canonicalizer_revision", "volume_cubic_micrometers", "bounds_x_micrometers", "bounds_y_micrometers", "bounds_z_micrometers", "triangle_count") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [
          itemGeometryId,
          modelFileId,
          `geometries/${itemGeometryId}/canonical`,
          this.hash(`${name}:geometry:${index}`),
          "test-canonicalizer",
          1,
          item.geometryBounds.xMicrometers,
          item.geometryBounds.yMicrometers,
          item.geometryBounds.zMicrometers,
          1,
        ],
      );
      await this.createRevisionIdentity(configId, "PRINT_CONFIG");
      await this.sql.query(
        'INSERT INTO "print_config_revisions" ("id", "quality", "infill_percent", "layer_height_micrometers", "settings") VALUES ($1, $2, $3, $4, $5::jsonb)',
        [
          configId,
          "STANDARD",
          20 + index,
          200,
          JSON.stringify({ itemIndex: index }),
        ],
      );
      await this.sql.query(
        'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "reference_profile_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
        [
          itemReferenceSliceResultId,
          "REFERENCE",
          `reference-slice-${this.scope}-${name}-${index}`,
          itemGeometryId,
          configId,
          referenceProfileId,
          referencePrimaryPartsPerPlate,
          `reference-slices/${this.scope}/${name}/${index}`,
          this.hash(`${name}:reference-slice:${index}`),
          item.sliceMetrics.estimatedPrintSeconds,
          item.sliceMetrics.estimatedMaterialMilligrams,
          referenceSlicerEngine,
          referenceSlicerVersion,
        ],
      );
      if (itemReferenceTailSliceResultId) {
        const tailPartsPerPlate =
          item.quantity % item.sliceMetrics.partsPerPlate;
        await this.sql.query(
          'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "reference_profile_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)',
          [
            itemReferenceTailSliceResultId,
            "REFERENCE",
            `reference-tail-slice-${this.scope}-${name}-${index}`,
            itemGeometryId,
            configId,
            referenceProfileId,
            tailPartsPerPlate,
            `reference-slices/${this.scope}/${name}/${index}-tail`,
            this.hash(`${name}:reference-tail-slice:${index}`),
            Math.max(
              1,
              Math.ceil(
                (item.sliceMetrics.estimatedPrintSeconds * tailPartsPerPlate) /
                  item.sliceMetrics.partsPerPlate,
              ),
            ),
            Math.max(
              1,
              Math.ceil(
                (item.sliceMetrics.estimatedMaterialMilligrams *
                  tailPartsPerPlate) /
                  item.sliceMetrics.partsPerPlate,
              ),
            ),
            referenceSlicerEngine,
            referenceSlicerVersion,
          ],
        );
      }
      await this.sql.query(
        'INSERT INTO "slice_results" ("id", "kind", "cache_key", "model_geometry_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "arrangement_revision_id", "parts_per_plate", "artifact_object_key", "artifact_hash", "estimated_print_seconds", "estimated_material_milligrams", "slicer_engine", "slicer_version") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
        [
          itemSliceResultId,
          "ANALYSIS",
          `machine-occupancy-slice-${this.scope}-${name}-${index}`,
          itemGeometryId,
          configId,
          machineProfileId,
          machineCalibrationId,
          this.id(`${name}:arrangement-revision:${index}`),
          item.sliceMetrics.partsPerPlate,
          `slice-metrics/${this.hash(`${name}:occupancy:${index}`)}/result.json`,
          this.hash(`${name}:slice:${index}`),
          item.sliceMetrics.estimatedPrintSeconds,
          item.sliceMetrics.estimatedMaterialMilligrams,
          "orca",
          "test",
        ],
      );
    }
    const foundation: PersistenceFoundation = {
      nodeId,
      machineId,
      inventoryId,
      modelFileId,
      modelGeometryId: modelGeometryIds[0]!,
      modelGeometryIds,
      sliceResultId: sliceResultIds[0]!,
      sliceResultIds,
      referenceSliceResultId: referenceSliceResultIds[0]!,
      referenceSliceResultIds,
      referenceTailSliceResultId: referenceTailSliceResultIds[0] ?? null,
      referenceTailSliceResultIds,
      printConfigRevisionId: printConfigRevisionIds[0]!,
      printConfigRevisionIds,
      machineProfileId,
      machineCalibrationId,
      eligibilitySnapshotId,
      phaseResourcePlanId,
      phaseReservationSetId,
      customerId,
      quoteSessionId,
      quoteRequestId,
      quoteId,
      quoteItemId,
      quoteItemIds,
      priceSnapshotId,
      priceSnapshotComponentIds: this.componentIds(name, resolvedItems),
      paymentScheduleId,
      orderId,
      automaticOrderOriginId: orderId,
      deliveryDestinationId,
      orderPriceBindingId,
      orderItemId,
      orderItemIds,
      orderPhaseId,
      shipmentPlanId,
      shipmentPlanIds,
      shipmentId,
      shipmentIds,
      fulfilmentSlotId,
      fulfilmentSlotIds,
      fulfilmentSlotShipmentPlanIds,
      fulfilmentSlotModelGeometryIds,
      fulfilmentSlotSliceResultIds,
      fulfilmentSlotPrintConfigRevisionIds,
      fulfilmentSlotPartsPerPlate,
      fulfilmentSlotQuantities,
      paymentId,
    };
    await this.createCommerceTopology({
      name,
      customerId,
      quoteSessionId,
      quoteRequestId,
      quoteId,
      orderId,
      orderPhaseId,
      modelFileId,
      deliveryDestinationId,
      orderPriceBindingId,
      quoteItemIds,
      orderItemIds,
      shipmentPlanIds,
      shipmentIds,
      fulfilmentSlotIds,
      modelGeometryIds,
      printConfigRevisionIds,
      referenceSliceResultIds,
      referenceTailSliceResultIds,
      resolvedItems,
      quoteSessionExpiresAt: new Date(testRunStartedAt + hourInMilliseconds),
      quoteExpiresAt:
        sourceRetention.quoteExpiresAt ??
        new Date(testRunStartedAt + hourInMilliseconds),
      finalOrderStatus,
      pricing,
      orderOrigin,
      includeActivePriceBinding,
      customerOwned,
      includeShipments,
      paymentScheduleKind:
        paymentScheduleKind ??
        (orderOrigin === "INDIVIDUAL" ? "DEPOSIT_BALANCE" : "FULL"),
      ...(this.automaticCheckout
        ? { automaticCheckout: this.automaticCheckout }
        : {}),
      ...(beforeOrderPricing === undefined
        ? {}
        : {
            beforeOrderPricing: () => beforeOrderPricing(foundation),
          }),
    });
    return foundation;
  }

  private async createCommerceTopology(input: {
    name: string;
    customerId: string;
    quoteSessionId: string;
    quoteRequestId: string;
    quoteId: string;
    orderId: string;
    orderPhaseId: string;
    modelFileId: string;
    deliveryDestinationId: string;
    orderPriceBindingId: string;
    quoteItemIds: string[];
    orderItemIds: string[];
    shipmentPlanIds: string[];
    shipmentIds: string[];
    fulfilmentSlotIds: string[];
    modelGeometryIds: string[];
    printConfigRevisionIds: string[];
    referenceSliceResultIds: string[];
    referenceTailSliceResultIds: Array<string | null>;
    resolvedItems: Array<{
      color: string;
      geometryBounds: GeometryBounds;
      priced: boolean;
      quantity: number;
      sliceMetrics: SliceMetrics;
    }>;
    quoteSessionExpiresAt: Date;
    quoteExpiresAt: Date;
    finalOrderStatus: "DRAFT" | "QUOTED";
    pricing: CommercePricing;
    orderOrigin: "AUTOMATIC" | "INDIVIDUAL";
    includeActivePriceBinding: boolean;
    customerOwned: boolean;
    includeShipments: boolean;
    paymentScheduleKind: "FULL" | "DEPOSIT_BALANCE";
    automaticCheckout?: AutomaticCheckoutFixtureOptions;
    beforeOrderPricing?: () => Promise<void>;
  }): Promise<void> {
    const t = createdAt;
    const quoteIssuedAt = new Date(
      Math.min(t.getTime(), input.quoteExpiresAt.getTime() - 1),
    );
    const quoteRequestCreatedAt = quoteIssuedAt;
    const snapshotId = this.id(`${input.name}:price-snapshot`);
    const scheduleId = this.id(`${input.name}:payment-schedule`);
    const componentIds = this.componentIds(input.name, input.resolvedItems);
    const componentAmounts = input.resolvedItems.map((item) =>
      item.priced
        ? {
            production: 500 * item.quantity,
            quantity: 100 * item.quantity,
            postprocessing: 25 * item.quantity,
            shipment: 50,
          }
        : { production: 0, quantity: 0, postprocessing: 0, shipment: 0 },
    );
    const orderMinimum = input.pricing.orderMinimum ?? 200;
    const smallSurcharge = input.pricing.smallSurcharge ?? 100;
    const priceListRevision =
      input.pricing.priceListRevision ?? "legacy-v0-eur";
    const contractTotal =
      componentAmounts.reduce(
        (total, amount) =>
          total +
          amount.production +
          amount.quantity +
          amount.postprocessing +
          amount.shipment,
        0,
      ) +
      orderMinimum +
      smallSurcharge;
    await this.sql.query(
      "INSERT INTO customers (id, email, display_name, first_seen_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$4,$4)",
      [
        input.customerId,
        `${this.hash(input.name).slice(0, 24)}@example.test`,
        "Test customer",
        t,
      ],
    );
    await this.sql.query(
      "INSERT INTO quote_sessions (id, customer_id, public_token_hash, expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
      [
        input.quoteSessionId,
        input.customerOwned ? input.customerId : null,
        input.automaticCheckout?.publicTokenHash ??
          this.hash(`${input.name}:token`),
        input.quoteSessionExpiresAt,
        t,
      ],
    );
    if (input.customerOwned) {
      await this.sql.query(
        "INSERT INTO quote_requests (id, quote_session_id, customer_id, status, created_at, updated_at) VALUES ($1,$2,$3,'NEW',$4,$4)",
        [
          input.quoteRequestId,
          input.quoteSessionId,
          input.customerId,
          quoteRequestCreatedAt,
        ],
      );
      await this.sql.query(
        "UPDATE quote_requests SET status = 'IN_REVIEW', updated_at = $2 WHERE id = $1",
        [input.quoteRequestId, t],
      );
      await this.sql.query(
        "UPDATE quote_requests SET status = 'QUOTED', updated_at = $2 WHERE id = $1",
        [input.quoteRequestId, t],
      );
      await this.sql.query(
        "INSERT INTO quotes (id, quote_request_id, customer_id, expires_at, issued_at, created_at) VALUES ($1,$2,$3,$4,$5,$5)",
        [
          input.quoteId,
          input.quoteRequestId,
          input.customerId,
          input.quoteExpiresAt,
          quoteIssuedAt,
        ],
      );
      for (const [index, item] of input.resolvedItems.entries()) {
        await this.sql.query(
          "INSERT INTO quote_items (id, quote_id, ordinal, source_model_file_id, model_geometry_id, print_config_revision_id, material, color, quantity, created_at) VALUES ($1,$2,$3,$4,$5,$6,'PLA',$7,$8,$9)",
          [
            input.quoteItemIds[index],
            input.quoteId,
            index,
            input.modelFileId,
            input.modelGeometryIds[index],
            input.printConfigRevisionIds[index],
            item.color,
            item.quantity,
            t,
          ],
        );
      }
    }
    await this.sql.query(
      "INSERT INTO price_snapshots (id, price_list_id, currency, contract_total_minor, pricing_revision, input_snapshot, snapshot_hash, created_at) VALUES ($1,(SELECT id FROM price_lists WHERE currency = $2 AND revision = $4),$2,$3,$4,$5::jsonb,$6,$7)",
      [
        snapshotId,
        "EUR",
        contractTotal,
        priceListRevision,
        JSON.stringify(
          input.automaticCheckout
            ? {
                automaticQuote: {
                  configurationRevision:
                    input.automaticCheckout.configurationRevision ?? 1,
                  expressRequested:
                    input.automaticCheckout.expressRequested ?? false,
                },
              }
            : {},
        ),
        this.hash(`${input.name}:snapshot`),
        t,
      ],
    );
    if (input.customerOwned) {
      await this.sql.query(
        "INSERT INTO quote_price_bindings (quote_id, price_snapshot_id) VALUES ($1,$2)",
        [input.quoteId, snapshotId],
      );
    }
    await this.sql.query(
      "INSERT INTO orders (id, customer_id, public_reference, status, created_at, updated_at) VALUES ($1,$2,$3,'DRAFT',$4,$4)",
      [
        input.orderId,
        input.customerOwned ? input.customerId : null,
        `T-${this.hash(input.name).slice(0, 12)}`,
        t,
      ],
    );
    if (input.orderOrigin === "AUTOMATIC") {
      await this.sql.query(
        "INSERT INTO automatic_order_origins (order_id, quote_session_id) VALUES ($1,$2)",
        [input.orderId, input.quoteSessionId],
      );
    }
    await this.sql.query(
      "INSERT INTO delivery_destinations (id, order_id, provider_endpoint_id, endpoint_type, address_snapshot, capability_snapshot, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)",
      [
        input.deliveryDestinationId,
        input.orderId,
        `endpoint-${this.hash(input.name).slice(0, 16)}`,
        "address",
        JSON.stringify({ country: "CZ" }),
        JSON.stringify({ service: "standard" }),
        t,
      ],
    );
    if (input.automaticCheckout) {
      if (input.orderOrigin !== "AUTOMATIC") {
        throw new Error("automatic checkout fixture requires automatic origin");
      }
      await this.sql.query(
        `INSERT INTO automatic_quote_drafts
           (order_id, selected_delivery_destination_id, express_requested,
            configuration_revision, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$5)`,
        [
          input.orderId,
          input.deliveryDestinationId,
          input.automaticCheckout.expressRequested ?? false,
          input.automaticCheckout.configurationRevision ?? 1,
          t,
        ],
      );
    }
    for (const [index, item] of input.resolvedItems.entries()) {
      await this.sql.query(
        "INSERT INTO order_items (id, order_id, ordinal, source_model_file_id, model_geometry_id, print_config_revision_id, reference_slice_result_id, tail_reference_slice_result_id, reference_parts_per_plate, material, color, quantity, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PLA',$10,$11,$12)",
        [
          input.orderItemIds[index],
          input.orderId,
          index,
          input.modelFileId,
          input.modelGeometryIds[index],
          input.printConfigRevisionIds[index],
          input.orderOrigin === "AUTOMATIC"
            ? input.referenceSliceResultIds[index]
            : null,
          input.orderOrigin === "AUTOMATIC"
            ? input.referenceTailSliceResultIds[index]
            : null,
          input.orderOrigin === "AUTOMATIC"
            ? item.sliceMetrics.partsPerPlate
            : null,
          item.color,
          item.quantity,
          t,
        ],
      );
    }
    await input.beforeOrderPricing?.();
    await this.sql.query(
      "INSERT INTO order_price_bindings (id, order_id, price_snapshot_id, delivery_destination_id, created_at) VALUES ($1,$2,$3,$4,$5)",
      [
        input.orderPriceBindingId,
        input.orderId,
        snapshotId,
        input.deliveryDestinationId,
        t,
      ],
    );
    if (input.includeActivePriceBinding) {
      await this.sql.query(
        "INSERT INTO order_active_price_bindings (order_id, order_price_binding_id) VALUES ($1,$2)",
        [input.orderId, input.orderPriceBindingId],
      );
    }
    await this.sql.query(
      "INSERT INTO order_phases (id, order_id, kind, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
      [input.orderPhaseId, input.orderId, "SINGLE", "QUOTED", t],
    );
    for (const [index] of input.resolvedItems.entries()) {
      await this.sql.query(
        "INSERT INTO shipment_plans (id, order_id, order_phase_id, price_snapshot_id, order_price_binding_id, delivery_destination_id, ordinal, category, planned_volume_cubic_mm, planned_weight_milligrams, shipping_amount_minor, packaging_amount_minor, handling_amount_minor, allocation_snapshot, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,1,$9,0,0,$10::jsonb,$11)",
        [
          input.shipmentPlanIds[index],
          input.orderId,
          input.orderPhaseId,
          snapshotId,
          input.orderPriceBindingId,
          input.deliveryDestinationId,
          index,
          "standard",
          componentAmounts[index]!.shipment,
          JSON.stringify({}),
          t,
        ],
      );
      if (input.includeShipments) {
        await this.sql.query(
          "INSERT INTO shipments (id, order_id, order_phase_id, shipment_plan_id, delivery_destination_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
          [
            input.shipmentIds[index],
            input.orderId,
            input.orderPhaseId,
            input.shipmentPlanIds[index],
            input.deliveryDestinationId,
            t,
          ],
        );
      }
    }
    let slotIndex = 0;
    for (const [itemIndex, item] of input.resolvedItems.entries()) {
      const itemSlots = input.fulfilmentSlotIds.slice(
        slotIndex,
        slotIndex + item.quantity,
      );
      const settlementBase =
        componentAmounts[itemIndex]!.production +
        componentAmounts[itemIndex]!.quantity +
        componentAmounts[itemIndex]!.postprocessing +
        componentAmounts[itemIndex]!.shipment;
      for (const [quantityIndex, fulfilmentSlotId] of itemSlots.entries()) {
        const orderSupplement =
          slotIndex === 0 && quantityIndex === 0
            ? orderMinimum + smallSurcharge
            : 0;
        const settlementAmount =
          quantityIndex === 0 ? settlementBase + orderSupplement : 0;
        await this.sql.query(
          "INSERT INTO fulfilment_slots (id, order_id, order_phase_id, order_item_id, quantity_ordinal, settlement_amount_minor, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)",
          [
            fulfilmentSlotId,
            input.orderId,
            input.orderPhaseId,
            input.orderItemIds[itemIndex],
            quantityIndex + 1,
            settlementAmount,
            t,
          ],
        );
        await this.sql.query(
          "INSERT INTO shipment_plan_fulfilment_slots (shipment_plan_id, order_price_binding_id, fulfilment_slot_id) VALUES ($1,$2,$3)",
          [
            input.shipmentPlanIds[itemIndex],
            input.orderPriceBindingId,
            fulfilmentSlotId,
          ],
        );
      }
      slotIndex += item.quantity;
      const productionComponentId = componentIds[itemIndex * 4]!;
      const quantityComponentId = componentIds[itemIndex * 4 + 1]!;
      const postprocessingComponentId = componentIds[itemIndex * 4 + 2]!;
      const shipmentComponentId = componentIds[itemIndex * 4 + 3]!;
      if (item.priced) {
        if (input.orderOrigin === "INDIVIDUAL") {
          await this.sql.query(
            "INSERT INTO price_snapshot_components (id, price_snapshot_id, kind, scope, quote_item_id, amount_minor, allocation, created_at) VALUES ($1,$2,'ITEM_PRODUCTION','QUOTE_ITEM',$3,$4,$5::jsonb,$6),($7,$2,'ITEM_QUANTITY','QUOTE_ITEM',$3,$8,$5::jsonb,$6),($9,$2,'ITEM_POSTPROCESSING','QUOTE_ITEM',$3,$10,$5::jsonb,$6)",
            [
              productionComponentId,
              snapshotId,
              input.quoteItemIds[itemIndex],
              componentAmounts[itemIndex]!.production,
              JSON.stringify({}),
              t,
              quantityComponentId,
              componentAmounts[itemIndex]!.quantity,
              postprocessingComponentId,
              componentAmounts[itemIndex]!.postprocessing,
            ],
          );
        } else {
          await this.sql.query(
            "INSERT INTO price_snapshot_components (id, price_snapshot_id, kind, scope, order_item_id, amount_minor, allocation, created_at) VALUES ($1,$2,'ITEM_PRODUCTION','ORDER_ITEM',$3,$4,$5::jsonb,$6),($7,$2,'ITEM_QUANTITY','ORDER_ITEM',$3,$8,$5::jsonb,$6),($9,$2,'ITEM_POSTPROCESSING','ORDER_ITEM',$3,$10,$5::jsonb,$6)",
            [
              productionComponentId,
              snapshotId,
              input.orderItemIds[itemIndex],
              componentAmounts[itemIndex]!.production,
              JSON.stringify({}),
              t,
              quantityComponentId,
              componentAmounts[itemIndex]!.quantity,
              postprocessingComponentId,
              componentAmounts[itemIndex]!.postprocessing,
            ],
          );
        }
      }
      await this.sql.query(
        "INSERT INTO price_snapshot_components (id, price_snapshot_id, kind, scope, shipment_plan_id, amount_minor, allocation, created_at) VALUES ($1,$2,'SHIPMENT','SHIPMENT_PLAN',$3,$4,$5::jsonb,$6)",
        [
          shipmentComponentId,
          snapshotId,
          input.shipmentPlanIds[itemIndex],
          componentAmounts[itemIndex]!.shipment,
          JSON.stringify({}),
          t,
        ],
      );
      const firstItemSlot = itemSlots[0];
      if (!firstItemSlot) {
        throw new Error("commerce item did not receive a fulfilment slot");
      }
      if (input.orderOrigin === "AUTOMATIC") {
        if (item.priced) {
          await this.sql.query(
            "INSERT INTO price_component_fulfilment_allocations (price_snapshot_component_id, fulfilment_slot_id, amount_minor) VALUES ($1,$2,$3),($4,$2,$5),($6,$2,$7),($8,$2,$9)",
            [
              productionComponentId,
              firstItemSlot,
              componentAmounts[itemIndex]!.production,
              quantityComponentId,
              componentAmounts[itemIndex]!.quantity,
              postprocessingComponentId,
              componentAmounts[itemIndex]!.postprocessing,
              shipmentComponentId,
              componentAmounts[itemIndex]!.shipment,
            ],
          );
        } else {
          await this.sql.query(
            "INSERT INTO price_component_fulfilment_allocations (price_snapshot_component_id, fulfilment_slot_id, amount_minor) VALUES ($1,$2,$3)",
            [
              shipmentComponentId,
              firstItemSlot,
              componentAmounts[itemIndex]!.shipment,
            ],
          );
        }
      }
    }
    await this.sql.query(
      "INSERT INTO price_snapshot_components (id, price_snapshot_id, kind, scope, amount_minor, allocation, created_at) VALUES ($1,$2,'ORDER_MIN_PRINT','ORDER',$3,$4::jsonb,$5),($6,$2,'ORDER_SMALL_SURCHARGE','ORDER',$7,$4::jsonb,$5)",
      [
        componentIds[componentIds.length - 2],
        snapshotId,
        orderMinimum,
        JSON.stringify({}),
        t,
        componentIds[componentIds.length - 1],
        smallSurcharge,
      ],
    );
    const firstSlotId = input.fulfilmentSlotIds[0];
    if (!firstSlotId) {
      throw new Error("commerce topology did not create a fulfilment slot");
    }
    await this.sql.query(
      "INSERT INTO price_component_fulfilment_allocations (price_snapshot_component_id, fulfilment_slot_id, amount_minor) VALUES ($1,$2,$3),($4,$2,$5)",
      [
        componentIds[componentIds.length - 2],
        firstSlotId,
        orderMinimum,
        componentIds[componentIds.length - 1],
        smallSurcharge,
      ],
    );
    if (input.paymentScheduleKind === "DEPOSIT_BALANCE") {
      if (contractTotal < 2) {
        throw new Error(
          "a split payment fixture requires at least two minor units",
        );
      }
      const depositAmount = Math.floor(contractTotal * 0.4);
      await this.sql.query(
        "INSERT INTO payment_schedules (id, price_snapshot_id, sequence, role, gross_amount_minor, fee_rate_basis_points, fee_fixed_minor, provider_config, created_at) VALUES ($1,$2,0,'DEPOSIT',$3,0,0,$5::jsonb,$6),($4,$2,1,'BALANCE',$7,0,0,$5::jsonb,$6)",
        [
          scheduleId,
          snapshotId,
          depositAmount,
          this.id(`${input.name}:balance-payment-schedule`),
          JSON.stringify({}),
          t,
          contractTotal - depositAmount,
        ],
      );
    } else {
      await this.sql.query(
        "INSERT INTO payment_schedules (id, price_snapshot_id, sequence, role, gross_amount_minor, fee_rate_basis_points, fee_fixed_minor, provider_config, created_at) VALUES ($1,$2,0,'FULL',$3,0,0,$4::jsonb,$5)",
        [scheduleId, snapshotId, contractTotal, JSON.stringify({}), t],
      );
    }
    if (input.orderOrigin === "INDIVIDUAL") {
      await this.sql.query(
        "UPDATE quote_requests SET status = 'ACCEPTED', updated_at = $2 WHERE id = $1",
        [input.quoteRequestId, t],
      );
      await this.sql.query(
        "INSERT INTO individual_order_origins (order_id, quote_id) VALUES ($1,$2)",
        [input.orderId, input.quoteId],
      );
      for (const [index] of input.orderItemIds.entries()) {
        await this.sql.query(
          "INSERT INTO individual_order_item_sources (order_item_id, quote_item_id) VALUES ($1,$2)",
          [input.orderItemIds[index], input.quoteItemIds[index]],
        );
      }
      let individualSlotIndex = 0;
      for (const [itemIndex, item] of input.resolvedItems.entries()) {
        if (!item.priced) {
          individualSlotIndex += item.quantity;
          continue;
        }
        const firstItemSlot = input.fulfilmentSlotIds[individualSlotIndex];
        if (!firstItemSlot) {
          throw new Error(
            "individual commerce item did not receive a fulfilment slot",
          );
        }
        await this.sql.query(
          "INSERT INTO price_component_fulfilment_allocations (price_snapshot_component_id, fulfilment_slot_id, amount_minor) VALUES ($1,$2,$3),($4,$2,$5),($6,$2,$7),($8,$2,$9)",
          [
            componentIds[itemIndex * 4],
            firstItemSlot,
            componentAmounts[itemIndex]!.production,
            componentIds[itemIndex * 4 + 1],
            componentAmounts[itemIndex]!.quantity,
            componentIds[itemIndex * 4 + 2],
            componentAmounts[itemIndex]!.postprocessing,
            componentIds[itemIndex * 4 + 3],
            componentAmounts[itemIndex]!.shipment,
          ],
        );
        individualSlotIndex += item.quantity;
      }
      await this.sql.query(
        `SET CONSTRAINTS
           "quote_requests_individual_order_reconciled",
           "individual_order_origins_request_reconciled" IMMEDIATE`,
      );
      await this.sql.query(
        `SET CONSTRAINTS
           "quote_requests_individual_order_reconciled",
           "individual_order_origins_request_reconciled" DEFERRED`,
      );
    }
    if (input.finalOrderStatus === "QUOTED") {
      await this.sql.query(
        "UPDATE orders SET status = 'QUOTED', quoted_at = $2, updated_at = $2 WHERE id = $1",
        [input.orderId, t],
      );
      await this.sql.query(
        `UPDATE orders
         SET accepted_order_price_binding_id = $3,
             accepted_terms_revision = (
               SELECT list.terms_revision
               FROM order_price_bindings binding
               JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
               JOIN price_lists list ON list.id = snapshot.price_list_id
               WHERE binding.id = $3 AND binding.order_id = $1
             ),
             accepted_claim_policy_revision = 'claim-policy-v1',
             withdrawal_exception_acknowledged_at = $2,
             updated_at = $2
         WHERE id = $1`,
        [input.orderId, t, input.orderPriceBindingId],
      );
      await this.sql.query(
        "INSERT INTO audit_events (id, quote_id, order_id, event_type, payload, created_at) VALUES ($1,$2,$3,'order.quoted',$4::jsonb,$5)",
        [
          this.id(`${input.name}:audit`),
          input.customerOwned ? input.quoteId : null,
          input.orderId,
          JSON.stringify({}),
          t,
        ],
      );
    }
    if (input.automaticCheckout) {
      await this.sql.query(
        "UPDATE quote_sessions SET status = 'CONVERTED', updated_at = $2 WHERE id = $1",
        [input.quoteSessionId, t],
      );
    }
  }

  async finalizePayment(
    foundation: PersistenceFoundation,
    checkoutCaptureExpiresAt: Date | null = new Date(
      Date.now() + 60 * 60 * 1_000,
    ),
    providerIntentId:
      string | null = `intent-${this.hash(foundation.paymentId)}`,
    provider = "test",
    paymentCreatedAt = checkoutCaptureExpiresAt
      ? new Date(checkoutCaptureExpiresAt.getTime() - 60 * 60 * 1_000)
      : new Date(),
    recordCheckoutAcceptance = true,
  ): Promise<void> {
    if (recordCheckoutAcceptance) {
      await this.acceptCheckoutTerms(foundation);
    }
    const schedule = await this.sql.query<{
      gross_amount_minor: string;
      role: "FULL" | "DEPOSIT" | "BALANCE";
    }>(
      'SELECT "gross_amount_minor"::text, "role"::text FROM "payment_schedules" WHERE "id" = $1',
      [foundation.paymentScheduleId],
    );
    const scheduledCapture = schedule.rows[0];
    if (!scheduledCapture) {
      throw new Error("commerce topology payment schedule is missing");
    }
    await this.sql.query(
      "INSERT INTO payments (id, order_id, price_snapshot_id, order_price_binding_id, payment_schedule_id, role, provider, requested_amount_minor, currency, status, checkout_capture_expires_at, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6::payment_role,$7,$8,'EUR','CREATED',$9,$10,$10)",
      [
        foundation.paymentId,
        foundation.orderId,
        foundation.priceSnapshotId,
        foundation.orderPriceBindingId,
        foundation.paymentScheduleId,
        scheduledCapture.role,
        provider,
        scheduledCapture.gross_amount_minor,
        checkoutCaptureExpiresAt,
        paymentCreatedAt,
      ],
    );
    await this.sql.query(
      `UPDATE payments
       SET status = 'PENDING', provider_intent_id = $2, updated_at = $3
       WHERE id = $1`,
      [foundation.paymentId, providerIntentId, paymentCreatedAt],
    );
  }

  async acceptCheckoutTerms(
    foundation: PersistenceFoundation,
    acknowledgedAt = new Date(),
  ): Promise<void> {
    await this.sql.query(
      `UPDATE orders
       SET accepted_order_price_binding_id = $3,
           accepted_terms_revision = (
             SELECT list.terms_revision
             FROM order_price_bindings binding
             JOIN price_snapshots snapshot ON snapshot.id = binding.price_snapshot_id
             JOIN price_lists list ON list.id = snapshot.price_list_id
             WHERE binding.id = $3 AND binding.order_id = $1
           ),
           accepted_claim_policy_revision = 'claim-policy-v1',
           withdrawal_exception_acknowledged_at = $2,
           updated_at = $2
       WHERE id = $1
         AND status = 'QUOTED'
         AND accepted_order_price_binding_id IS NULL
         AND accepted_terms_revision IS NULL
         AND accepted_claim_policy_revision IS NULL
         AND withdrawal_exception_acknowledged_at IS NULL`,
      [foundation.orderId, acknowledgedAt, foundation.orderPriceBindingId],
    );
  }

  async capturePayment(
    foundation: PersistenceFoundation,
    providerCaptureId?: string,
    capturedAt = new Date(),
    providerEventAlreadyPersisted = false,
  ): Promise<void> {
    const existing = await this.sql.query<{ status: string }>(
      'SELECT "status"::text FROM "payments" WHERE "id" = $1',
      [foundation.paymentId],
    );
    if (!existing.rows[0]) {
      await this.finalizePayment(foundation);
    } else if (existing.rows[0].status === "CAPTURED") {
      return;
    } else if (existing.rows[0].status !== "PENDING") {
      throw new Error(
        `cannot capture fixture payment from ${existing.rows[0].status}`,
      );
    }

    const resolvedProviderCaptureId =
      providerCaptureId ??
      `capture-${this.hash(foundation.paymentId).slice(0, 32)}`;
    if (!providerEventAlreadyPersisted) {
      await this.persistPaymentProviderEvent(
        foundation.paymentId,
        "PAYMENT_CAPTURED",
        resolvedProviderCaptureId,
        capturedAt,
      );
    }

    await this.sql.query(
      `UPDATE payments
       SET status = 'CAPTURED', captured_amount_minor = requested_amount_minor,
           provider_capture_id = $2, captured_at = $3
       WHERE id = $1`,
      [foundation.paymentId, resolvedProviderCaptureId, capturedAt],
    );
  }

  async persistPaymentProviderEvent(
    paymentId: string,
    kind:
      | "PAYMENT_CAPTURED"
      | "PAYMENT_FAILED"
      | "REFUND_SUCCEEDED"
      | "REFUND_FAILED",
    providerTransactionId: string,
    verifiedAt = new Date(),
    refundTransactionId: string | null = null,
    providerEventId = `event-${this.hash(
      `${paymentId}:${kind}:${providerTransactionId}:${verifiedAt.toISOString()}`,
    ).slice(0, 48)}`,
    occurredAt = verifiedAt,
  ): Promise<string> {
    const evidence = await this.sql.query<{
      provider: string;
      currency: string;
      amount_minor: string;
    }>(
      `SELECT payment.provider, payment.currency,
              CASE WHEN $2::uuid IS NULL
                   THEN payment.requested_amount_minor
                   ELSE refund.amount_minor
              END::text AS amount_minor
       FROM payments payment
       LEFT JOIN refund_transactions refund
         ON refund.id = $2::uuid
        AND refund.payment_id = payment.id
       WHERE payment.id = $1`,
      [paymentId, refundTransactionId],
    );
    const target = evidence.rows[0];
    if (!target?.amount_minor) {
      throw new Error("payment provider event parent evidence is missing");
    }

    const payload: Record<string, string> = {
      paymentId,
      providerEventId,
      providerTransactionId,
      kind,
      amountMinor: target.amount_minor,
      currency: target.currency,
    };
    if (refundTransactionId) {
      payload.refundTransactionId = refundTransactionId;
    }

    await this.sql.query(
      `INSERT INTO payment_provider_events (
           id, payment_id, refund_transaction_id, provider,
           provider_event_id, provider_transaction_id, kind,
           amount_minor, currency, payload, payload_hash,
           occurred_at, authenticated_at, verified_at, created_at
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, $10::jsonb,
           encode(sha256(convert_to($10::jsonb::text, 'UTF8')), 'hex'),
           $11, $12, $12, $12
       )`,
      [
        this.id(`provider-event:${providerEventId}`),
        paymentId,
        refundTransactionId,
        target.provider,
        providerEventId,
        providerTransactionId,
        kind,
        target.amount_minor,
        target.currency,
        JSON.stringify(payload),
        occurredAt,
        verifiedAt,
      ],
    );

    return providerEventId;
  }

  async persistPaymentFailureEvent(
    paymentId: string,
    verifiedAt = new Date(),
    providerEventId?: string,
  ): Promise<string> {
    const payment = await this.sql.query<{ provider_intent_id: string | null }>(
      `SELECT provider_intent_id FROM payments WHERE id = $1`,
      [paymentId],
    );
    const providerIntentId = payment.rows[0]?.provider_intent_id;
    if (!providerIntentId) {
      throw new Error("payment failure fixture has no provider intent");
    }
    return this.persistPaymentProviderEvent(
      paymentId,
      "PAYMENT_FAILED",
      providerIntentId,
      verifiedAt,
      null,
      providerEventId,
    );
  }

  async persistPaymentIntentCreationFailure(
    paymentId: string,
    failedAt = new Date(),
    attemptKey = `intent-attempt-${this.hash(paymentId).slice(0, 48)}`,
    resultId = this.id(`intent-creation-failure:${attemptKey}`),
  ): Promise<string> {
    const payment = await this.sql.query<{
      provider: string;
      provider_intent_id: string | null;
      status: string;
    }>(
      `SELECT provider, provider_intent_id, status::text
       FROM payments WHERE id = $1`,
      [paymentId],
    );
    const target = payment.rows[0];
    if (
      !target ||
      target.status !== "CREATED" ||
      target.provider_intent_id !== null
    ) {
      throw new Error(
        "payment intent creation failure fixture requires a created Payment without a provider intent",
      );
    }

    await this.sql.query(
      `INSERT INTO payment_intent_creation_failures (
           id, payment_id, provider, attempt_key, outcome,
           provider_intent_id, failed_at
       ) VALUES ($1, $2, $3, $4, 'FAILED', NULL, $5)`,
      [resultId, paymentId, target.provider, attemptKey, failedAt],
    );

    return resultId;
  }

  async persistRefundProviderEvent(
    refundTransactionId: string,
    kind: "REFUND_SUCCEEDED" | "REFUND_FAILED",
    providerRefundId: string,
    verifiedAt = new Date(),
    providerEventId?: string,
    occurredAt = verifiedAt,
  ): Promise<string> {
    const refund = await this.sql.query<{ payment_id: string }>(
      `SELECT payment_id FROM refund_transactions WHERE id = $1`,
      [refundTransactionId],
    );
    const paymentId = refund.rows[0]?.payment_id;
    if (!paymentId) {
      throw new Error("refund provider event fixture has no payment");
    }
    return this.persistPaymentProviderEvent(
      paymentId,
      kind,
      providerRefundId,
      verifiedAt,
      refundTransactionId,
      providerEventId,
      occurredAt,
    );
  }

  async activatePayment(
    foundation: PersistenceFoundation,
    providerCaptureId?: string,
  ): Promise<void> {
    const existing = await this.sql.query(
      "SELECT 1 FROM payments WHERE id = $1",
      [foundation.paymentId],
    );
    if (!existing.rows[0]) {
      await this.finalizePayment(foundation);
    }
    const activatedAt = new Date();
    const resolvedProviderCaptureId =
      providerCaptureId ??
      `capture-${this.hash(foundation.paymentId).slice(0, 32)}`;
    await this.persistPaymentProviderEvent(
      foundation.paymentId,
      "PAYMENT_CAPTURED",
      resolvedProviderCaptureId,
      activatedAt,
    );
    await this.sql.query(
      `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" IMMEDIATE`,
    );
    await this.sql.query(
      `SET CONSTRAINTS "orders_require_initial_quoted_single_phase" DEFERRED`,
    );
    await this.sql.query(
      `UPDATE orders
       SET status = 'CONFIRMED', confirmed_at = $2, updated_at = $2
       WHERE id = $1`,
      [foundation.orderId, activatedAt],
    );
    await this.sql.query(
      `UPDATE order_phases
       SET status = 'ACTIVE', activated_at = $2, updated_at = $2
       WHERE id = $1`,
      [foundation.orderPhaseId, activatedAt],
    );
    await this.capturePayment(
      foundation,
      resolvedProviderCaptureId,
      activatedAt,
      true,
    );
  }

  async planProduction(
    foundation: PersistenceFoundation,
    name: string,
    intervalOrIntervals: CapacityInterval | CapacityInterval[] = {
      startsAt: testTimes.capacityStart,
      endsAt: testTimes.capacityEnd,
    },
    requiredMachineSeconds = 60,
    requiredMaterialMilligrams = 60,
    quantity = 1,
    topologyIndex = 0,
    occupancyPlan: CandidateOccupancyPlan = {},
  ): Promise<ProductionReservationFixture> {
    const candidateId = this.id(`${name}:candidate`);
    const capacityIntervals = Array.isArray(intervalOrIntervals)
      ? intervalOrIntervals
      : [intervalOrIntervals];
    const candidateCapacityIntervalIds = capacityIntervals.map((_, index) =>
      this.id(`${name}:candidate-capacity-interval:${index}`),
    );
    const candidateCapacityIntervalId = candidateCapacityIntervalIds[0];
    if (!candidateCapacityIntervalId) {
      throw new Error(
        "a planned production needs at least one capacity interval",
      );
    }
    const planJobId = this.id(`${name}:plan-job`);
    const productionReservationId = this.id(`${name}:production-reservation`);
    const inventoryReservationId = this.id(`${name}:inventory-reservation`);
    const shipmentPlanId =
      foundation.fulfilmentSlotShipmentPlanIds[topologyIndex] ??
      foundation.shipmentPlanIds[topologyIndex];
    const fulfilmentSlotId = foundation.fulfilmentSlotIds[topologyIndex];
    if (!shipmentPlanId || !fulfilmentSlotId) {
      throw new Error(`commerce topology slot ${topologyIndex} is missing`);
    }
    const partsPerPlate =
      occupancyPlan.partsPerPlate ??
      foundation.fulfilmentSlotPartsPerPlate[topologyIndex];
    if (!partsPerPlate) {
      throw new Error(
        `commerce topology slot ${topologyIndex} has no plate capacity`,
      );
    }
    const primarySliceResultId =
      foundation.fulfilmentSlotSliceResultIds[topologyIndex] ??
      foundation.sliceResultId;
    const primaryArrangement = await this.sql.query<{
      arrangement_revision_id: string | null;
    }>(
      'SELECT "arrangement_revision_id" FROM "slice_results" WHERE "id" = $1',
      [primarySliceResultId],
    );
    const arrangementRevisionId =
      primaryArrangement.rows[0]?.arrangement_revision_id;
    if (!arrangementRevisionId) {
      throw new Error("planned production primary slice has no arrangement");
    }

    await this.sql.query(
      `INSERT INTO "arrangement_revisions" ("id", "content_sha256")
       VALUES ($1, $2)
       ON CONFLICT ("id") DO NOTHING`,
      [
        arrangementRevisionId,
        this.hash(`arrangement-revision:${arrangementRevisionId}`),
      ],
    );

    await this.sql.query(
      'INSERT INTO "candidate_resource_estimates" ("id", "node_id", "estimate_key", "model_geometry_id", "slice_result_id", "tail_slice_result_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "machine_id", "inventory_id", "shipment_plan_id", "arrangement_revision_id", "quantity", "parts_per_plate", "required_material_milligrams", "required_machine_seconds", "resource_snapshot", "calculated_at", "expires_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20)',
      [
        candidateId,
        foundation.nodeId,
        `estimate-${this.scope}-${name}`,
        foundation.fulfilmentSlotModelGeometryIds[topologyIndex] ??
          foundation.modelGeometryId,
        primarySliceResultId,
        occupancyPlan.tailSliceResultId ?? null,
        foundation.fulfilmentSlotPrintConfigRevisionIds[topologyIndex] ??
          foundation.printConfigRevisionId,
        foundation.machineProfileId,
        foundation.machineCalibrationId,
        foundation.machineId,
        foundation.inventoryId,
        shipmentPlanId,
        arrangementRevisionId,
        quantity,
        partsPerPlate,
        requiredMaterialMilligrams,
        requiredMachineSeconds,
        JSON.stringify({}),
        createdAt,
        expiresAt,
      ],
    );
    for (const [index, capacityInterval] of capacityIntervals.entries()) {
      const candidateCapacityIntervalId = candidateCapacityIntervalIds[index];
      if (!candidateCapacityIntervalId) {
        throw new Error("capacity interval identifier was not generated");
      }
      await this.sql.query(
        'INSERT INTO "candidate_capacity_intervals" ("id", "node_id", "candidate_resource_estimate_id", "interval_index", "starts_at", "ends_at") VALUES ($1, $2, $3, $4, $5, $6)',
        [
          candidateCapacityIntervalId,
          foundation.nodeId,
          candidateId,
          index,
          capacityInterval.startsAt,
          capacityInterval.endsAt,
        ],
      );
    }
    const plannedJobKey = `planned-${this.hash(`${name}:planned-job-key`).slice(0, 32)}`;
    const jobId = this.id(`${name}:future-job`);
    return {
      candidateResourceEstimateId: candidateId,
      phaseResourcePlanJobId: planJobId,
      plannedJobKey,
      fulfilmentSlotId,
      shipmentPlanId,
      jobId,
      productionReservationId,
      inventoryReservationId,
      candidateCapacityIntervalId,
      candidateCapacityIntervalIds,
      requiredMaterialMilligrams,
      requiredMachineSeconds,
    };
  }

  async createPhaseReservationSet(
    foundation: PersistenceFoundation,
    reservationExpiresAt = expiresAt,
    status = "BUILDING",
    reservationCreatedAt = createdAt,
  ): Promise<void> {
    await this.sql.query(
      'INSERT INTO "phase_reservation_sets" ("id", "node_id", "phase_resource_plan_id", "reservation_key", "status", "expires_at", "created_at", "updated_at") VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        foundation.phaseReservationSetId,
        foundation.nodeId,
        foundation.phaseResourcePlanId,
        `reservation-${this.hash(foundation.phaseReservationSetId).slice(0, 48)}`,
        status,
        reservationExpiresAt,
        reservationCreatedAt,
        reservationCreatedAt,
      ],
    );
  }

  async createResourcePlan(
    foundation: PersistenceFoundation,
    productions: ProductionReservationFixture[],
    planExpiresAt = expiresAt,
    planCreatedAt = createdAt,
  ): Promise<void> {
    const requiredFulfilmentSlotIds = productions.map(
      (production) => production.fulfilmentSlotId,
    );
    const candidateIds = productions.map(
      (production) => production.candidateResourceEstimateId,
    );
    await this.sql.query(
      'INSERT INTO "eligibility_snapshots" ("id", "node_id", "order_phase_id", "required_fulfilment_slot_ids", "eligible_candidate_estimate_ids", "snapshot_hash", "calculated_at", "expires_at") VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)',
      [
        foundation.eligibilitySnapshotId,
        foundation.nodeId,
        foundation.orderPhaseId,
        JSON.stringify(requiredFulfilmentSlotIds),
        JSON.stringify(candidateIds),
        this.hash(`snapshot:${foundation.eligibilitySnapshotId}`),
        planCreatedAt,
        planExpiresAt,
      ],
    );
    await this.sql.query(
      'INSERT INTO "phase_resource_plans" ("id", "node_id", "order_phase_id", "eligibility_snapshot_id", "plan_key", "created_at", "expires_at") VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        foundation.phaseResourcePlanId,
        foundation.nodeId,
        foundation.orderPhaseId,
        foundation.eligibilitySnapshotId,
        `plan-${this.hash(foundation.phaseResourcePlanId).slice(0, 32)}`,
        planCreatedAt,
        planExpiresAt,
      ],
    );
    for (const production of productions) {
      await this.sql.query(
        'INSERT INTO "phase_resource_plan_jobs" ("id", "node_id", "phase_resource_plan_id", "candidate_resource_estimate_id", "planned_job_key") VALUES ($1, $2, $3, $4, $5)',
        [
          production.phaseResourcePlanJobId,
          foundation.nodeId,
          foundation.phaseResourcePlanId,
          production.candidateResourceEstimateId,
          production.plannedJobKey,
        ],
      );
      await this.sql.query(
        'INSERT INTO "phase_resource_plan_slots" ("id", "node_id", "phase_resource_plan_id", "phase_resource_plan_job_id", "fulfilment_slot_id") VALUES ($1, $2, $3, $4, $5)',
        [
          this.id(`${production.plannedJobKey}:phase-resource-plan-slot`),
          foundation.nodeId,
          foundation.phaseResourcePlanId,
          production.phaseResourcePlanJobId,
          production.fulfilmentSlotId,
        ],
      );
    }
  }

  async createProductionReservation(
    foundation: PersistenceFoundation,
    planned: ProductionReservationFixture,
    status = "RESERVED",
    resourceSnapshot: unknown = {},
    jobId: string | null = null,
    reservationExpiresAt = expiresAt,
    reservationCreatedAt = createdAt,
  ): Promise<void> {
    const topologyIndex = foundation.fulfilmentSlotIds.indexOf(
      planned.fulfilmentSlotId,
    );
    if (topologyIndex < 0) {
      throw new Error(
        "planned production fulfilment slot is not in the foundation",
      );
    }
    const sliceResultId =
      foundation.fulfilmentSlotSliceResultIds[topologyIndex] ??
      foundation.sliceResultId;
    const printConfigRevisionId =
      foundation.fulfilmentSlotPrintConfigRevisionIds[topologyIndex] ??
      foundation.printConfigRevisionId;
    await this.sql.query(
      'INSERT INTO "production_reservations" ("id", "node_id", "phase_reservation_set_id", "phase_resource_plan_job_id", "planned_job_key", "job_id", "machine_id", "inventory_id", "slice_result_id", "print_config_revision_id", "machine_profile_id", "machine_calibration_id", "required_material_milligrams", "required_machine_seconds", "resource_snapshot", "status", "expires_at", "created_at", "updated_at", "phase_resource_plan_id") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18, $19, $20)',
      [
        planned.productionReservationId,
        foundation.nodeId,
        foundation.phaseReservationSetId,
        planned.phaseResourcePlanJobId,
        planned.plannedJobKey,
        jobId,
        foundation.machineId,
        foundation.inventoryId,
        sliceResultId,
        printConfigRevisionId,
        foundation.machineProfileId,
        foundation.machineCalibrationId,
        planned.requiredMaterialMilligrams,
        planned.requiredMachineSeconds,
        JSON.stringify(resourceSnapshot),
        status,
        reservationExpiresAt,
        reservationCreatedAt,
        reservationCreatedAt,
        foundation.phaseResourcePlanId,
      ],
    );
  }

  async createJob(
    foundation: PersistenceFoundation,
    planned: ProductionReservationFixture,
  ): Promise<void> {
    await this.sql.query(
      "INSERT INTO jobs (id, node_id, order_id, order_phase_id, shipment_plan_id, phase_resource_plan_job_id, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)",
      [
        planned.jobId,
        foundation.nodeId,
        foundation.orderId,
        foundation.orderPhaseId,
        planned.shipmentPlanId,
        planned.phaseResourcePlanJobId,
        "CREATED",
        createdAt,
      ],
    );
  }

  async createReservationGraph(
    name: string,
    intervals = [
      {
        startsAt: testTimes.capacityStart,
        endsAt: testTimes.capacityEnd,
      },
    ],
    resourceSnapshot: unknown = {},
    sourceRetention: SourceRetention = {},
    reservationTiming: ReservationTiming = { createdAt, expiresAt },
  ): Promise<{
    foundation: PersistenceFoundation;
    productions: ProductionReservationFixture[];
  }> {
    const foundation = await this.createFoundation(
      name,
      sourceRetention,
      undefined,
      undefined,
      undefined,
      intervals.length,
    );
    const productions: ProductionReservationFixture[] = [];
    for (const [index, interval] of intervals.entries()) {
      productions.push(
        await this.planProduction(
          foundation,
          `production-${index}`,
          interval,
          undefined,
          undefined,
          undefined,
          index,
        ),
      );
    }
    await this.createResourcePlan(foundation, productions);
    await this.createPhaseReservationSet(
      foundation,
      reservationTiming.expiresAt,
      "BUILDING",
      reservationTiming.createdAt,
    );
    for (const production of productions) {
      await this.createProductionReservation(
        foundation,
        production,
        "RESERVED",
        resourceSnapshot,
        null,
        reservationTiming.expiresAt,
        reservationTiming.createdAt,
      );
    }
    return { foundation, productions };
  }

  async createRevisionIdentity(id: string, kind: string): Promise<void> {
    await this.sql.query(
      'INSERT INTO "revision_identities" ("id", "kind", "digest") VALUES ($1, $2::"revision_kind", $3)',
      [id, kind, this.hash(`revision:${id}`)],
    );
  }

  private hash(value: string): string {
    return createHash("sha256").update(`${this.scope}:${value}`).digest("hex");
  }

  private componentIds(
    name: string,
    items: Array<{ quantity: number }>,
  ): string[] {
    return [
      ...items.flatMap((_, index) => [
        this.id(`${name}:component:item-production:${index}`),
        this.id(`${name}:component:item-quantity:${index}`),
        this.id(`${name}:component:item-postprocessing:${index}`),
        this.id(`${name}:component:shipment:${index}`),
      ]),
      this.id(`${name}:component:order-minimum`),
      this.id(`${name}:component:small-surcharge`),
    ];
  }
}
