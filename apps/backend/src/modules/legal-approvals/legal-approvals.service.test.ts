import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { LegalApprovalsService } from "./legal-approvals.service";

describe("LegalApprovalsService", () => {
  it("fails closed when reading the database clock fails", async () => {
    const service = new LegalApprovalsService({
      $queryRaw: vi.fn().mockRejectedValue(new Error("database unavailable")),
    } as never);

    const error = await service
      .availability()
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      code: "LAUNCH_APPROVAL_REQUIRED",
      message: "Legal approval time is unavailable",
    });
  });
});
