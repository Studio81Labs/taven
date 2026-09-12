import { ApiProperty } from "@nestjs/swagger";

export class LegalDocumentAvailabilityRecordDto {
  @ApiProperty({ type: String }) revision!: string;
  @ApiProperty({ type: String, enum: ["draft", "approved"] }) status!:
    "draft" | "approved";
  @ApiProperty({ type: String, nullable: true, format: "date-time" })
  effectiveAt!: string | null;
  @ApiProperty({ type: Boolean }) effective!: boolean;
}

export class LegalDocumentAvailabilityDocumentsDto {
  @ApiProperty({ type: LegalDocumentAvailabilityRecordDto })
  terms!: LegalDocumentAvailabilityRecordDto;
  @ApiProperty({ type: LegalDocumentAvailabilityRecordDto })
  claims!: LegalDocumentAvailabilityRecordDto;
  @ApiProperty({ type: LegalDocumentAvailabilityRecordDto })
  privacy!: LegalDocumentAvailabilityRecordDto;
  @ApiProperty({ type: LegalDocumentAvailabilityRecordDto })
  prohibitedContent!: LegalDocumentAvailabilityRecordDto;
  @ApiProperty({ type: LegalDocumentAvailabilityRecordDto })
  retention!: LegalDocumentAvailabilityRecordDto;
  @ApiProperty({ type: LegalDocumentAvailabilityRecordDto })
  photoConsent!: LegalDocumentAvailabilityRecordDto;
}

export class LegalDocumentAvailabilityDto {
  @ApiProperty({ type: Number, enum: [1] }) schemaVersion!: 1;
  @ApiProperty({ type: String }) policyRevision!: string;
  @ApiProperty({ type: String, format: "date-time" }) evaluatedAt!: string;
  @ApiProperty({ type: LegalDocumentAvailabilityDocumentsDto })
  documents!: LegalDocumentAvailabilityDocumentsDto;
}
