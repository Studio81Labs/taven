import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;
const INTEGER = { type: String, pattern: "^-?[0-9]+$" } as const;

export class CatalogCommandResultDto {
  @ApiProperty(UUID)
  id!: string;

  @ApiPropertyOptional({ type: String })
  status?: string;

  @ApiPropertyOptional({ type: String })
  state?: string;
}

export class CatalogReasonDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 1000 })
  reason!: string;
}

export class CreateReferenceProfileDto {
  @ApiProperty({ type: String })
  material!: string;

  @ApiProperty({ type: String })
  quality!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  slicerEngine!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  slicerVersion!: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  settings!: Record<string, unknown>;
}

export class CreateMachineProfileDto extends CreateReferenceProfileDto {
  @ApiProperty(UUID)
  machineCapabilityId!: string;

  @ApiProperty(UUID)
  referenceProfileId!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 2_147_483_647 })
  nozzleDiameterMicrometers!: number;

  @ApiProperty({ type: String })
  productionArtifactFormat!: string;
}

export class CreateMachineCalibrationDto {
  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 2_147_483_647 })
  flowRatioPartsPerMillion!: number;

  @ApiProperty({
    type: Number,
    minimum: -2_147_483_648,
    maximum: 2_147_483_647,
  })
  xyCompensationMicrometers!: number;

  @ApiProperty({
    type: Number,
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

  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  sku!: string;

  @ApiProperty({ type: String })
  material!: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  vendor!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 })
  color?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 100 })
  lotCode?: string | null;

  @ApiProperty(INTEGER)
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

  @ApiProperty({ type: String, pattern: "^[0-9]+$" })
  remainingMilligrams!: string;
}

export class ResourceStatusDto extends CatalogReasonDto {
  @ApiProperty({ type: String })
  status!: string;
}

export class InventoryAdjustmentDto extends CatalogReasonDto {
  @ApiProperty(INTEGER)
  deltaMilligrams!: string;
}
