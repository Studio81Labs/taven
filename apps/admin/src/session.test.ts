import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./api";
import {
  bootstrapSession,
  hasOperationalNode,
  hasPermission,
  resetSessionForTest,
  session,
} from "./session";

const operator = {
  operatorId: "00000000-0000-0000-0000-000000000001",
  role: "ADMIN",
  nodeIds: ["00000000-0000-0000-0000-000000000002"],
  permissions: ["operations:read", "metrics:read"],
  authenticationMethod: "GITHUB",
};

const successfulSession = () =>
  new Response(JSON.stringify({ operator, csrfToken: "test-csrf" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("session state", () => {
  beforeEach(() => resetSessionForTest());
  afterEach(() => vi.unstubAllGlobals());

  it("uses effective grants and clears protected state after a 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(successfulSession())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "expired" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await bootstrapSession();
    expect(hasOperationalNode()).toBe(true);
    expect(hasPermission("metrics:read")).toBe(true);
    await apiClient.GET("/admin/catalog/machine-capabilities", {});
    expect(session.phase).toBe("anonymous");
    expect(session.value).toBeNull();
  });

  it("does not restore an old response after the session is cleared", async () => {
    let complete: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      ),
    );
    const pending = bootstrapSession();
    resetSessionForTest();
    complete?.(successfulSession());
    await pending;
    expect(session.phase).toBe("anonymous");
    expect(session.value).toBeNull();
  });
});
