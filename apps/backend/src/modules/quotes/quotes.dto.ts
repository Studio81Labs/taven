import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { AttributionDto } from "../metrics/attribution.dto";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const OFFER_PACKING_UNIT_MAX = 1_000;
const JAVASCRIPT_SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
const NON_BLANK_TEXT_PATTERN = "\\S";
const TRIMMED_MINIMUM_3_PATTERN = "^\\s*\\S[\\s\\S]{1,}\\S\\s*$";
const TRIMMED_MINIMUM_10_PATTERN = "^\\s*\\S[\\s\\S]{8,}\\S\\s*$";

export class QuoteContactDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  name!: string;

  @ApiProperty({ type: String, format: "email", maxLength: 320 })
  email!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 50,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  phone?: string;
}

export class CreateQuoteRequestDto {
  @ApiProperty({
    type: String,
    minLength: 10,
    maxLength: 10_000,
    pattern: TRIMMED_MINIMUM_10_PATTERN,
  })
  description!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 2_000,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  purpose?: string;

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  measurements?: Record<string, unknown>;

  @ApiPropertyOptional({ type: String, format: "date" })
  requestedDate?: string;

  @ApiProperty({ type: QuoteContactDto })
  contact!: QuoteContactDto;

  @ApiPropertyOptional({ type: Boolean })
  photoPublicationConsent?: boolean;

  @ApiPropertyOptional({
    type: String,
    minLength: 43,
    maxLength: 43,
    description: "Single-use server-issued automatic-quote handoff capability",
  })
  automaticQuoteHandoffToken?: string;

  @ApiPropertyOptional({ type: AttributionDto })
  attribution?: AttributionDto | Record<string, unknown>;
}

export class QuoteRequestCreatedDto {
  @ApiProperty({ type: String, format: "uuid" })
  requestId!: string;

  @ApiProperty({ type: String })
  publicReference!: string;

  @ApiProperty({ type: String, description: "Request-scoped capability" })
  requestToken!: string;

  @ApiProperty({ type: String, enum: ["NEW"] })
  status!: "NEW";

  @ApiProperty({ type: String, format: "date-time" })
  slaDueAt!: string;
}

export class QuoteAttachmentDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  mediaType!: string;

  @ApiProperty({ type: "integer", minimum: 0 })
  sizeBytes!: number;

  @ApiProperty({ type: String, format: "date-time" })
  uploadedAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  deleteAfter!: string;
}

export class QuoteRequestDetailDto {
  @ApiProperty({ type: String, format: "uuid" })
  requestId!: string;

  @ApiProperty({ type: String })
  publicReference!: string;

  @ApiProperty({
    type: String,
    enum: ["NEW", "IN_REVIEW", "QUOTED", "ACCEPTED", "REJECTED", "EXPIRED"],
  })
  status!: "NEW" | "IN_REVIEW" | "QUOTED" | "ACCEPTED" | "REJECTED" | "EXPIRED";

  @ApiProperty({ type: String })
  description!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  purpose!: string | null;

  @ApiProperty({ type: Boolean })
  photoPublicationConsentGranted!: boolean;

  @ApiPropertyOptional({
    type: "object",
    nullable: true,
    additionalProperties: true,
  })
  measurements!: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true })
  requestedDate!: string | null;

  @ApiProperty({ type: QuoteContactDto })
  contact!: QuoteContactDto;

  @ApiPropertyOptional({
    type: "object",
    nullable: true,
    additionalProperties: true,
  })
  attribution!: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: "date-time" })
  slaDueAt!: string;

  @ApiProperty({ type: Boolean })
  slaBreached!: boolean;

  @ApiProperty({ type: [QuoteAttachmentDto] })
  attachments!: QuoteAttachmentDto[];
}

export class AutomaticQuoteRequestHandoffDto {
  @ApiProperty({ type: String, format: "uuid" })
  automaticQuoteSessionId!: string;

  @ApiProperty({ type: [String] })
  reasons!: string[];

  @ApiProperty({ type: [String], format: "uuid" })
  modelFileIds!: string[];

  @ApiProperty({ type: () => [AutomaticQuoteRequestHandoffItemDto] })
  itemSelections!: AutomaticQuoteRequestHandoffItemDto[];
}

export class AutomaticQuoteRequestHandoffItemDto {
  @ApiProperty({ type: "integer", minimum: 0 })
  ordinal!: number;

  @ApiProperty({ type: String, format: "uuid" })
  modelFileId!: string;

  @ApiProperty({ type: [String] })
  bodyIds!: string[];

  @ApiProperty({ type: String })
  material!: string;

  @ApiProperty({ type: "integer", minimum: 1 })
  quantity!: number;

  @ApiProperty({ type: Boolean })
  fitSensitive!: boolean;
}

export class OperatorQuoteRequestDetailDto extends QuoteRequestDetailDto {
  @ApiPropertyOptional({
    type: AutomaticQuoteRequestHandoffDto,
    nullable: true,
  })
  automaticQuoteHandoff!: AutomaticQuoteRequestHandoffDto | null;
}

export class ModelOfferItemDto {
  @ApiProperty({ type: String, enum: ["MODEL"] })
  kind!: "MODEL";

  @ApiProperty({ type: String, format: "uuid" })
  sourceModelFileId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  modelGeometryId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  printConfigRevisionId!: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  primaryReferenceSliceResultId?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  tailReferenceSliceResultId?: string;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
  })
  referencePartsPerPlate?: number;

  @ApiProperty({ type: String, enum: ["PLA", "PETG"] })
  material!: "PLA" | "PETG";

  @ApiPropertyOptional({
    type: String,
    maxLength: 100,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  color?: string;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: OFFER_PACKING_UNIT_MAX,
  })
  quantity?: number;
}

export class OfferPriceComponentDto {
  @ApiProperty({
    type: String,
    enum: [
      "ITEM_PRODUCTION",
      "ITEM_QUANTITY",
      "ITEM_POSTPROCESSING",
      "ORDER_MIN_PRINT",
      "ORDER_SMALL_SURCHARGE",
      "EXPRESS",
    ],
  })
  kind!:
    | "ITEM_PRODUCTION"
    | "ITEM_QUANTITY"
    | "ITEM_POSTPROCESSING"
    | "ORDER_MIN_PRINT"
    | "ORDER_SMALL_SURCHARGE"
    | "EXPRESS";

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  amountMinor!: number;

  @ApiPropertyOptional({ type: "integer", minimum: 0 })
  quoteItemOrdinal?: number;

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  allocation?: Record<string, unknown>;
}

export class OfferDeliveryDestinationDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 255,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  providerEndpointId!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  endpointType!: string;

  @ApiProperty({ type: "object", additionalProperties: true })
  addressSnapshot!: Record<string, unknown>;

  @ApiProperty({ type: "object", additionalProperties: true })
  capabilitySnapshot!: Record<string, unknown>;
}

export class OfferShipmentPackingUnitDto {
  @ApiProperty({ type: "integer", minimum: 0, maximum: POSTGRES_INTEGER_MAX })
  quoteItemOrdinal!: number;

  @ApiProperty({ type: "integer", minimum: 1, maximum: POSTGRES_INTEGER_MAX })
  quantityOrdinal!: number;
}

export class OfferShipmentPlanDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  category!: string;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  plannedVolumeCubicMm!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  plannedWeightMilligrams!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  shippingAmountMinor!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  packagingAmountMinor!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  handlingAmountMinor!: number;

  @ApiProperty({ type: [OfferShipmentPackingUnitDto], minItems: 1 })
  packingUnits!: OfferShipmentPackingUnitDto[];

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  allocationSnapshot?: Record<string, unknown>;
}

export class OfferPaymentCapturePolicyDto {
  @ApiProperty({ type: "integer", minimum: 0, maximum: 9_999 })
  feeRateBasisPoints!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  feeFixedMinor!: number;

  @ApiProperty({ type: "object", additionalProperties: true })
  providerConfig!: Record<string, unknown>;
}

export class OfferPaymentPolicyDto {
  @ApiProperty({ type: OfferPaymentCapturePolicyDto })
  deposit!: OfferPaymentCapturePolicyDto;

  @ApiProperty({ type: OfferPaymentCapturePolicyDto })
  balance!: OfferPaymentCapturePolicyDto;
}

export class IssueOfferDto {
  @ApiProperty({
    type: String,
    minLength: 3,
    maxLength: 4_000,
    pattern: TRIMMED_MINIMUM_3_PATTERN,
  })
  summary!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;

  @ApiPropertyOptional({ type: String, format: "date" })
  promisedDate?: string;

  @ApiProperty({ type: String, format: "uuid" })
  priceListId!: string;

  @ApiProperty({
    type: "integer",
    minimum: 2,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  contractTotalMinor!: number;

  @ApiProperty({ type: String, enum: ["NON_VAT_PAYER", "VAT_PAYER"] })
  taxRegime!: "NON_VAT_PAYER" | "VAT_PAYER";

  @ApiProperty({ type: "integer", minimum: 0, maximum: 10_000 })
  vatRateBasisPoints!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  netAmountMinor!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  vatAmountMinor!: number;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  depositMinor!: number;

  @ApiProperty({ type: "object", additionalProperties: true })
  termsSnapshot!: Record<string, unknown>;

  @ApiProperty({ type: "object", additionalProperties: true })
  inputSnapshot!: Record<string, unknown>;

  @ApiProperty({ type: OfferDeliveryDestinationDto })
  deliveryDestination!: OfferDeliveryDestinationDto;

  @ApiProperty({ type: [OfferShipmentPlanDto], minItems: 1 })
  shipmentPlans!: OfferShipmentPlanDto[];

  @ApiProperty({ type: OfferPaymentPolicyDto })
  paymentPolicy!: OfferPaymentPolicyDto;

  @ApiProperty({ type: [ModelOfferItemDto], minItems: 1 })
  items!: ModelOfferItemDto[];

  @ApiProperty({ type: [OfferPriceComponentDto], minItems: 1 })
  components!: OfferPriceComponentDto[];
}

export class OfferIssuedDto {
  @ApiProperty({ type: String, format: "uuid" })
  quoteId!: string;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
  })
  version!: number;

  @ApiProperty({ type: String })
  termsRevision!: string;

  @ApiProperty({ type: String })
  offerToken!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;
}

export class OfferPreviewItemDto {
  @ApiProperty({ type: "integer", minimum: 0 })
  ordinal!: number;

  @ApiProperty({ type: String, enum: ["MODEL"] })
  kind!: "MODEL";

  @ApiProperty({ type: String, format: "uuid" })
  sourceModelFileId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  modelGeometryId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  printConfigRevisionId!: string;

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  primaryReferenceSliceResultId!: string | null;

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  tailReferenceSliceResultId!: string | null;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
    nullable: true,
  })
  referencePartsPerPlate!: number | null;

  @ApiProperty({ type: String, enum: ["PLA", "PETG"] })
  material!: "PLA" | "PETG";

  @ApiProperty({ type: String, maxLength: 100, nullable: true })
  color!: string | null;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
  })
  quantity!: number;
}

export class OfferPreviewPriceComponentDto {
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
      "VAT",
    ],
  })
  kind!:
    | "ITEM_PRODUCTION"
    | "ITEM_QUANTITY"
    | "ITEM_POSTPROCESSING"
    | "ORDER_MIN_PRINT"
    | "ORDER_SMALL_SURCHARGE"
    | "SHIPMENT"
    | "EXPRESS"
    | "PAYMENT_FEE"
    | "VAT";

  @ApiProperty({
    type: String,
    enum: ["ORDER", "QUOTE_ITEM", "QUOTE_SHIPMENT_PLAN"],
  })
  scope!: "ORDER" | "QUOTE_ITEM" | "QUOTE_SHIPMENT_PLAN";

  @ApiProperty({ type: "integer", minimum: 0, nullable: true })
  quoteItemOrdinal!: number | null;

  @ApiProperty({ type: "integer", minimum: 0, nullable: true })
  shipmentPlanOrdinal!: number | null;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  amountMinor!: number;

  @ApiProperty({ type: "object", nullable: true, additionalProperties: true })
  allocation!: Record<string, unknown> | null;
}

export class OfferPaymentScheduleDto {
  @ApiProperty({ type: "integer", minimum: 0 })
  sequence!: number;

  @ApiProperty({ type: String, enum: ["DEPOSIT", "BALANCE"] })
  role!: "DEPOSIT" | "BALANCE";

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  grossAmountMinor!: number;

  @ApiProperty({ type: "integer", minimum: 0 })
  feeRateBasisPoints!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  feeFixedMinor!: number;
}

export class OfferPreviewDto {
  @ApiProperty({ type: String, format: "uuid" })
  quoteId!: string;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
  })
  version!: number;

  @ApiProperty({ type: String })
  termsRevision!: string;

  @ApiProperty({ type: String })
  summary!: string;

  @ApiProperty({ type: "object", additionalProperties: true })
  termsSnapshot!: Record<string, unknown>;

  @ApiProperty({ type: String })
  currency!: string;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  contractTotalMinor!: number;

  @ApiProperty({ type: String, enum: ["NON_VAT_PAYER", "VAT_PAYER"] })
  taxRegime!: "NON_VAT_PAYER" | "VAT_PAYER";

  @ApiProperty({ type: "integer", minimum: 0, maximum: 10_000 })
  vatRateBasisPoints!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  netAmountMinor!: number;

  @ApiProperty({
    type: "integer",
    minimum: 0,
    maximum: JAVASCRIPT_SAFE_INTEGER_MAX,
  })
  vatAmountMinor!: number;

  @ApiProperty({ type: [OfferPreviewItemDto] })
  items!: OfferPreviewItemDto[];

  @ApiProperty({ type: OfferDeliveryDestinationDto })
  deliveryDestination!: OfferDeliveryDestinationDto;

  @ApiProperty({ type: [OfferShipmentPlanDto] })
  shipmentPlans!: OfferShipmentPlanDto[];

  @ApiProperty({ type: [OfferPreviewPriceComponentDto] })
  components!: OfferPreviewPriceComponentDto[];

  @ApiProperty({ type: [OfferPaymentScheduleDto] })
  paymentSchedules!: OfferPaymentScheduleDto[];

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;

  @ApiPropertyOptional({ type: String, format: "date", nullable: true })
  promisedDate!: string | null;
}

export class AcceptOfferDto {
  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
  })
  version!: number;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  termsRevision!: string;
}

export class RejectOfferDto extends AcceptOfferDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 2_000,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  reason?: string;
}

export class AcceptedOfferDto {
  @ApiProperty({ type: String, format: "uuid" })
  orderId!: string;

  @ApiProperty({ type: String })
  publicReference!: string;

  @ApiProperty({ type: String, enum: ["DRAFT"] })
  status!: "DRAFT";
}

export class QuoteRequestStatusDto {
  @ApiProperty({ type: String, format: "uuid" })
  requestId!: string;

  @ApiProperty({
    type: String,
    enum: ["IN_REVIEW", "REJECTED", "EXPIRED"],
  })
  status!: "IN_REVIEW" | "REJECTED" | "EXPIRED";
}
