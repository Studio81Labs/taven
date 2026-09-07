import {
  ApiProperty,
  ApiPropertyOptional,
  ApiSchema,
  type ApiSchemaOptions,
} from "@nestjs/swagger";

const PRE_NORMALIZED_SLUG = "^\\s*[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\\s*$";
const MAX_INPUT_LENGTH = 256;
const CLOSED_OBJECT_SCHEMA: ApiSchemaOptions & { additionalProperties: false } =
  {
    additionalProperties: false,
  };

/**
 * Privacy-minimized campaign attribution accepted on new public flows.
 * Labels are normalized server-side and never carry URL, referrer, or contact
 * data into reporting.
 */
@ApiSchema(CLOSED_OBJECT_SCHEMA)
export class AttributionDto {
  @ApiProperty({
    enum: ["direct", "organic", "paid", "referral", "unknown"],
  })
  channel!: "direct" | "organic" | "paid" | "referral" | "unknown";

  @ApiPropertyOptional({
    type: String,
    maxLength: MAX_INPUT_LENGTH,
    pattern: PRE_NORMALIZED_SLUG,
    description:
      "ASCII slug input; leading/trailing whitespace is trimmed and letters are lowercased before the stored label is limited to 64 characters.",
  })
  source?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: MAX_INPUT_LENGTH,
    pattern: PRE_NORMALIZED_SLUG,
    description:
      "ASCII slug input; leading/trailing whitespace is trimmed and letters are lowercased before the stored label is limited to 64 characters.",
  })
  medium?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: MAX_INPUT_LENGTH,
    pattern: PRE_NORMALIZED_SLUG,
    description:
      "ASCII slug input; leading/trailing whitespace is trimmed and letters are lowercased before the stored label is limited to 64 characters.",
  })
  campaign?: string;
}
