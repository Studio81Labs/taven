import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;
const INTEGER = { type: String, pattern: "^-?(?:0|[1-9][0-9]*)$" } as const;
const NON_NEGATIVE_INTEGER = {
  type: String,
  pattern: "^(?:0|[1-9][0-9]*)$",
} as const;
const MATERIALS = ["PLA", "PETG"] as const;
const PRINT_QUALITIES = ["DRAFT", "STANDARD", "FINE"] as const;
const PRODUCTION_ARTIFACT_FORMATS = ["GCODE_3MF", "BGCODE", "GCODE"] as const;
const MACHINE_STATUSES = ["ACTIVE", "MAINTENANCE", "DISABLED"] as const;
const INVENTORY_STATUSES = ["AVAILABLE", "DEPLETED", "RETIRED"] as const;

export class CatalogCommandResultDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiPropertyOptional({ type: String })
  status?: string;

  @ApiPropertyOptional({ type: String })
  state?: string;
}

export class CatalogReasonDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1000, pattern: "\\S" })
  reason!: string;
}

export class CreateReferenceProfileDto {
  @ApiProperty({ type: String, enum: MATERIALS })
  material!: string;

  @ApiProperty({ type: String, enum: PRINT_QUALITIES })
  quality!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 100, pattern: "\\S" })
  slicerEngine!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 100, pattern: "\\S" })
  slicerVersion!: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  settings!: Record<string, unknown>;
}

export class CreateMachineProfileDto extends CreateReferenceProfileDto {
  @ApiProperty(UUID)
  machineCapabilityId!: string;

  @ApiProperty(UUID)
  referenceProfileId!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  nozzleDiameterMicrometers!: number;

  @ApiProperty({ type: String, enum: PRODUCTION_ARTIFACT_FORMATS })
  productionArtifactFormat!: string;
}

export class CreateMachineCalibrationDto {
  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 2_147_483_647 })
  flowRatioPartsPerMillion!: number;

  @ApiProperty({
    type: "integer",
    minimum: -2_147_483_648,
    maximum: 2_147_483_647,
  })
  xyCompensationMicrometers!: number;

  @ApiProperty({
    type: "integer",
    minimum: -2_147_483_648,
    maximum: 2_147_483_647,
  })
  elephantFootCompensationMicrometers!: number;

  @ApiProperty({ type: Object, additionalProperties: true })
  settings!: Record<string, unknown>;
}

export class CreateInventoryDto {
  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 100, pattern: "\\S" })
  sku!: string;

  @ApiProperty({ type: String, enum: MATERIALS })
  material!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 200, pattern: "\\S" })
  vendor!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 100,
    pattern: "\\S",
  })
  color?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: 100,
    pattern: "\\S",
  })
  lotCode?: string | null;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  priceMinorUnitsNumerator!: string;

  @ApiProperty({ type: String, pattern: "^[1-9][0-9]*$" })
  priceMinorUnitsDenominator!: string;

  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 3,
    pattern: "^[A-Z]{3}$",
  })
  currency!: string;

  @ApiProperty(NON_NEGATIVE_INTEGER)
  remainingMilligrams!: string;
}

export class MachineStatusDto extends CatalogReasonDto {
  @ApiProperty({ type: String, enum: MACHINE_STATUSES })
  status!: string;
}

export class InventoryStatusDto extends CatalogReasonDto {
  @ApiProperty({ type: String, enum: INVENTORY_STATUSES })
  status!: string;
}

export class InventoryAdjustmentDto extends CatalogReasonDto {
  @ApiProperty(INTEGER)
  deltaMilligrams!: string;
}
