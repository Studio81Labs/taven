import {
  ApiProperty,
  ApiPropertyOptional,
  ApiSchema,
  type ApiSchemaOptions,
} from "@nestjs/swagger";

const SLUG = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
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

  @ApiPropertyOptional({ type: String, maxLength: 64, pattern: SLUG })
  source?: string;

  @ApiPropertyOptional({ type: String, maxLength: 64, pattern: SLUG })
  medium?: string;

  @ApiPropertyOptional({ type: String, maxLength: 64, pattern: SLUG })
  campaign?: string;
}
