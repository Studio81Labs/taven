import { ApiProperty } from "@nestjs/swagger";

const NON_BLANK_TEXT_PATTERN = "\\S";

export class PaymentCapabilitiesDto {
  @ApiProperty({ type: String })
  provider!: string;

  @ApiProperty({ type: [String], enum: ["CARD", "BANK_TRANSFER"] })
  methods!: Array<"CARD" | "BANK_TRANSFER">;
}

export class CreateCheckoutPaymentDto {
  @ApiProperty({ type: String, format: "email", maxLength: 320 })
  email!: string;

  @ApiProperty({ type: String, maxLength: 200 })
  fullName!: string;

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
