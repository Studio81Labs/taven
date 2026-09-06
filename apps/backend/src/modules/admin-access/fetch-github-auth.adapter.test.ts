import { UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchGithubAuthAdapter } from "./fetch-github-auth.adapter";

const input = {
  clientId: "github-client",
  clientSecret: "github-secret",
  callbackUrl: "https://api.example.test/admin/auth/github/callback",
  code: "authorization-code",
  verifier: "pkce-verifier",
};

describe("FetchGithubAuthAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("bounds both GitHub requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "github-access-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 42, login: "operator" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      new FetchGithubAuthAdapter().exchangeCode(input),
    ).resolves.toEqual({ id: "42", login: "operator" });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("maps GitHub transport failures to the stable authorization error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));

    await expect(
      new FetchGithubAuthAdapter().exchangeCode(input),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
