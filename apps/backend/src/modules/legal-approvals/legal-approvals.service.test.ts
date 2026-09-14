import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LegalApprovalsService } from "./legal-approvals.service";

describe("LegalApprovalsService", () => {
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
