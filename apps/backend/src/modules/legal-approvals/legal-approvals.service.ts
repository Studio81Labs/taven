import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  LEGAL_DOCUMENT_KEYS,
  legalApprovalRequired,
  type EvaluatedLegalApprovals,
  type LegalDocumentKey,
} from "./legal-approvals.catalog";

type QueryClient = Pick<PrismaService, "$queryRaw" | "legalDocument">;

@Injectable()
export class LegalApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Public reads use a single database snapshot and the server clock. */
  async availability(): Promise<EvaluatedLegalApprovals> {
    try {
      return await this.prisma.$transaction(
        async (tx) => this.readAt(tx, await databaseNow(tx)),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    } catch (error) {
      if (isApprovalError(error)) throw error;
      throw legalApprovalRequired("Legal approval metadata is unavailable");
    }
  }

  /**
   * Fresh writers call this after idempotency lookup and before their aggregate
   * locks. The row locks serialize publication changes with legal selection.
   */
  async lockAndRead(
    tx: Prisma.TransactionClient,
    requiredKeys: readonly LegalDocumentKey[],
  ): Promise<{ observedAt: Date; approvals: EvaluatedLegalApprovals }> {
    try {
      await this.lock(tx, requiredKeys);
      const observedAt = await databaseNow(tx);
      return { observedAt, approvals: await this.readAt(tx, observedAt) };
    } catch (error) {
      if (isApprovalError(error)) throw error;
      throw legalApprovalRequired("Legal approval metadata is unavailable");
    }
  }

  /** Acquire the legal locks without choosing a decision instant yet. */
  async lock(
    tx: Prisma.TransactionClient,
    requiredKeys: readonly LegalDocumentKey[],
  ): Promise<void> {
    try {
      await lockLegalDocuments(tx, requiredKeys);
    } catch (error) {
      if (isApprovalError(error)) throw error;
      throw legalApprovalRequired("Legal approval metadata is unavailable");
    }
  }

  /** Read a caller-supplied transaction at its already-recorded decision time. */
  async readAt(
    client: QueryClient,
    observedAt: Date,
  ): Promise<EvaluatedLegalApprovals> {
    const documents = await client.legalDocument.findMany({
      where: { key: { in: [...LEGAL_DOCUMENT_KEYS] } },
      include: {
        revisions: {
          where: { status: "DRAFT" },
          orderBy: { sequence: "desc" },
          take: 1,
          select: {
            id: true,
            revisionCode: true,
            effectiveAt: true,
            contentHash: true,
          },
        },
        publications: {
          where: {
            cancelledAt: null,
            startsAt: { lte: observedAt },
            OR: [{ endsAt: null }, { endsAt: { gt: observedAt } }],
          },
          orderBy: { startsAt: "desc" },
          take: 1,
          include: {
            revision: {
              select: {
                id: true,
                revisionCode: true,
                effectiveAt: true,
                contentHash: true,
                status: true,
              },
            },
          },
        },
      },
      orderBy: { key: "asc" },
    });
    const byKey = new Map(
      documents.map((document) => [document.key, document]),
    );
    const selected = LEGAL_DOCUMENT_KEYS.map((key) => {
      const document = byKey.get(key);
      const publication = document?.publications[0];
      const revision = publication?.revision;
      const draft = document?.revisions[0];
      const effective =
        !!revision &&
        revision.status === "APPROVED" &&
        !!revision.revisionCode &&
        !!revision.effectiveAt &&
        revision.effectiveAt <= observedAt;
      return {
        key,
        revision: effective
          ? revision.revisionCode!
          : (draft?.revisionCode ?? `draft:${key}`),
        revisionId: effective ? revision.id : null,
        status: effective ? ("approved" as const) : ("draft" as const),
        effectiveAt: effective ? revision.effectiveAt!.toISOString() : null,
        contentHash: effective ? revision.contentHash : null,
        effective,
        publicationId: publication?.id ?? null,
      };
    });
    return {
      schemaVersion: 1,
      policyRevision: createHash("sha256")
        .update(
          JSON.stringify(
            selected.map(({ key, revisionId, publicationId, effective }) => ({
              key,
              revisionId,
              publicationId,
              effective,
            })),
          ),
        )
        .digest("hex"),
      evaluatedAt: observedAt.toISOString(),
      documents: Object.fromEntries(
        selected.map(
          ({
            key,
            revision,
            revisionId,
            status,
            effectiveAt,
            contentHash,
            effective,
          }) => [
            key,
            {
              key,
              revision,
              revisionId,
              status,
              effectiveAt,
              contentHash,
              effective,
            },
          ],
        ),
      ) as unknown as EvaluatedLegalApprovals["documents"],
    };
  }
}

async function lockLegalDocuments(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  keys: readonly LegalDocumentKey[],
): Promise<void> {
  const canonicalKeys = [...new Set(keys)].sort();
  if (canonicalKeys.length === 0) return;
  const rows = await tx.$queryRaw<Array<{ key: string }>>`
    SELECT key
    FROM "legal_documents"
    WHERE key IN (${Prisma.join(canonicalKeys)})
    ORDER BY key
    FOR SHARE
  `;
  if (rows.length !== canonicalKeys.length) {
    throw legalApprovalRequired("Legal approval metadata is unavailable");
  }
}

export async function databaseNow(
  client: Pick<PrismaService, "$queryRaw">,
): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT clock_timestamp() AS observed_at
  `;
  const observedAt = rows[0]?.observed_at;
  if (!observedAt) {
    throw legalApprovalRequired("Legal approval time is unavailable");
  }
  return observedAt;
}

function isApprovalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "getStatus" in error &&
    typeof error.getStatus === "function"
  );
}
