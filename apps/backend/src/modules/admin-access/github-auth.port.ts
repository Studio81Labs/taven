export const GITHUB_AUTH = Symbol("GITHUB_AUTH");

export type GithubAuthenticatedUser = Readonly<{
  id: string;
  login: string;
}>;

export interface GithubAuth {
  exchangeCode(
    input: Readonly<{
      clientId: string;
      clientSecret: string;
      callbackUrl: string;
      code: string;
      verifier: string;
    }>,
  ): Promise<GithubAuthenticatedUser>;
}
