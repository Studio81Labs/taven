import { ApiProperty } from "@nestjs/swagger";

export class InitiateModelUploadDto {
  @ApiProperty({ type: String, enum: ["STL", "3MF", "STEP"], example: "STL" })
  format!: "STL" | "3MF" | "STEP";

  @ApiProperty({ type: String, example: "bracket.stl", maxLength: 255 })
  originalFilename!: string;

  @ApiProperty({ type: String, example: "model/stl", maxLength: 100 })
  contentType!: string;

  @ApiProperty({
    type: Number,
    example: 128_000,
    minimum: 1,
    maximum: 104_857_600,
  })
  sizeBytes!: number;

  @ApiProperty({
    type: String,
    example: "a".repeat(64),
    minLength: 64,
    maxLength: 64,
  })
  sha256!: string;
}

export class InitiatePhotoUploadDto {
  @ApiProperty({ type: String, enum: ["QUOTE_REFERENCE"] })
  kind!: "QUOTE_REFERENCE";

  @ApiProperty({ type: String, enum: ["QUOTE_REQUEST"] })
  scopeKind!: "QUOTE_REQUEST";

  @ApiProperty({ type: String, format: "uuid" })
  scopeId!: string;

  @ApiProperty({ type: String, example: "reference.jpg", maxLength: 255 })
  originalFilename!: string;

  @ApiProperty({
    type: String,
    enum: ["image/jpeg", "image/png", "image/webp"],
  })
  contentType!: string;

  @ApiProperty({
    type: Number,
    example: 256_000,
    minimum: 1,
    maximum: 20_971_520,
  })
  sizeBytes!: number;

  @ApiProperty({
    type: String,
    example: "b".repeat(64),
    minLength: 64,
    maxLength: 64,
  })
  sha256!: string;
}

export class UploadIntentResponseDto {
  @ApiProperty({ type: String, format: "uuid" })
  uploadId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  assetId!: string;

  @ApiProperty({
    type: String,
    description:
      "One-time capability used to confirm and later read this upload. It is returned only when the intent is created.",
  })
  accessToken!: string;

  @ApiProperty({ type: String, format: "uri" })
  uploadUrl!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;

  @ApiProperty({
    type: "object",
    additionalProperties: { type: "string" },
    example: {
      "content-type": "model/stl",
      "x-amz-checksum-sha256": "base64-checksum",
    },
  })
  requiredHeaders!: Record<string, string>;
}

export class ConfirmedUploadResponseDto {
  @ApiProperty({ type: String, format: "uuid" })
  uploadId!: string;

  @ApiProperty({ type: String, format: "uuid" })
  assetId!: string;

  @ApiProperty({ type: String, enum: ["MODEL_FILE", "PHOTO_ASSET"] })
  assetKind!: "MODEL_FILE" | "PHOTO_ASSET";

  @ApiProperty({ type: String, format: "date-time" })
  uploadedAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  deleteAfter!: string;
}

export class SignedDownloadResponseDto {
  @ApiProperty({ type: String, format: "uri" })
  downloadUrl!: string;

  @ApiProperty({ type: String, format: "date-time" })
  expiresAt!: string;
}

export class ReorderEligibilityResponseDto {
  @ApiProperty({ type: Boolean })
  eligible!: boolean;

  @ApiProperty({
    type: String,
    enum: ["AVAILABLE", "SOURCE_EXPIRED", "SOURCE_DELETED", "SOURCE_MISSING"],
  })
  reason!: "AVAILABLE" | "SOURCE_EXPIRED" | "SOURCE_DELETED" | "SOURCE_MISSING";

  @ApiProperty({
    type: Boolean,
    description:
      "True only when the original source is retained. Claim-recovery artifacts never satisfy this value.",
  })
  sourceAvailable!: boolean;
}
