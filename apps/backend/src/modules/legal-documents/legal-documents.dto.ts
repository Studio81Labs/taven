import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class LegalDocumentSectionDto {
  @ApiProperty({ type: String })
  title!: string;

  @ApiPropertyOptional({ type: [String] })
  paragraphs?: string[];

  @ApiPropertyOptional({ type: [String] })
  items?: string[];

  @ApiPropertyOptional({ type: String })
  note?: string;
}

export class CreateLegalDraftDto {
  @ApiProperty({ type: Number })
  expectedGeneration!: number;

  @ApiProperty({ type: String, maxLength: 255 })
  title!: string;

  @ApiProperty({ type: String })
  summary!: string;

  @ApiProperty({ type: [LegalDocumentSectionDto] })
  sections!: LegalDocumentSectionDto[];
}

export class UpdateLegalDraftDto {
  @ApiProperty({ type: Number })
  expectedEditVersion!: number;

  @ApiProperty({ type: String, maxLength: 255 })
  title!: string;

  @ApiProperty({ type: String })
  summary!: string;

  @ApiProperty({ type: [LegalDocumentSectionDto] })
  sections!: LegalDocumentSectionDto[];
}

export class ApproveLegalRevisionDto {
  @ApiProperty({ type: String, description: "Expected SHA-256 content hash" })
  expectedContentHash!: string;

  @ApiProperty({ type: String, maxLength: 100 })
  revisionCode!: string;

  @ApiProperty({ type: String, format: "date-time" })
  effectiveAt!: string;

  @ApiProperty({ type: String })
  approvalEvidence!: string;

  @ApiProperty({ type: String, maxLength: 100 })
  reasonCode!: string;

  @ApiProperty({ type: String, maxLength: 1000 })
  reason!: string;
}

export class PublishLegalRevisionDto {
  @ApiProperty({ type: Number })
  expectedGeneration!: number;

  @ApiPropertyOptional({ type: String, format: "date-time" })
  startsAt?: string;

  @ApiProperty({ type: String, maxLength: 100 })
  reasonCode!: string;

  @ApiProperty({ type: String, maxLength: 1000 })
  reason!: string;
}

export class CancelLegalPublicationDto {
  @ApiProperty({ type: Number })
  expectedGeneration!: number;

  @ApiProperty({ type: String, maxLength: 100 })
  reasonCode!: string;

  @ApiProperty({ type: String, maxLength: 1000 })
  reason!: string;
}

export class ArchiveLegalPublicationDto {
  @ApiProperty({ type: Number })
  expectedGeneration!: number;

  @ApiProperty({ type: String, maxLength: 100 })
  reasonCode!: string;

  @ApiProperty({ type: String, maxLength: 1000 })
  reason!: string;
}

export class LegalPublicationSummaryDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid" })
  revisionId!: string;

  @ApiPropertyOptional({ type: String })
  revisionCode?: string;

  @ApiProperty({ type: String, format: "date-time" })
  startsAt!: string;

  @ApiPropertyOptional({ type: String, format: "date-time" })
  endsAt?: string;

  @ApiPropertyOptional({ type: String, format: "date-time" })
  cancelledAt?: string;

  @ApiProperty({ type: String, format: "uuid" })
  publishedBy!: string;

  @ApiProperty({ type: String })
  reason!: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;
}

export class LegalRevisionSummaryDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: Number })
  sequence!: number;

  @ApiProperty({ type: Number })
  editVersion!: number;

  @ApiProperty({ type: String, enum: ["DRAFT", "APPROVED"] })
  status!: "DRAFT" | "APPROVED";

  @ApiProperty({ type: Number })
  contentVersion!: number;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  summary!: string;

  @ApiProperty({ type: String })
  contentHash!: string;

  @ApiPropertyOptional({ type: String })
  revisionCode?: string;

  @ApiPropertyOptional({ type: String, format: "date-time" })
  effectiveAt?: string;

  @ApiPropertyOptional({ type: String })
  approvalEvidence?: string;

  @ApiPropertyOptional({ type: String, format: "uuid" })
  approvedBy?: string;

  @ApiPropertyOptional({ type: String, format: "date-time" })
  approvedAt?: string;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;
}

export class LegalRevisionDetailDto extends LegalRevisionSummaryDto {
  @ApiProperty({ type: [LegalDocumentSectionDto] })
  sections!: LegalDocumentSectionDto[];
}

export class LegalDocumentSummaryDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: String })
  documentId!: string;

  @ApiProperty({ type: Number })
  generation!: number;

  @ApiPropertyOptional({ type: LegalPublicationSummaryDto })
  activePublication?: LegalPublicationSummaryDto;

  @ApiPropertyOptional({ type: LegalPublicationSummaryDto })
  pendingPublication?: LegalPublicationSummaryDto;

  @ApiProperty({ type: Number })
  draftRevisionsCount!: number;

  @ApiPropertyOptional({ type: LegalRevisionSummaryDto })
  latestDraft?: LegalRevisionSummaryDto;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time" })
  updatedAt!: string;
}

export class LegalDocumentDetailDto extends LegalDocumentSummaryDto {
  @ApiProperty({ type: [LegalRevisionDetailDto] })
  revisions!: LegalRevisionDetailDto[];

  @ApiPropertyOptional({ type: String })
  nextCursor?: string;
}

export class PublicLegalRevisionDto {
  @ApiProperty({ type: String })
  documentId!: string;

  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: String })
  revisionCode!: string;

  @ApiProperty({ type: String })
  contentHash!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  summary!: string;

  @ApiProperty({ type: [LegalDocumentSectionDto] })
  sections!: LegalDocumentSectionDto[];

  @ApiProperty({ type: String, format: "date-time" })
  effectiveAt!: string;
}
