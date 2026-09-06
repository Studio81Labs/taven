import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from "@nestjs/common";
import {
  OperatorAuthenticationMethod,
  OperatorLoginAttemptStatus,
  SecurityEventType,
  type Prisma,
} from "@prisma/client";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import {
  readAdminAccessConfig,
  type AdminAccessConfig,
  type GithubLoginConfig,
} from "./admin-access.config";
import { GITHUB_AUTH, type GithubAuth } from "./github-auth.port";
import type { AdminRequest, OperatorContext } from "./operator-context";
import { permissionsForRole } from "./operator-permissions";

const SESSION_IDLE_MILLISECONDS = 30 * 60 * 1_000;
const SESSION_ABSOLUTE_MILLISECONDS = 8 * 60 * 60 * 1_000;
const LOGIN_ATTEMPT_MILLISECONDS = 10 * 60 * 1_000;
const SECURITY_EVENT_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
const SESSION_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60 * 1_000;
const MAX_PASSWORD_FAILURES = 5;
const MAX_LOGIN_STARTS = 100;
const MAX_LOGIN_STARTS_PER_CLIENT = 10;
const LAST_SEEN_WRITE_MILLISECONDS = 60 * 1_000;
const GLOBAL_SUBJECT = "operator-login-global-subject";
const GLOBAL_CLIENT = "operator-login-global-client";

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAX_MEMORY = 128 * 1024 * 1024;
const DUMMY_PASSWORD_HASH =
  "scrypt$32768$8$1$MDEyMzQ1Njc4OWFiY2RlZg$nCmsIFU_k1mX8di2iPX8EGrBuEqNfiVHhkUiDLo5lHHRQpOPzECy22koavXfHYZ_WvLfdGEhWrK5zmG-7uGrOg";

type Transaction = Prisma.TransactionClient;

export type AuthSessionView = Readonly<{
  operator: OperatorContext;
  csrfToken: string;
}>;

export type GithubLoginStart = Readonly<{
  authorizationUrl: string;
  browserBinding: string;
}>;

@Injectable()
export class OperatorAuthService {
  private readonly config: AdminAccessConfig;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GITHUB_AUTH) private readonly github: GithubAuth,
  ) {
    this.config = readAdminAccessConfig();
  }

  methods(): readonly ["EMAIL_PASSWORD"] | readonly ["GITHUB"] {
    return this.config.environment === "development"
      ? ["EMAIL_PASSWORD"]
      : ["GITHUB"];
  }

  async loginWithDevelopmentPassword(
    input: Readonly<{ email: string; password: string }>,
    request: AdminRequest,
  ): Promise<AuthSessionView & { sessionToken: string }> {
    this.requireEnvironment("development");
    this.requireAllowedOrigin(request);
    const email = normalizeEmail(input.email);
    validatePassword(input.password);
    const subjectHash = digest(email);
    const clientHash = this.clientHash(request);
    const loginWindowStart = await this.claimLoginBudget(
      subjectHash,
      clientHash,
    );

    const credential =
      await this.prisma.operatorDevelopmentCredential.findFirst({
        where: { operator: { email, active: true } },
        include: {
          operator: { include: { nodeGrants: { include: { node: true } } } },
        },
      });
    const valid = await verifyPassword(
      input.password,
      credential?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );
    if (!credential || !valid) {
      await this.recordFailedLogin(subjectHash, clientHash, loginWindowStart);
      throw new UnauthorizedException(
        "Operator authentication was not accepted",
      );
    }
    return this.prisma.$transaction(async (transaction) => {
      await this.lockOperatorIdentity(transaction, credential.operatorId);
      await this.revokeOperatorSessions(transaction, credential.operatorId);
      return this.createSession(
        transaction,
        credential.operator,
        OperatorAuthenticationMethod.DEVELOPMENT_PASSWORD,
      );
    });
  }

  async startGithubLogin(request: AdminRequest): Promise<GithubLoginStart> {
    if (this.config.environment === "development") {
      throw new NotFoundException("GitHub operator login is unavailable");
    }
    this.requireAllowedOrigin(request);
    await this.claimLoginBudget(undefined, this.clientHash(request));
    const github = this.requiredGithubConfig();
    const state = randomToken();
    const browserBinding = randomToken();
    const verifier = randomToken();
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const now = await this.databaseNow();
    await this.prisma.operatorLoginAttempt.create({
      data: {
        stateHash: digest(state),
        browserBindingHash: digest(browserBinding),
        encryptedPkceVerifier: encrypt(verifier, github.attemptEncryptionKey),
        environment: this.config.environment,
        githubClientId: github.clientId,
        callbackUrl: github.callbackUrl,
        expiresAt: new Date(now.getTime() + LOGIN_ATTEMPT_MILLISECONDS),
      },
    });
    const authorizationUrl = new URL(
      "https://github.com/login/oauth/authorize",
    );
    authorizationUrl.searchParams.set("client_id", github.clientId);
    authorizationUrl.searchParams.set("redirect_uri", github.callbackUrl);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set("allow_signup", "false");
    authorizationUrl.searchParams.set("prompt", "select_account");
    return { authorizationUrl: authorizationUrl.toString(), browserBinding };
  }

  async completeGithubLogin(
    input: Readonly<{
      state: string;
      code: string;
      browserBinding: string | undefined;
    }>,
  ): Promise<{ completionUrl: string; sessionToken: string }> {
    if (this.config.environment === "development") {
      throw new NotFoundException("GitHub operator login is unavailable");
    }
    const github = this.requiredGithubConfig();
    validateOpaqueToken(input.state, "state");
    validateOpaqueToken(input.code, "code");
    const browserBindingHash = await this.claimGithubAttempt(input.state);
    if (
      !input.browserBinding ||
      !browserBindingHash ||
      !safeEqual(digest(input.browserBinding), browserBindingHash)
    ) {
      throw new UnauthorizedException("GitHub authorization was not accepted");
    }
    const attempt = await this.prisma.operatorLoginAttempt.findUnique({
      where: { stateHash: digest(input.state) },
    });
    if (!attempt || !attempt.encryptedPkceVerifier) {
      throw new UnauthorizedException("GitHub authorization was not accepted");
    }
    let attemptFinished = false;
    try {
      const verifier = decrypt(
        attempt.encryptedPkceVerifier,
        github.attemptEncryptionKey,
      );
      const user = await this.github.exchangeCode({
        clientId: github.clientId,
        clientSecret: github.clientSecret,
        callbackUrl: github.callbackUrl,
        code: input.code,
        verifier,
      });
      const operator = await this.prisma.operatorIdentity.findFirst({
        where: {
          active: true,
          githubIdentity: {
            issuer: "https://github.com",
            githubUserId: user.id,
          },
        },
        include: { nodeGrants: { include: { node: true } } },
      });
      if (!operator) {
        await this.prisma.$transaction(async (transaction) => {
          await this.finishGithubAttempt(
            transaction,
            attempt.id,
            undefined,
            OperatorLoginAttemptStatus.FAILED,
          );
          await this.recordSecurityEvent(
            transaction,
            SecurityEventType.LOGIN_FAILED,
            undefined,
            undefined,
            digest(user.id),
            "unknown_identity",
          );
        });
        attemptFinished = true;
        throw new UnauthorizedException(
          "GitHub authorization was not accepted",
        );
      }
      const result = await this.prisma.$transaction(async (transaction) => {
        await this.lockOperatorIdentity(transaction, operator.id);
        await this.revokeOperatorSessions(transaction, operator.id);
        const session = await this.createSession(
          transaction,
          operator,
          OperatorAuthenticationMethod.GITHUB,
        );
        await this.finishGithubAttempt(
          transaction,
          attempt.id,
          session.operator.sessionId,
          OperatorLoginAttemptStatus.COMPLETED,
        );
        return session;
      });
      attemptFinished = true;
      return {
        completionUrl: github.completionUrl,
        sessionToken: result.sessionToken,
      };
    } catch (error) {
      if (!attemptFinished) {
        await this.prisma.$transaction(async (transaction) => {
          const updated = await transaction.operatorLoginAttempt.updateMany({
            where: {
              id: attempt.id,
              status: OperatorLoginAttemptStatus.EXCHANGING,
            },
            data: {
              status: OperatorLoginAttemptStatus.FAILED,
              encryptedPkceVerifier: null,
              completedAt: new Date(),
            },
          });
          if (updated.count === 1) {
            await this.recordSecurityEvent(
              transaction,
              SecurityEventType.LOGIN_FAILED,
              undefined,
              undefined,
              digest(attempt.id),
              "github_exchange_failed",
            );
          }
        });
      }
      throw error;
    }
  }

  async authenticateRequest(request: AdminRequest): Promise<OperatorContext> {
    const token = readCookie(
      request,
      sessionCookieName(this.config.environment),
    );
    if (!token)
      throw new UnauthorizedException("Operator authentication is required");
    const session = await this.prisma.operatorSession.findUnique({
      where: { tokenHash: digest(token) },
      include: {
        operator: { include: { nodeGrants: { include: { node: true } } } },
      },
    });
    const now = await this.databaseNow();
    const expectedMethod =
      this.config.environment === "development"
        ? OperatorAuthenticationMethod.DEVELOPMENT_PASSWORD
        : OperatorAuthenticationMethod.GITHUB;
    const expectedCsrfHash = digest(csrfToken(token, this.config.csrfKey));
    if (
      !session ||
      session.revokedAt ||
      session.absoluteExpiresAt <= now ||
      session.lastSeenAt.getTime() + SESSION_IDLE_MILLISECONDS <=
        now.getTime() ||
      !session.operator.active ||
      session.credentialVersion !== session.operator.credentialVersion ||
      session.authenticationMethod !== expectedMethod ||
      !safeEqual(session.csrfHash, expectedCsrfHash)
    ) {
      throw new UnauthorizedException("Operator authentication is required");
    }
    const context = contextForSession(session);
    if (context.nodeIds.length !== 1) {
      throw new ForbiddenException("Operator node scope is unavailable");
    }
    if (
      now.getTime() - session.lastSeenAt.getTime() >=
      LAST_SEEN_WRITE_MILLISECONDS
    ) {
      await this.prisma.operatorSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          lastSeenAt: {
            lt: new Date(now.getTime() - LAST_SEEN_WRITE_MILLISECONDS),
          },
        },
        data: { lastSeenAt: now },
      });
    }
    return context;
  }

  async currentSession(request: AdminRequest): Promise<AuthSessionView> {
    const operator = await this.authenticateRequest(request);
    const token = readCookie(
      request,
      sessionCookieName(this.config.environment),
    );
    if (!token)
      throw new UnauthorizedException("Operator authentication is required");
    return { operator, csrfToken: csrfToken(token, this.config.csrfKey) };
  }

  async logout(request: AdminRequest): Promise<void> {
    this.requireAllowedOrigin(request);
    const operator = await this.authenticateRequest(request);
    const token = readCookie(
      request,
      sessionCookieName(this.config.environment),
    );
    const csrf = header(request, "x-csrf-token");
    if (
      !token ||
      !csrf ||
      !safeEqual(digest(csrf), digest(csrfToken(token, this.config.csrfKey)))
    ) {
      throw new ForbiddenException("CSRF validation failed");
    }
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.operatorSession.updateMany({
        where: { id: operator.sessionId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (updated.count === 1) {
        await this.recordSecurityEvent(
          transaction,
          SecurityEventType.LOGOUT,
          operator.operatorId,
          operator.sessionId,
          undefined,
          "revoked",
        );
      }
    });
  }

  async assertCsrf(request: AdminRequest): Promise<void> {
    this.requireAllowedOrigin(request);
    const token = readCookie(
      request,
      sessionCookieName(this.config.environment),
    );
    const csrf = header(request, "x-csrf-token");
    if (
      !token ||
      !csrf ||
      !safeEqual(digest(csrf), digest(csrfToken(token, this.config.csrfKey)))
    ) {
      throw new ForbiddenException("CSRF validation failed");
    }
  }

  async purgeExpired(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("limit must be between 1 and 1000");
    }
    const now = await this.databaseNow();
    const attempts = await this.prisma.operatorLoginAttempt.findMany({
      where: { expiresAt: { lt: now } },
      orderBy: { expiresAt: "asc" },
      take: limit,
      select: { id: true },
    });
    const events = await this.prisma.securityEvent.findMany({
      where: { expiresAt: { lt: now } },
      orderBy: { expiresAt: "asc" },
      take: limit,
      select: { id: true },
    });
    const deleted = await this.prisma.$transaction([
      this.prisma.operatorLoginAttempt.deleteMany({
        where: { id: { in: attempts.map((attempt) => attempt.id) } },
      }),
      this.prisma.securityEvent.deleteMany({
        where: { id: { in: events.map((event) => event.id) } },
      }),
    ]);
    const expiredSessions = await this.prisma.operatorSession.findMany({
      where: {
        absoluteExpiresAt: {
          lt: new Date(now.getTime() - SESSION_RETENTION_MILLISECONDS),
        },
        loginAttempts: { none: {} },
        securityEvents: { none: {} },
      },
      orderBy: { absoluteExpiresAt: "asc" },
      take: limit,
      select: { id: true },
    });
    const expiredBuckets = await this.prisma.operatorLoginRateBucket.findMany({
      where: {
        windowStart: {
          lt: new Date(now.getTime() - 2 * LOGIN_WINDOW_MILLISECONDS),
        },
      },
      orderBy: { windowStart: "asc" },
      take: limit,
      select: { id: true },
    });
    const [sessions, buckets] = await this.prisma.$transaction([
      this.prisma.operatorSession.deleteMany({
        where: { id: { in: expiredSessions.map((session) => session.id) } },
      }),
      this.prisma.operatorLoginRateBucket.deleteMany({
        where: { id: { in: expiredBuckets.map((bucket) => bucket.id) } },
      }),
    ]);
    return deleted[0].count + deleted[1].count + sessions.count + buckets.count;
  }

  private async claimGithubAttempt(state: string): Promise<string | undefined> {
    const now = new Date();
    const attempt = await this.prisma.operatorLoginAttempt.findUnique({
      where: { stateHash: digest(state) },
    });
    if (
      !attempt ||
      attempt.status !== OperatorLoginAttemptStatus.PENDING ||
      attempt.expiresAt <= now ||
      attempt.environment !== this.config.environment
    ) {
      return undefined;
    }
    const claimed = await this.prisma.operatorLoginAttempt.updateMany({
      where: { id: attempt.id, status: OperatorLoginAttemptStatus.PENDING },
      data: { status: OperatorLoginAttemptStatus.EXCHANGING },
    });
    return claimed.count === 1 ? attempt.browserBindingHash : undefined;
  }

  private async finishGithubAttempt(
    transaction: Transaction,
    id: string,
    sessionId: string | undefined,
    status: OperatorLoginAttemptStatus,
  ): Promise<void> {
    await transaction.operatorLoginAttempt.update({
      where: { id },
      data: {
        status,
        sessionId: sessionId ?? null,
        encryptedPkceVerifier: null,
        completedAt: new Date(),
      },
    });
  }

  private async createSession(
    transaction: Transaction,
    operator: {
      id: string;
      role: "ADMIN" | "OPERATOR" | "VIEWER";
      credentialVersion: number;
      nodeGrants: Array<{ nodeId: string; node: { active: boolean } }>;
    },
    authenticationMethod: OperatorAuthenticationMethod,
  ): Promise<AuthSessionView & { sessionToken: string }> {
    const nodeIds = operator.nodeGrants
      .filter((grant) => grant.node.active)
      .map((grant) => grant.nodeId)
      .sort();
    if (nodeIds.length !== 1) {
      throw new ForbiddenException("Operator node scope is unavailable");
    }
    const token = randomToken();
    const now = new Date();
    const session = await transaction.operatorSession.create({
      data: {
        tokenHash: digest(token),
        csrfHash: digest(csrfToken(token, this.config.csrfKey)),
        operatorId: operator.id,
        authenticationMethod,
        credentialVersion: operator.credentialVersion,
        lastSeenAt: now,
        absoluteExpiresAt: new Date(
          now.getTime() + SESSION_ABSOLUTE_MILLISECONDS,
        ),
      },
    });
    const context: OperatorContext = {
      operatorId: operator.id,
      role: operator.role,
      permissions: permissionsForRole(operator.role),
      nodeIds,
      authenticationMethod,
      sessionId: session.id,
    };
    await this.recordSecurityEvent(
      transaction,
      SecurityEventType.LOGIN_SUCCEEDED,
      operator.id,
      session.id,
      undefined,
      authenticationMethod.toLowerCase(),
    );
    return {
      operator: context,
      csrfToken: csrfToken(token, this.config.csrfKey),
      sessionToken: token,
    };
  }

  private async revokeOperatorSessions(
    transaction: Transaction,
    operatorId: string,
  ): Promise<void> {
    await transaction.operatorSession.updateMany({
      where: { operatorId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async lockOperatorIdentity(
    transaction: Transaction,
    operatorId: string,
  ): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "operator_identities"
      WHERE "id" = ${operatorId}::uuid
      FOR UPDATE
    `;
    if (rows.length !== 1) {
      throw new UnauthorizedException(
        "Operator authentication was not accepted",
      );
    }
  }

  private async recordFailedLogin(
    subjectHash: string,
    clientHash: string,
    windowStart: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.incrementBucket(
        transaction,
        subjectHash,
        clientHash,
        false,
        true,
        windowStart,
      );
      await this.recordSecurityEvent(
        transaction,
        SecurityEventType.LOGIN_FAILED,
        undefined,
        undefined,
        subjectHash,
        "rejected",
      );
    });
  }

  private async claimLoginBudget(
    subjectHash: string | undefined,
    clientHash: string,
  ): Promise<Date> {
    const now = new Date();
    const windowStart = new Date(
      Math.floor(now.getTime() / LOGIN_WINDOW_MILLISECONDS) *
        LOGIN_WINDOW_MILLISECONDS,
    );
    const globalSubjectHash = digest(GLOBAL_SUBJECT);
    const globalClientHash = digest(GLOBAL_CLIENT);
    await this.prisma.$transaction(async (transaction) => {
      if (!subjectHash) {
        const scoped = await this.incrementBucket(
          transaction,
          globalSubjectHash,
          clientHash,
          true,
          false,
          windowStart,
        );
        if (scoped.attempts > MAX_LOGIN_STARTS_PER_CLIENT) {
          throw new HttpException(
            "Operator login is temporarily limited",
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
      const global = await this.incrementBucket(
        transaction,
        globalSubjectHash,
        globalClientHash,
        true,
        false,
        windowStart,
      );
      if (global.attempts > MAX_LOGIN_STARTS) {
        throw new HttpException(
          "Operator login is temporarily limited",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (subjectHash) {
        const scoped = await this.incrementBucket(
          transaction,
          subjectHash,
          clientHash,
          true,
          false,
          windowStart,
        );
        if (scoped.attempts > MAX_PASSWORD_FAILURES) {
          throw new HttpException(
            "Operator login is temporarily limited",
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    });
    return windowStart;
  }

  private async incrementBucket(
    transaction: Transaction,
    subjectHash: string,
    clientHash: string,
    countAttempt: boolean,
    countFailure: boolean,
    windowStart = new Date(
      Math.floor(Date.now() / LOGIN_WINDOW_MILLISECONDS) *
        LOGIN_WINDOW_MILLISECONDS,
    ),
  ): Promise<{ attempts: number; failures: number }> {
    const row = await transaction.operatorLoginRateBucket.upsert({
      where: {
        subjectHash_clientHash_windowStart: {
          subjectHash,
          clientHash,
          windowStart,
        },
      },
      create: {
        subjectHash,
        clientHash,
        windowStart,
        attempts: countAttempt ? 1 : 0,
        failures: countFailure ? 1 : 0,
      },
      update: {
        ...(countAttempt ? { attempts: { increment: 1 } } : {}),
        ...(countFailure ? { failures: { increment: 1 } } : {}),
      },
      select: { attempts: true, failures: true },
    });
    return row;
  }

  private async recordSecurityEvent(
    transaction: Transaction,
    eventType: SecurityEventType,
    operatorId: string | undefined,
    operatorSessionId: string | undefined,
    subjectHash: string | undefined,
    outcome: string,
  ): Promise<void> {
    const now = new Date();
    await transaction.securityEvent.create({
      data: {
        eventType,
        operatorId: operatorId ?? null,
        operatorSessionId: operatorSessionId ?? null,
        subjectHash: subjectHash ?? null,
        outcome,
        recordedAt: now,
        expiresAt: new Date(now.getTime() + SECURITY_EVENT_MILLISECONDS),
      },
    });
  }

  private clientHash(request: AdminRequest | undefined): string {
    const address = request?.ip ?? request?.socket?.remoteAddress ?? "unknown";
    return createHmac("sha256", this.config.clientHashKey)
      .update(address)
      .digest("hex");
  }

  private requireAllowedOrigin(request: AdminRequest): void {
    const origin = header(request, "origin");
    if (!origin || !this.config.adminOrigins.includes(origin)) {
      throw new ForbiddenException("Admin origin is not allowed");
    }
  }

  private requireEnvironment(environment: "development"): void {
    if (this.config.environment !== environment) {
      throw new NotFoundException("Development operator login is unavailable");
    }
  }

  private requiredGithubConfig(): GithubLoginConfig {
    if (!this.config.github)
      throw new NotFoundException("GitHub operator login is unavailable");
    return this.config.github;
  }

  private async databaseNow(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    const now = rows[0]?.now;
    if (!(now instanceof Date)) {
      throw new Error("Database clock query did not return a timestamp");
    }
    return now;
  }
}

function contextForSession(session: {
  id: string;
  authenticationMethod: OperatorAuthenticationMethod;
  operator: {
    id: string;
    role: "ADMIN" | "OPERATOR" | "VIEWER";
    nodeGrants: Array<{ nodeId: string; node: { active: boolean } }>;
  };
}): OperatorContext {
  return {
    operatorId: session.operator.id,
    role: session.operator.role,
    permissions: permissionsForRole(session.operator.role),
    nodeIds: session.operator.nodeGrants
      .filter((grant) => grant.node.active)
      .map((grant) => grant.nodeId)
      .sort(),
    authenticationMethod: session.authenticationMethod,
    sessionId: session.id,
  };
}

export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await derivePassword(password, salt);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    base64Url(salt),
    base64Url(derived),
  ].join("$");
}

async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [_, n, r, p, saltValue, expectedValue] = parts;
  if (
    n !== String(SCRYPT_N) ||
    r !== String(SCRYPT_R) ||
    p !== String(SCRYPT_P) ||
    !saltValue ||
    !expectedValue
  )
    return false;
  const salt = Buffer.from(saltValue, "base64url");
  const expected = Buffer.from(expectedValue, "base64url");
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = await derivePassword(password, salt);
  return safeEqual(actual, expected);
}

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const derive = scryptCallback as unknown as (
      password: string,
      salt: Buffer,
      keyLength: number,
      options: { N: number; r: number; p: number; maxmem: number },
      callback: (error: Error | null, derivedKey: Buffer) => void,
    ) => void;
    derive(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new UnauthorizedException("Operator authentication was not accepted");
  }
  const email = value.trim().toLowerCase();
  if (
    email.length === 0 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new UnauthorizedException("Operator authentication was not accepted");
  }
  return email;
}

function validatePassword(value: string): void {
  if (typeof value !== "string" || value.length < 12 || value.length > 1_024) {
    throw new UnauthorizedException("Operator authentication was not accepted");
  }
}

function validateOpaqueToken(value: string, name: string): void {
  if (!/^[A-Za-z0-9_-]{20,2048}$/.test(value)) {
    throw new UnauthorizedException(`GitHub ${name} was not accepted`);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function randomToken(): string {
  return base64Url(randomBytes(32));
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function csrfToken(sessionToken: string, key: Buffer): string {
  return createHmac("sha256", key).update(sessionToken).digest("base64url");
}

function safeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const leftBytes = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const rightBytes = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return base64Url(Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
}

function decrypt(value: string, key: Buffer): string {
  const encoded = Buffer.from(value, "base64url");
  if (encoded.length < 29)
    throw new UnauthorizedException("GitHub authorization was not accepted");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    encoded.subarray(0, 12),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(encoded.subarray(12, 28));
  return Buffer.concat([
    decipher.update(encoded.subarray(28)),
    decipher.final(),
  ]).toString("utf8");
}

function header(request: AdminRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function readCookie(request: AdminRequest, name: string): string | undefined {
  const cookie = header(request, "cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === name && value && /^[A-Za-z0-9_-]{20,256}$/.test(value))
      return value;
  }
  return undefined;
}

export function sessionCookieName(environment: TavenEnvironment): string {
  return environment === "development" ? "taven_admin" : "__Host-taven_admin";
}

export function loginAttemptCookieName(environment: TavenEnvironment): string {
  return environment === "development"
    ? "taven_admin_login"
    : "__Host-taven_admin_login";
}

type TavenEnvironment = AdminAccessConfig["environment"];
