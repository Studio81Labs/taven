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

  @ApiProperty({ type: String, minLength: 1 })
  slicerEngine!: string;

  @ApiProperty({ type: String, minLength: 1 })
  slicerVersion!: string;

  @ApiProperty({ type: Object, additionalProperties: true })
  settings!: Record<string, unknown>;
}

export class CreateMachineProfileDto extends CreateReferenceProfileDto {
  @ApiProperty(UUID)
  machineCapabilityId!: string;

  @ApiProperty(UUID)
  referenceProfileId!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  nozzleDiameterMicrometers!: number;

  @ApiProperty({ type: String })
  productionArtifactFormat!: string;
}

export class CreateMachineCalibrationDto {
  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  flowRatioPartsPerMillion!: number;

  @ApiProperty({ type: Number })
  xyCompensationMicrometers!: number;

  @ApiProperty({ type: Number })
  elephantFootCompensationMicrometers!: number;

  @ApiProperty({ type: Object, additionalProperties: true })
  settings!: Record<string, unknown>;
}

export class CreateInventoryDto {
  @ApiProperty(UUID)
  machineId!: string;

  @ApiProperty({ type: String, minLength: 1 })
  sku!: string;

  @ApiProperty({ type: String })
  material!: string;

  @ApiProperty({ type: String, minLength: 1 })
  vendor!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  color?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  lotCode?: string | null;

  @ApiProperty(INTEGER)
  priceMinorUnitsNumerator!: string;

  @ApiProperty({ type: String, pattern: "^[1-9][0-9]*$" })
  priceMinorUnitsDenominator!: string;

  @ApiProperty({ type: String, pattern: "^[A-Z]{3}$" })
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
