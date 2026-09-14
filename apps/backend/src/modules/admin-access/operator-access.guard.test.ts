import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { ALLOW_NODE_FREE_ADMIN_KEY } from "./allow-node-free-admin.decorator";
import { OperatorAccessGuard } from "./operator-access.guard";
import { OPERATOR_PERMISSIONS_KEY } from "./require-operator-permissions.decorator";
import { TRANSLATE_DATASTORE_AVAILABILITY_KEY } from "./translate-datastore-availability.decorator";

describe("OperatorAccessGuard", () => {
  it("maps authentication datastore outages to 503 only on marked legal routes", async () => {
    const request = { method: "GET", headers: {} };
    const reflector = {
      getAllAndOverride: vi.fn((key: string) => {
        if (key === TRANSLATE_DATASTORE_AVAILABILITY_KEY) return true;
        if (key === ALLOW_NODE_FREE_ADMIN_KEY) return false;
        if (key === OPERATOR_PERMISSIONS_KEY) return [];
        return undefined;
      }),
    };
    const guard = new OperatorAccessGuard(
      {
        authenticateRequest: vi.fn().mockRejectedValue({ code: "P1001" }),
      } as never,
      reflector as never,
    );
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({ setHeader: vi.fn() }),
      }),
    };

    const error = await guard
      .canActivate(context as never)
      .catch((reason) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
  });
});
