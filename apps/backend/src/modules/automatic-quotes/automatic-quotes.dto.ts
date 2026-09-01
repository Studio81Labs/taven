import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export class CreateAutomaticQuoteSessionDto {
  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  attribution?: Record<string, unknown>;
}

export class AttachAutomaticQuoteModelFileDto {
  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({
    type: String,
    description: "Capability returned for the confirmed source upload",
  })
  uploadToken!: string;
}

export class ConfigureAutomaticQuoteItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: [String], minItems: 1, maxItems: 256 })
  bodyIds!: string[];

  @ApiProperty({ type: String, format: "uuid" })
  printConfigRevisionId!: string;

  @ApiProperty({ type: String, enum: ["PLA", "PETG"] })
  material!: "PLA" | "PETG";

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  color?: string;

  @ApiProperty({ type: String, enum: ["DECORATIVE", "STANDARD", "STRONG"] })
  infillPreset!: "DECORATIVE" | "STANDARD" | "STRONG";

  @ApiProperty({ type: "integer", minimum: 1, maximum: 1_000 })
  quantity!: number;

  @ApiPropertyOptional({ type: Boolean, default: false })
  fitSensitive?: boolean;

  @ApiPropertyOptional({ type: "integer", minimum: 1, maximum: 1_000 })
  preferredPartsPerPlate?: number;
}

export class AutomaticQuoteRiskDecisionDto {
  @ApiProperty({ type: "integer", minimum: 0 })
  itemOrdinal!: number;

  @ApiProperty({ type: String, format: "uuid" })
  findingId!: string;

  @ApiProperty({ type: String })
  acknowledgementKey!: string;

  @ApiProperty({ type: String, enum: ["ACKNOWLEDGED", "DECLINED"] })
  decision!: "ACKNOWLEDGED" | "DECLINED";
}

export class SelectAutomaticQuoteDestinationDto {
  @ApiProperty({ type: String, maxLength: 255 })
  providerEndpointId!: string;

  @ApiProperty({ type: String, maxLength: 100 })
  endpointType!: string;
}

export class SetAutomaticQuoteExpressDto {
  @ApiProperty({ type: Boolean })
  requested!: boolean;
}

export class AutomaticQuoteFindingDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String, enum: ["INFO", "WARNING", "BLOCKING"] })
  severity!: "INFO" | "WARNING" | "BLOCKING";

  @ApiProperty({ type: String })
  message!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  acknowledgementKey!: string | null;

  @ApiPropertyOptional({
    type: String,
    enum: ["ACKNOWLEDGED", "DECLINED"],
    nullable: true,
  })
  decision!: "ACKNOWLEDGED" | "DECLINED" | null;
}

export class AutomaticQuoteModelFileDto {
  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: String, enum: ["STL", "THREE_MF", "STEP"] })
  format!: "STL" | "THREE_MF" | "STEP";

  @ApiProperty({
    type: String,
    enum: ["PENDING", "SUCCEEDED", "FAILED", "UNSUPPORTED"],
  })
  inspectionStatus!: "PENDING" | "SUCCEEDED" | "FAILED" | "UNSUPPORTED";

  @ApiProperty({ type: [String] })
  discoveredBodyIds!: string[];
}

export class AutomaticQuoteItemDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: "integer", minimum: 0 })
  ordinal!: number;

  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: [String] })
  bodyIds!: string[];

  @ApiProperty({ type: String, enum: ["PLA", "PETG"] })
  material!: "PLA" | "PETG";

  @ApiPropertyOptional({ type: String, nullable: true })
  color!: string | null;

  @ApiProperty({ type: String })
  infillPreset!: string;

  @ApiProperty({ type: "integer", minimum: 1 })
  quantity!: number;

  @ApiProperty({ type: Boolean })
  fitSensitive!: boolean;

  @ApiProperty({
    type: String,
    enum: ["CANONICALIZATION_PENDING", "REFERENCE_SLICING_PENDING", "READY"],
  })
  status!: "CANONICALIZATION_PENDING" | "REFERENCE_SLICING_PENDING" | "READY";

  @ApiProperty({ type: [AutomaticQuoteFindingDto] })
  findings!: AutomaticQuoteFindingDto[];
}

export class AutomaticQuotePriceComponentDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({
    type: String,
    enum: [
      "ITEM_PRODUCTION",
      "ITEM_QUANTITY",
      "ITEM_POSTPROCESSING",
      "ORDER_MIN_PRINT",
      "ORDER_SMALL_SURCHARGE",
      "SHIPMENT",
      "EXPRESS",
      "PAYMENT_FEE",
    ],
  })
  kind!: string;

  @ApiProperty({ type: String, enum: ["ORDER", "ORDER_ITEM", "SHIPMENT_PLAN"] })
  scope!: "ORDER" | "ORDER_ITEM" | "SHIPMENT_PLAN";

  @ApiPropertyOptional({ type: "integer", nullable: true })
  itemOrdinal!: number | null;

  @ApiPropertyOptional({ type: "integer", nullable: true })
  shipmentPlanOrdinal!: number | null;

  @ApiProperty({ type: "integer", minimum: 0, maximum: MAX_SAFE_INTEGER })
  amountMinor!: number;
}

export class AutomaticQuotePriceDto {
  @ApiProperty({ type: String, enum: ["ROUGH_ESTIMATE", "BINDING"] })
  kind!: "ROUGH_ESTIMATE" | "BINDING";

  @ApiProperty({ type: String, minLength: 3, maxLength: 3 })
  currency!: string;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 0,
    maximum: MAX_SAFE_INTEGER,
    nullable: true,
  })
  totalMinor!: number | null;

  @ApiProperty({ type: [AutomaticQuotePriceComponentDto] })
  components!: AutomaticQuotePriceComponentDto[];
}

export class AutomaticQuoteExpressDto {
  @ApiProperty({ type: Boolean })
  requested!: boolean;

  @ApiProperty({ type: Boolean })
  eligible!: boolean;

  @ApiProperty({ type: [String] })
  reasons!: string[];
}

export class AutomaticQuoteHandoffDto {
  @ApiProperty({ type: String, enum: ["INDIVIDUAL_QUOTE_REQUEST"] })
  kind!: "INDIVIDUAL_QUOTE_REQUEST";

  @ApiProperty({ type: [String] })
  reasons!: string[];

  @ApiProperty({ type: "object", additionalProperties: true })
  safeContext!: Record<string, unknown>;
}

export class AutomaticQuoteSessionDto {
  @ApiProperty({ type: String, format: "uuid" })
  sessionId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  orderId!: string;

  @ApiProperty({ type: String })
  publicReference!: string;

  @ApiProperty({
    type: String,
    enum: [
      "INSPECTION_PENDING",
      "CONFIGURATION_REQUIRED",
      "REFERENCE_SLICES_PENDING",
      "ACTION_REQUIRED",
      "DESTINATION_REQUIRED",
      "ELIGIBILITY_PENDING",
      "CHECKOUT_READY",
      "EXPIRED",
      "HANDOFF_REQUIRED",
    ],
  })
  phase!: string;

  @ApiProperty({ type: "integer", minimum: 1 })
  configurationRevision!: number;

  @ApiProperty({ type: [AutomaticQuoteModelFileDto] })
  modelFiles!: AutomaticQuoteModelFileDto[];

  @ApiProperty({ type: [AutomaticQuoteItemDto] })
  items!: AutomaticQuoteItemDto[];

  @ApiPropertyOptional({ type: AutomaticQuotePriceDto, nullable: true })
  roughEstimate!: AutomaticQuotePriceDto | null;

  @ApiPropertyOptional({ type: AutomaticQuotePriceDto, nullable: true })
  bindingQuote!: AutomaticQuotePriceDto | null;

  @ApiProperty({ type: AutomaticQuoteExpressDto })
  express!: AutomaticQuoteExpressDto;

  @ApiPropertyOptional({ type: AutomaticQuoteHandoffDto, nullable: true })
  handoff!: AutomaticQuoteHandoffDto | null;

  @ApiProperty({ type: Boolean })
  checkoutReady!: boolean;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;
}

export class AutomaticQuoteSessionCreatedDto extends AutomaticQuoteSessionDto {
  @ApiProperty({ type: String, description: "Session-scoped capability" })
  sessionToken!: string;
}
