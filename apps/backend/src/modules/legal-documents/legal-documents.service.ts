import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { LegalRevisionStatus, Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperatorContext } from "../admin-access/operator-context";
import { requireOperatorPermission } from "../admin-access/operator-command";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { AuditService } from "../audit/audit.service";
import {
  canonicalJson,
  type CanonicalJson,
} from "../resources/resource-identity";
import type {
  ApproveLegalRevisionDto,
  ArchiveLegalPublicationDto,
  CancelLegalPublicationDto,
  CreateLegalDraftDto,
  LegalDocumentDetailDto,
  LegalDocumentSectionDto,
  LegalDocumentSummaryDto,
  LegalPublicationSummaryDto,
  LegalRevisionDetailDto,
  LegalRevisionSummaryDto,
  PublicLegalRevisionDto,
  PublishLegalRevisionDto,
  UpdateLegalDraftDto,
} from "./legal-documents.dto";

type Transaction = Prisma.TransactionClient;

export const MAX_LEGAL_PAYLOAD_BYTES = 256 * 1024;
export const REVISION_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

@Injectable()
export class LegalDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listDocuments(): Promise<LegalDocumentSummaryDto[]> {
    const docs = await this.prisma.legalDocument.findMany({
      orderBy: { key: "asc" },
      include: {
        publications: {
          where: { cancelledAt: null },
          orderBy: { startsAt: "desc" },
          include: { revision: true },
        },
        revisions: {
          orderBy: { sequence: "desc" },
        },
      },
    });

    const now = new Date();
    return docs.map((doc) => {
      const activePub = doc.publications.find(
        (p) => p.startsAt <= now && (p.endsAt === null || p.endsAt > now),
      );
      const pendingPub = doc.publications.find((p) => p.startsAt > now);
      const drafts = doc.revisions.filter((r) => r.status === "DRAFT");
      const latestDraft = drafts[0];

      return {
        id: doc.id,
        key: doc.key,
        documentId: doc.documentId,
        generation: doc.generation,
        ...(activePub
          ? { activePublication: toPublicationSummary(activePub) }
          : {}),
        ...(pendingPub
          ? { pendingPublication: toPublicationSummary(pendingPub) }
          : {}),
        draftRevisionsCount: drafts.length,
        ...(latestDraft ? { latestDraft: toRevisionSummary(latestDraft) } : {}),
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      };
    });
  }

  async getDocumentByKey(
    key: string,
    cursor?: string,
    limit = 25,
  ): Promise<LegalDocumentDetailDto> {
    const doc = await this.prisma.legalDocument.findUnique({
      where: { key },
      include: {
        publications: {
          where: { cancelledAt: null },
          orderBy: { startsAt: "desc" },
          include: { revision: true },
        },
      },
    });

    if (!doc) {
      throw new NotFoundException(`Legal document '${key}' was not found`);
    }

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("Revision limit is invalid");
    }

    let cursorSequence: number | undefined;
    if (cursor !== undefined) {
      cursorSequence = Number.parseInt(cursor, 10);
      if (!Number.isSafeInteger(cursorSequence) || cursorSequence < 1) {
        throw new BadRequestException("Revision cursor is invalid");
      }
    }

    const revisions = await this.prisma.legalDocumentRevision.findMany({
      where: {
        documentId: doc.id,
        ...(cursorSequence !== undefined
          ? { sequence: { lt: cursorSequence } }
          : {}),
      },
      orderBy: { sequence: "desc" },
      take: limit + 1,
    });

    const page = revisions.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      revisions.length > limit && last ? String(last.sequence) : undefined;

    const now = new Date();
    const activePub = doc.publications.find(
      (p) => p.startsAt <= now && (p.endsAt === null || p.endsAt > now),
    );
    const pendingPub = doc.publications.find((p) => p.startsAt > now);
    const draftCount = await this.prisma.legalDocumentRevision.count({
      where: { documentId: doc.id, status: "DRAFT" },
    });
    const latestDraft = page.find((r) => r.status === "DRAFT");

    return {
      id: doc.id,
      key: doc.key,
      documentId: doc.documentId,
      generation: doc.generation,
      ...(activePub
        ? { activePublication: toPublicationSummary(activePub) }
        : {}),
      ...(pendingPub
        ? { pendingPublication: toPublicationSummary(pendingPub) }
        : {}),
      draftRevisionsCount: draftCount,
      ...(latestDraft ? { latestDraft: toRevisionSummary(latestDraft) } : {}),
      revisions: page.map(toRevisionDetail),
      ...(nextCursor ? { nextCursor } : {}),
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  async createDraft(
    operator: OperatorContext,
    key: string,
    dto: CreateLegalDraftDto,
  ): Promise<LegalRevisionDetailDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.LEGAL_WRITE);

    const title = dto.title.trim();
    if (!title || title.length > 255) {
      throw new BadRequestException("Draft title is invalid");
    }
    const summary = dto.summary.trim();
    if (!summary) {
      throw new BadRequestException("Draft summary is invalid");
    }
    const sections = normalizeLegalSections(dto.sections);
    assertContentSize({ title, summary, sections });
    const contentHash = computeLegalRevisionContentHash({
      contentVersion: 1,
      title,
      summary,
      sections,
    });

    return await this.prisma.$transaction(async (tx) => {
      const doc = await tx.legalDocument.findUnique({ where: { key } });
      if (!doc) {
        throw new NotFoundException(`Legal document '${key}' was not found`);
      }

      // Rank 1: Acquire exclusive row lock on legal_document
      await tx.$queryRaw`SELECT id FROM "legal_documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;

      if (doc.generation !== dto.expectedGeneration) {
        throw new ConflictException("Document generation mismatch");
      }

      const latestSeq = await tx.legalDocumentRevision.aggregate({
        where: { documentId: doc.id },
        _max: { sequence: true },
      });
      const nextSequence = (latestSeq._max.sequence ?? 0) + 1;

      const revision = await tx.legalDocumentRevision.create({
        data: {
          documentId: doc.id,
          sequence: nextSequence,
          editVersion: 1,
          status: LegalRevisionStatus.DRAFT,
          contentVersion: 1,
          title,
          summary,
          sections: sections as unknown as Prisma.InputJsonValue,
          contentHash,
        },
      });

      await tx.legalDocument.update({
        where: { id: doc.id },
        data: { generation: { increment: 1 } },
      });

      await this.audit.recordLegalOperator(tx, operator, {
        legalDocumentId: doc.id,
        eventType: "legal_document.draft_created",
        reasonCode: "LEGAL_DRAFT_CREATED",
        reason: "Draft revision created",
        payload: {
          operation: "draft_created",
          documentId: doc.id,
          revisionId: revision.id,
          contentHash: revision.contentHash,
        },
      });

      return toRevisionDetail(revision);
    });
  }

  async updateDraft(
    operator: OperatorContext,
    key: string,
    revisionId: string,
    dto: UpdateLegalDraftDto,
  ): Promise<LegalRevisionDetailDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.LEGAL_WRITE);

    const title = dto.title.trim();
    if (!title || title.length > 255) {
      throw new BadRequestException("Draft title is invalid");
    }
    const summary = dto.summary.trim();
    if (!summary) {
      throw new BadRequestException("Draft summary is invalid");
    }
    const sections = normalizeLegalSections(dto.sections);
    assertContentSize({ title, summary, sections });
    const contentHash = computeLegalRevisionContentHash({
      contentVersion: 1,
      title,
      summary,
      sections,
    });

    return await this.prisma.$transaction(async (tx) => {
      const doc = await tx.legalDocument.findUnique({ where: { key } });
      if (!doc) {
        throw new NotFoundException(`Legal document '${key}' was not found`);
      }

      await tx.$queryRaw`SELECT id FROM "legal_documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;

      const revision = await tx.legalDocumentRevision.findUnique({
        where: { id: revisionId },
      });
      if (!revision || revision.documentId !== doc.id) {
        throw new NotFoundException("Revision was not found");
      }
      if (revision.status !== LegalRevisionStatus.DRAFT) {
        throw new ConflictException("Cannot edit an approved revision");
      }
      if (revision.editVersion !== dto.expectedEditVersion) {
        throw new ConflictException("Draft edit version mismatch");
      }

      const updated = await tx.legalDocumentRevision.update({
        where: { id: revision.id },
        data: {
          title,
          summary,
          sections: sections as unknown as Prisma.InputJsonValue,
          contentHash,
          editVersion: { increment: 1 },
        },
      });

      await this.audit.recordLegalOperator(tx, operator, {
        legalDocumentId: doc.id,
        eventType: "legal_document.draft_updated",
        reasonCode: "LEGAL_DRAFT_UPDATED",
        reason: "Draft revision updated",
        payload: {
          operation: "draft_updated",
          documentId: doc.id,
          revisionId: updated.id,
          contentHash: updated.contentHash,
        },
      });

      return toRevisionDetail(updated);
    });
  }

  async approveRevision(
    operator: OperatorContext,
    key: string,
    revisionId: string,
    dto: ApproveLegalRevisionDto,
  ): Promise<LegalRevisionDetailDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.LEGAL_WRITE);

    const revisionCode = dto.revisionCode.trim();
    if (!REVISION_CODE_PATTERN.test(revisionCode)) {
      throw new BadRequestException("Revision code is invalid");
    }
    const effectiveAtDate = new Date(dto.effectiveAt);
    if (Number.isNaN(effectiveAtDate.getTime())) {
      throw new BadRequestException("Effective date is invalid");
    }
    const approvalEvidence = dto.approvalEvidence.trim();
    if (!approvalEvidence || approvalEvidence.length > 5000) {
      throw new BadRequestException("Approval evidence is invalid");
    }
    const reason = dto.reason.trim();
    const reasonCode = dto.reasonCode.trim();
    if (!reason || reason.length > 1000) {
      throw new BadRequestException("Reason is invalid");
    }
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(reasonCode)) {
      throw new BadRequestException("Reason code is invalid");
    }

    return await this.prisma.$transaction(async (tx) => {
      const doc = await tx.legalDocument.findUnique({ where: { key } });
      if (!doc) {
        throw new NotFoundException(`Legal document '${key}' was not found`);
      }

      await tx.$queryRaw`SELECT id FROM "legal_documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;

      const revision = await tx.legalDocumentRevision.findUnique({
        where: { id: revisionId },
      });
      if (!revision || revision.documentId !== doc.id) {
        throw new NotFoundException("Revision was not found");
      }
      if (revision.status !== LegalRevisionStatus.DRAFT) {
        throw new ConflictException("Revision is already approved");
      }
      if (revision.contentHash !== dto.expectedContentHash) {
        throw new ConflictException("Revision content hash mismatch");
      }

      const existingCode = await tx.legalDocumentRevision.findUnique({
        where: { revisionCode },
      });
      if (existingCode && existingCode.id !== revision.id) {
        throw new ConflictException("Revision code is already in use");
      }

      const now = await databaseNow(tx);
      const approved = await tx.legalDocumentRevision.update({
        where: { id: revision.id },
        data: {
          status: LegalRevisionStatus.APPROVED,
          revisionCode,
          effectiveAt: effectiveAtDate,
          approvalEvidence,
          approvedBy: operator.operatorId,
          approvedAt: now,
        },
      });

      await this.audit.recordLegalOperator(tx, operator, {
        legalDocumentId: doc.id,
        eventType: "legal_document.revision_approved",
        reasonCode,
        reason,
        payload: {
          operation: "revision_approved",
          documentId: doc.id,
          revisionId: approved.id,
          contentHash: approved.contentHash,
        },
      });

      return toRevisionDetail(approved);
    });
  }

  async publishRevision(
    operator: OperatorContext,
    key: string,
    revisionId: string,
    dto: PublishLegalRevisionDto,
  ): Promise<LegalPublicationSummaryDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.LEGAL_WRITE);

    const reason = dto.reason.trim();
    const reasonCode = dto.reasonCode.trim();
    if (!reason || reason.length > 1000) {
      throw new BadRequestException("Reason is invalid");
    }
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(reasonCode)) {
      throw new BadRequestException("Reason code is invalid");
    }

    let parsedStartsAt: Date | undefined;
    if (dto.startsAt) {
      parsedStartsAt = new Date(dto.startsAt);
      if (Number.isNaN(parsedStartsAt.getTime())) {
        throw new BadRequestException("Publication startsAt is invalid");
      }
    }

    return await this.prisma.$transaction(async (tx) => {
      const doc = await tx.legalDocument.findUnique({ where: { key } });
      if (!doc) {
        throw new NotFoundException(`Legal document '${key}' was not found`);
      }

      await tx.$queryRaw`SELECT id FROM "legal_documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;

      if (doc.generation !== dto.expectedGeneration) {
        throw new ConflictException("Document generation mismatch");
      }

      const revision = await tx.legalDocumentRevision.findUnique({
        where: { id: revisionId },
      });
      if (!revision || revision.documentId !== doc.id) {
        throw new NotFoundException("Revision was not found");
      }
      if (revision.status !== LegalRevisionStatus.APPROVED) {
        throw new ConflictException("Only approved revisions can be published");
      }
      if (!revision.effectiveAt) {
        throw new ConflictException("Approved revision missing effectiveAt");
      }

      const decisionNow = await databaseNow(tx);

      // Check if a pending scheduled publication already exists
      const pending = await tx.legalDocumentPublication.findFirst({
        where: {
          documentId: doc.id,
          cancelledAt: null,
          startsAt: { gt: decisionNow },
        },
      });
      if (pending) {
        throw new ConflictException(
          "A scheduled publication is already pending for this document; cancel it first",
        );
      }

      // Check if this revision has ever had an uncancelled or already started publication
      const prior = await tx.legalDocumentPublication.findFirst({
        where: {
          revisionId: revision.id,
          OR: [
            { cancelledAt: null },
            {
              cancelledAt: { gte: tx.legalDocumentPublication.fields.startsAt },
            },
          ],
        },
      });
      if (prior) {
        throw new ConflictException(
          "Revision has already been published and cannot be republished",
        );
      }

      // Compute startsAt: max(revision.effectiveAt, startsAtProvided || decisionNow)
      const baseStartsAt = parsedStartsAt ?? decisionNow;
      let effectiveStartsAt =
        revision.effectiveAt > baseStartsAt
          ? revision.effectiveAt
          : baseStartsAt;
      if (effectiveStartsAt < decisionNow) {
        effectiveStartsAt = decisionNow;
      }

      // Query active publication
      const activePub = await tx.legalDocumentPublication.findFirst({
        where: {
          documentId: doc.id,
          cancelledAt: null,
          startsAt: { lte: decisionNow },
          OR: [{ endsAt: null }, { endsAt: { gt: decisionNow } }],
        },
      });

      if (activePub) {
        if (effectiveStartsAt <= decisionNow) {
          await tx.legalDocumentPublication.update({
            where: { id: activePub.id },
            data: { endsAt: decisionNow },
          });
        } else {
          await tx.legalDocumentPublication.update({
            where: { id: activePub.id },
            data: { endsAt: effectiveStartsAt },
          });
        }
      }

      const publication = await tx.legalDocumentPublication.create({
        data: {
          documentId: doc.id,
          revisionId: revision.id,
          startsAt: effectiveStartsAt,
          publishedBy: operator.operatorId,
          reason,
        },
        include: { revision: true },
      });

      await tx.legalDocument.update({
        where: { id: doc.id },
        data: { generation: { increment: 1 } },
      });

      await this.audit.recordLegalOperator(tx, operator, {
        legalDocumentId: doc.id,
        eventType: "legal_document.published",
        reasonCode,
        reason,
        payload: {
          operation: "published",
          documentId: doc.id,
          revisionId: revision.id,
          publicationId: publication.id,
          ...(activePub ? { previousPublicationId: activePub.id } : {}),
        },
      });

      return toPublicationSummary(publication);
    });
  }

  async cancelPublication(
    operator: OperatorContext,
    key: string,
    publicationId: string,
    dto: CancelLegalPublicationDto,
  ): Promise<LegalPublicationSummaryDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.LEGAL_WRITE);

    const reason = dto.reason.trim();
    const reasonCode = dto.reasonCode.trim();
    if (!reason || reason.length > 1000) {
      throw new BadRequestException("Reason is invalid");
    }
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(reasonCode)) {
      throw new BadRequestException("Reason code is invalid");
    }

    return await this.prisma.$transaction(async (tx) => {
      const doc = await tx.legalDocument.findUnique({ where: { key } });
      if (!doc) {
        throw new NotFoundException(`Legal document '${key}' was not found`);
      }

      await tx.$queryRaw`SELECT id FROM "legal_documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;

      if (doc.generation !== dto.expectedGeneration) {
        throw new ConflictException("Document generation mismatch");
      }

      const pub = await tx.legalDocumentPublication.findUnique({
        where: { id: publicationId },
        include: { revision: true },
      });
      if (!pub || pub.documentId !== doc.id) {
        throw new NotFoundException("Publication was not found");
      }
      if (pub.cancelledAt !== null) {
        throw new ConflictException("Publication is already cancelled");
      }

      const decisionNow = await databaseNow(tx);
      if (decisionNow >= pub.startsAt) {
        throw new ConflictException(
          "Cannot cancel a publication that has already started",
        );
      }

      const updated = await tx.legalDocumentPublication.update({
        where: { id: pub.id },
        data: { cancelledAt: decisionNow },
        include: { revision: true },
      });

      // Restore predecessor publication if its endsAt was chained to this publication
      const predecessor = await tx.legalDocumentPublication.findFirst({
        where: {
          documentId: doc.id,
          cancelledAt: null,
          endsAt: pub.startsAt,
        },
      });
      if (predecessor) {
        await tx.legalDocumentPublication.update({
          where: { id: predecessor.id },
          data: { endsAt: null },
        });
      }

      await tx.legalDocument.update({
        where: { id: doc.id },
        data: { generation: { increment: 1 } },
      });

      await this.audit.recordLegalOperator(tx, operator, {
        legalDocumentId: doc.id,
        eventType: "legal_document.publication_cancelled",
        reasonCode,
        reason,
        payload: {
          operation: "publication_cancelled",
          documentId: doc.id,
          publicationId: updated.id,
        },
      });

      return toPublicationSummary(updated);
    });
  }

  async archivePublication(
    operator: OperatorContext,
    key: string,
    publicationId: string,
    dto: ArchiveLegalPublicationDto,
  ): Promise<LegalPublicationSummaryDto> {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.LEGAL_WRITE);

    const reason = dto.reason.trim();
    const reasonCode = dto.reasonCode.trim();
    if (!reason || reason.length > 1000) {
      throw new BadRequestException("Reason is invalid");
    }
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(reasonCode)) {
      throw new BadRequestException("Reason code is invalid");
    }

    return await this.prisma.$transaction(async (tx) => {
      const doc = await tx.legalDocument.findUnique({ where: { key } });
      if (!doc) {
        throw new NotFoundException(`Legal document '${key}' was not found`);
      }

      await tx.$queryRaw`SELECT id FROM "legal_documents" WHERE "id" = ${doc.id}::uuid FOR UPDATE`;

      if (doc.generation !== dto.expectedGeneration) {
        throw new ConflictException("Document generation mismatch");
      }

      const pub = await tx.legalDocumentPublication.findUnique({
        where: { id: publicationId },
        include: { revision: true },
      });
      if (!pub || pub.documentId !== doc.id) {
        throw new NotFoundException("Publication was not found");
      }
      if (pub.cancelledAt !== null) {
        throw new ConflictException("Publication is cancelled");
      }

      const decisionNow = await databaseNow(tx);
      if (
        pub.startsAt > decisionNow ||
        (pub.endsAt !== null && pub.endsAt <= decisionNow)
      ) {
        throw new ConflictException("Publication is not currently active");
      }

      const updated = await tx.legalDocumentPublication.update({
        where: { id: pub.id },
        data: { endsAt: decisionNow },
        include: { revision: true },
      });

      await tx.legalDocument.update({
        where: { id: doc.id },
        data: { generation: { increment: 1 } },
      });

      await this.audit.recordLegalOperator(tx, operator, {
        legalDocumentId: doc.id,
        eventType: "legal_document.publication_archived",
        reasonCode,
        reason,
        payload: {
          operation: "publication_archived",
          documentId: doc.id,
          publicationId: updated.id,
        },
      });

      return toPublicationSummary(updated);
    });
  }

  async getPublicRevision(
    key: string,
    revisionCode: string,
  ): Promise<PublicLegalRevisionDto> {
    const doc = await this.prisma.legalDocument.findUnique({ where: { key } });
    if (!doc) {
      throw new NotFoundException(`Legal document '${key}' was not found`);
    }

    const revision = await this.prisma.legalDocumentRevision.findUnique({
      where: { revisionCode },
    });
    if (!revision || revision.documentId !== doc.id) {
      throw new NotFoundException(
        `Revision '${revisionCode}' was not found for '${key}'`,
      );
    }
    if (
      revision.status !== LegalRevisionStatus.APPROVED ||
      !revision.effectiveAt
    ) {
      throw new NotFoundException(
        `Revision '${revisionCode}' is not an approved revision`,
      );
    }

    const now = new Date();
    // Must have at least one publication that has started and was not cancelled before startsAt
    const publication = await this.prisma.legalDocumentPublication.findFirst({
      where: {
        revisionId: revision.id,
        startsAt: { lte: now },
        OR: [{ cancelledAt: null }, { cancelledAt: { gte: now } }],
      },
    });

    if (!publication) {
      throw new NotFoundException(
        `Revision '${revisionCode}' has not been published`,
      );
    }

    return {
      documentId: doc.documentId,
      key: doc.key,
      revisionCode: revision.revisionCode!,
      contentHash: revision.contentHash,
      title: revision.title,
      summary: revision.summary,
      sections: revision.sections as unknown as LegalDocumentSectionDto[],
      effectiveAt: revision.effectiveAt.toISOString(),
    };
  }
}

function assertContentSize(content: {
  title: string;
  summary: string;
  sections: LegalDocumentSectionDto[];
}): void {
  const bytes = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (bytes > MAX_LEGAL_PAYLOAD_BYTES) {
    throw new BadRequestException("Draft content exceeds 256 KiB limit");
  }
}

export function normalizeLegalSections(
  sections: LegalDocumentSectionDto[],
): LegalDocumentSectionDto[] {
  if (!Array.isArray(sections) || sections.length === 0) {
    throw new BadRequestException("Sections must be a non-empty array");
  }
  return sections.map((s) => {
    const title = s?.title?.trim();
    if (!title) {
      throw new BadRequestException("Section title must not be empty");
    }
    const paragraphs = s.paragraphs
      ?.map((p) => p.trim())
      .filter((p) => p.length > 0);
    const items = s.items?.map((i) => i.trim()).filter((i) => i.length > 0);
    const note = s.note?.trim();

    if (
      (!paragraphs || paragraphs.length === 0) &&
      (!items || items.length === 0) &&
      !note
    ) {
      throw new BadRequestException(
        "Each section must contain at least one paragraph, item, or note",
      );
    }

    const res: LegalDocumentSectionDto = { title };
    if (paragraphs && paragraphs.length > 0) res.paragraphs = paragraphs;
    if (items && items.length > 0) res.items = items;
    if (note) res.note = note;
    return res;
  });
}

export function computeLegalRevisionContentHash(content: {
  contentVersion: 1;
  title: string;
  summary: string;
  sections: LegalDocumentSectionDto[];
}): string {
  const serialized = canonicalJson(content as unknown as CanonicalJson);
  return createHash("sha256").update(serialized).digest("hex");
}

async function databaseNow(
  transaction: Pick<Transaction, "$queryRaw">,
): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  const observedAt = rows[0]?.now;
  if (!observedAt) throw new Error("Database clock is unavailable");
  return observedAt;
}

function toPublicationSummary(pub: {
  id: string;
  revisionId: string;
  revision?: { revisionCode: string | null } | null;
  startsAt: Date;
  endsAt: Date | null;
  cancelledAt: Date | null;
  publishedBy: string;
  reason: string;
  createdAt: Date;
}): LegalPublicationSummaryDto {
  return {
    id: pub.id,
    revisionId: pub.revisionId,
    ...(pub.revision?.revisionCode
      ? { revisionCode: pub.revision.revisionCode }
      : {}),
    startsAt: pub.startsAt.toISOString(),
    ...(pub.endsAt ? { endsAt: pub.endsAt.toISOString() } : {}),
    ...(pub.cancelledAt ? { cancelledAt: pub.cancelledAt.toISOString() } : {}),
    publishedBy: pub.publishedBy,
    reason: pub.reason,
    createdAt: pub.createdAt.toISOString(),
  };
}

function toRevisionSummary(rev: {
  id: string;
  sequence: number;
  editVersion: number;
  status: LegalRevisionStatus;
  contentVersion: number;
  title: string;
  summary: string;
  contentHash: string;
  revisionCode: string | null;
  effectiveAt: Date | null;
  approvalEvidence: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): LegalRevisionSummaryDto {
  return {
    id: rev.id,
    sequence: rev.sequence,
    editVersion: rev.editVersion,
    status: rev.status,
    contentVersion: rev.contentVersion,
    title: rev.title,
    summary: rev.summary,
    contentHash: rev.contentHash,
    ...(rev.revisionCode ? { revisionCode: rev.revisionCode } : {}),
    ...(rev.effectiveAt ? { effectiveAt: rev.effectiveAt.toISOString() } : {}),
    ...(rev.approvalEvidence ? { approvalEvidence: rev.approvalEvidence } : {}),
    ...(rev.approvedBy ? { approvedBy: rev.approvedBy } : {}),
    ...(rev.approvedAt ? { approvedAt: rev.approvedAt.toISOString() } : {}),
    createdAt: rev.createdAt.toISOString(),
    updatedAt: rev.updatedAt.toISOString(),
  };
}

function toRevisionDetail(
  rev: Parameters<typeof toRevisionSummary>[0] & { sections: unknown },
): LegalRevisionDetailDto {
  return {
    ...toRevisionSummary(rev),
    sections: rev.sections as LegalDocumentSectionDto[],
  };
}
