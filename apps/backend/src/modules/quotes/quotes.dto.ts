import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const JAVASCRIPT_SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

export class QuoteContactDto {
  @ApiProperty({ type: String, maxLength: 200 })
  name!: string;

  @ApiProperty({ type: String, format: "email", maxLength: 320 })
  email!: string;

  @ApiPropertyOptional({ type: String, maxLength: 50 })
  phone?: string;
}

export class CreateQuoteRequestDto {
  @ApiProperty({ type: String, minLength: 10, maxLength: 10_000 })
  description!: string;

  @ApiPropertyOptional({ type: String, maxLength: 2_000 })
  purpose?: string;

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  measurements?: Record<string, unknown>;

  @ApiPropertyOptional({ type: String, format: "date" })
  requestedDate?: string;

  @ApiProperty({ type: QuoteContactDto })
  contact!: QuoteContactDto;

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  attribution?: Record<string, unknown>;
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

  @ApiPropertyOptional({ type: String, maxLength: 100 })
  color?: string;

  @ApiPropertyOptional({
    type: "integer",
    minimum: 1,
    maximum: POSTGRES_INTEGER_MAX,
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

export class IssueOfferDto {
  @ApiProperty({ type: String, minLength: 3, maxLength: 4_000 })
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

  @ApiProperty({ type: String, enum: ["ORDER", "QUOTE_ITEM"] })
  scope!: "ORDER" | "QUOTE_ITEM";

  @ApiProperty({ type: "integer", minimum: 0, nullable: true })
  quoteItemOrdinal!: number | null;

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

  @ApiProperty({ type: [OfferPreviewItemDto] })
  items!: OfferPreviewItemDto[];

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

  @ApiProperty({ type: String, maxLength: 100 })
  termsRevision!: string;
}

export class RejectOfferDto extends AcceptOfferDto {
  @ApiPropertyOptional({ type: String, maxLength: 2_000 })
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
