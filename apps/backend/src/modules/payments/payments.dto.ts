import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const NON_BLANK_TEXT_PATTERN = "\\S";

export class CheckoutLegalDocumentsDto {
  @ApiProperty({ type: String })
  termsRevision!: string;

  @ApiProperty({ type: String })
  claimPolicyRevision!: string;

  @ApiProperty({ type: String, nullable: true })
  photoConsentRevision!: string | null;
}

export class PaymentCapabilitiesDto {
  @ApiProperty({ type: Boolean })
  available!: boolean;

  @ApiProperty({ type: String })
  provider!: string;

  @ApiProperty({ type: [String], enum: ["CARD", "BANK_TRANSFER"] })
  methods!: Array<"CARD" | "BANK_TRANSFER">;

  @ApiProperty({ type: CheckoutLegalDocumentsDto, nullable: true })
  legalDocuments!: CheckoutLegalDocumentsDto | null;
}

export class CheckoutBillingDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  name!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  addressLine1!: string;

  @ApiPropertyOptional({ type: String, maxLength: 200 })
  addressLine2?: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  city!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 20,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  postalCode!: string;

  @ApiProperty({
    type: String,
    minLength: 2,
    maxLength: 2,
    pattern: "^[A-Z]{2}$",
  })
  countryCode!: string;

  @ApiPropertyOptional({ type: String, maxLength: 200 })
  companyName?: string;

  @ApiPropertyOptional({ type: String, maxLength: 50 })
  companyId?: string;

  @ApiPropertyOptional({ type: String, maxLength: 50 })
  vatId?: string;
}

export class CreateCheckoutPaymentDto {
  @ApiProperty({ type: String, format: "email", maxLength: 320 })
  email!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 200,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  fullName!: string;

  @ApiProperty({ type: CheckoutBillingDto })
  billing!: CheckoutBillingDto;

  @ApiProperty({ type: String, enum: ["CARD", "BANK_TRANSFER"] })
  method!: "CARD" | "BANK_TRANSFER";

  @ApiProperty({ type: Boolean })
  acceptTerms!: boolean;

  @ApiProperty({ type: Boolean })
  acceptClaimPolicy!: boolean;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  termsRevision!: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: 100,
    pattern: NON_BLANK_TEXT_PATTERN,
  })
  claimPolicyRevision!: string;

  @ApiProperty({ type: Boolean })
  acknowledgeWithdrawalException!: boolean;

  @ApiProperty({ type: Boolean })
  photoPublicationConsent!: boolean;

  @ApiPropertyOptional({ type: String, maxLength: 100, nullable: true })
  photoConsentRevision?: string | null;
}

export class CheckoutPaymentDto {
  @ApiProperty({ type: String, format: "uuid" })
  paymentId!: string;

  @ApiProperty({ type: String })
  provider!: string;

  @ApiProperty({ type: String, enum: ["CARD", "BANK_TRANSFER"] })
  method!: "CARD" | "BANK_TRANSFER";

  @ApiProperty({
    type: String,
    enum: [
      "CREATED",
      "PENDING",
      "CAPTURED",
      "FAILED",
      "VOIDED",
      "REFUND_PENDING",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
    ],
  })
  status!: string;

  @ApiProperty({
    type: "integer",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  amountMinor!: number;

  @ApiProperty({ type: String, minLength: 3, maxLength: 3 })
  currency!: string;

  @ApiProperty({ type: String, format: "uri", nullable: true })
  checkoutUrl!: string | null;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;
}

export class PaymentWebhookAcceptedDto {
  @ApiProperty({ type: String })
  outcome!: string;
}
