import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
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
});
