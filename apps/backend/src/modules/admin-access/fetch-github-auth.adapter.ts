import { Injectable, UnauthorizedException } from "@nestjs/common";
import type { GithubAuth, GithubAuthenticatedUser } from "./github-auth.port";

const GITHUB_REQUEST_TIMEOUT_MILLISECONDS = 10_000;

@Injectable()
export class FetchGithubAuthAdapter implements GithubAuth {
  async exchangeCode(
    input: Readonly<{
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
      code: string;
      verifier: string;
    }>,
  ): Promise<GithubAuthenticatedUser> {
    const tokenResponse = await this.request(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          redirect_uri: input.callbackUrl,
          code: input.code,
          code_verifier: input.verifier,
        }),
      },
    );
    if (!tokenResponse.ok) {
      throw new UnauthorizedException("GitHub authorization was not accepted");
    }
    const token = (await tokenResponse.json()) as { access_token?: unknown };
    if (
      typeof token.access_token !== "string" ||
      token.access_token.length < 10
    ) {
      throw new UnauthorizedException("GitHub authorization was not accepted");
    }
    const userResponse = await this.request("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token.access_token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    if (!userResponse.ok) {
      throw new UnauthorizedException("GitHub authorization was not accepted");
    }
    const user = (await userResponse.json()) as {
      id?: unknown;
      login?: unknown;
    };
    if (
      (typeof user.id !== "number" && typeof user.id !== "string") ||
      !/^[1-9][0-9]{0,28}$/.test(String(user.id)) ||
      typeof user.login !== "string" ||
      user.login.length === 0 ||
      user.login.length > 100
    ) {
      throw new UnauthorizedException("GitHub authorization was not accepted");
    }
    return { id: String(user.id), login: user.login };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MILLISECONDS),
      });
    } catch {
      throw new UnauthorizedException("GitHub authorization was not accepted");
    }
  }
}
