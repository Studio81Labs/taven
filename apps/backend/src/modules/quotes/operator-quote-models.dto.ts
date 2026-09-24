import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AutomaticQuoteDeliverySelectorDto } from "../automatic-quotes/automatic-quotes.dto";

export class ImportQuoteRequestModelDto {
  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;
}

export class SelectQuoteRequestModelDto {
  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: [String], minItems: 1 })
  bodyIds!: string[];
}

export class QuoteRequestModelAttachedDto {
  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  inspectionJobId!: string;
}

export class QuoteRequestModelSelectedDto {
  @ApiProperty({ type: String, format: "uuid" })
  selectionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  modelGeometryId!: string;
}

export class QuoteRequestModelSelectionDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  modelGeometryId!: string;

  @ApiProperty({ type: [String] })
  bodyIds!: string[];

  @ApiProperty({ type: String })
  selectionSha256!: string;

  @ApiProperty({ type: String })
  sourceContentSha256!: string;

  @ApiProperty({ type: Boolean })
  geometryReady!: boolean;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class QuoteRequestModelDto {
  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: String, enum: ["STL", "3MF"] })
  format!: "STL" | "3MF";

  @ApiProperty({ type: String })
  originalFilename!: string;

  @ApiProperty({ type: String })
  contentSha256!: string;

  @ApiProperty({ type: String })
  sizeBytes!: string;

  @ApiProperty({ type: String, format: "uuid" })
  inspectionJobId!: string;

  @ApiProperty({ type: String, enum: ["PENDING", "SUCCEEDED", "FAILED"] })
  inspectionStatus!: "PENDING" | "SUCCEEDED" | "FAILED";

  @ApiProperty({ type: [String] })
  availableBodyIds!: string[];

  @ApiPropertyOptional({ type: String, nullable: true })
  inspectionFailureCode!: string | null;

  @ApiProperty({ type: Boolean })
  sourceAvailable!: boolean;

  @ApiProperty({ type: String, format: "date-time" })
  sourceDeleteAfter!: string;

  @ApiProperty({ type: [QuoteRequestModelSelectionDto] })
  selections!: QuoteRequestModelSelectionDto[];
}

export class QuoteRequestModelsDto {
  @ApiProperty({ type: [QuoteRequestModelDto] })
  items!: QuoteRequestModelDto[];
}

export class PrepareQuoteRequestReferenceDto {
  @ApiProperty({ type: String, format: "uuid" })
  selectionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  printConfigRevisionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  referenceProfileId!: string;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 1_000 })
  quantity!: number;

  @ApiProperty({ type: "integer", minimum: 1, maximum: 1_000 })
  partsPerPlate!: number;
}

export class QuoteRequestReferencePreparationDto {
  @ApiProperty({ type: String, format: "uuid" })
  selectionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  printConfigRevisionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  referenceProfileId!: string;

  @ApiProperty({ type: "integer" })
  quantity!: number;

  @ApiProperty({ type: "integer" })
  partsPerPlate!: number;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  primaryReferenceSliceResultId!: string | null;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  tailReferenceSliceResultId!: string | null;

  @ApiProperty({ type: [String], description: "Pending worker-v2 job IDs" })
  pendingJobIds!: string[];

  @ApiProperty({
    type: [String],
    description: "Terminally failed worker-v2 job IDs",
  })
  failedJobIds!: string[];
}

export class QuoteComposerPrintConfigDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;
  @ApiProperty({ type: String })
  quality!: string;
  @ApiProperty({ type: "integer" })
  infillPercent!: number;
  @ApiProperty({ type: "integer" })
  layerHeightMicrometers!: number;
}

export class QuoteComposerReferenceProfileDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;
  @ApiProperty({ type: String })
  material!: string;
  @ApiProperty({ type: String })
  quality!: string;
  @ApiProperty({ type: String })
  slicerVersion!: string;
}

export class QuoteComposerDeliveryOptionDto {
  @ApiProperty({ type: String })
  providerEndpointId!: string;
  @ApiProperty({ type: String })
  endpointType!: string;
  @ApiProperty({ type: String })
  label!: string;
  @ApiProperty({ type: [String] })
  supportedCategoryIds!: readonly string[];
}

export class QuoteComposerIndividualPaymentPolicyDto {
  @ApiProperty({ type: "integer", minimum: 1, maximum: 36500 })
  balancePaymentDays!: number;
  @ApiProperty({ type: [String], minItems: 1 })
  earnedComponentKinds!: string[];
}

export class QuoteComposerPolicyDto {
  @ApiProperty({ type: String, format: "uuid" })
  priceListId!: string;
  @ApiProperty({ type: String })
  revision!: string;
  @ApiProperty({ type: "integer", minimum: 1 })
  selectionVersion!: number;
  @ApiProperty({ type: String, enum: ["NON_VAT_PAYER", "VAT_PAYER"] })
  taxRegime!: "NON_VAT_PAYER" | "VAT_PAYER";
  @ApiProperty({ type: "integer" })
  vatRateBasisPoints!: number;
  @ApiProperty({
    type: () => QuoteComposerIndividualPaymentPolicyDto,
    nullable: true,
  })
  individualPaymentPolicy!: QuoteComposerIndividualPaymentPolicyDto | null;
}

export class QuoteComposerChoicesDto {
  @ApiProperty({ type: QuoteRequestModelsDto })
  models!: QuoteRequestModelsDto;
  @ApiProperty({ type: [QuoteComposerPrintConfigDto] })
  printConfigs!: QuoteComposerPrintConfigDto[];
  @ApiProperty({ type: [QuoteComposerReferenceProfileDto] })
  referenceProfiles!: QuoteComposerReferenceProfileDto[];
  @ApiProperty({ type: QuoteComposerPolicyDto })
  policy!: QuoteComposerPolicyDto;
  @ApiProperty({ type: [QuoteComposerDeliveryOptionDto] })
  deliveryOptions!: QuoteComposerDeliveryOptionDto[];
  @ApiProperty({ type: AutomaticQuoteDeliverySelectorDto })
  deliverySelector!: AutomaticQuoteDeliverySelectorDto;
}
