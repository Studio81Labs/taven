import { Material, PrintQuality } from "@prisma/client";
import { ApiProperty } from "@nestjs/swagger";

const UUID = { type: String, format: "uuid" } as const;

export class ReferenceProfileActivationNoticeDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: Number, enum: [1] })
  schemaVersion!: 1;

  @ApiProperty({ type: String, enum: ["REFERENCE_PROFILE_ACTIVATED"] })
  kind!: "REFERENCE_PROFILE_ACTIVATED";

  @ApiProperty(UUID)
  referenceProfileId!: string;

  @ApiProperty({ type: String, enum: Material })
  material!: Material;

  @ApiProperty({ type: String, enum: PrintQuality })
  quality!: PrintQuality;

  @ApiProperty({ type: String, format: "date-time" })
  activatedAt!: string;

  @ApiProperty({ type: String, enum: ["REVIEW_PRICE_LIST"] })
  action!: "REVIEW_PRICE_LIST";
}

export type ReferenceProfileActivationNoticeSource = Readonly<{
  id: string;
  material: Material;
  quality: PrintQuality;
  activatedAt: Date | null;
}>;

/** Maps a committed profile activation to its durable operator notice. */
export function referenceProfileActivationNotice(
  profile: ReferenceProfileActivationNoticeSource,
): ReferenceProfileActivationNoticeDto {
  if (!profile.activatedAt) {
    throw new Error("reference profile activation notice requires activatedAt");
  }
  return {
    id: `reference-profile-activated:${profile.id.toLowerCase()}`,
    schemaVersion: 1,
    kind: "REFERENCE_PROFILE_ACTIVATED",
    referenceProfileId: profile.id,
    material: profile.material,
    quality: profile.quality,
    activatedAt: profile.activatedAt.toISOString(),
    action: "REVIEW_PRICE_LIST",
  };
}
