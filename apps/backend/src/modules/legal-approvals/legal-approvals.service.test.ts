import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LEGAL_DOCUMENT_KEYS } from "./legal-approvals.catalog";
import { LegalApprovalsController } from "./legal-approvals.controller";
import { LegalApprovalsService } from "./legal-approvals.service";

describe("LegalApprovalsService", () => {
  it("retains the effective revision identifier for writers", async () => {
    const observedAt = new Date("2026-09-15T07:42:00.000Z");
    const service = new LegalApprovalsService({} as never);

    const approvals = await service.readAt(
      {
        legalDocument: {
          findMany: vi.fn().mockResolvedValue([
            {
              key: "terms",
              revisions: [],
              publications: [
                {
                  revision: {
                    id: "terms-revision-id",
                    revisionCode: "terms-v1",
                    effectiveAt: observedAt,
                    contentHash: "a".repeat(64),
                    status: "APPROVED",
                  },
                },
              ],
            },
          ]),
        },
      } as never,
      observedAt,
    );

    expect(approvals.documents.terms).toMatchObject({
      effective: true,
      revision: "terms-v1",
      revisionId: "terms-revision-id",
    });
  });

  it("fails closed when the database snapshot cannot be read", async () => {
    const service = new LegalApprovalsService({
      $transaction: vi
        .fn()
        .mockRejectedValue(new Error("database unavailable")),
    } as never);

    const error = await service
      .availability()
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it("maps internal identifiers out of the public availability response", async () => {
    const evaluated = {
      schemaVersion: 1 as const,
      policyRevision: "policy-v1",
      evaluatedAt: "2026-09-15T07:42:00.000Z",
      documents: Object.fromEntries(
        LEGAL_DOCUMENT_KEYS.map((key) => [
          key,
          {
            key,
            revision: `${key}-v1`,
            revisionId: `${key}-internal-id`,
            status: "approved" as const,
            effectiveAt: "2026-09-15T07:42:00.000Z",
            contentHash: "a".repeat(64),
            effective: true,
          },
        ]),
      ),
    } as never;
    const controller = new LegalApprovalsController({
      availability: vi.fn().mockResolvedValue(evaluated),
    } as never);

    const response = await controller.availability();

    expect(response.documents.terms).toEqual({
      revision: "terms-v1",
      status: "approved",
      effectiveAt: "2026-09-15T07:42:00.000Z",
      contentHash: "a".repeat(64),
      effective: true,
    });
    expect(response.documents.terms).not.toHaveProperty("key");
    expect(response.documents.terms).not.toHaveProperty("revisionId");
  });
});
