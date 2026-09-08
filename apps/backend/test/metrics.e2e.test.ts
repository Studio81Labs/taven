import "reflect-metadata";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { configureHttpBodyParsers } from "../src/http-body.config";
import { PrismaService } from "../src/prisma/prisma.service";

const uploadClientHashKey = "metrics-test-upload-client-hash-key-32";
const quoteCapabilityKey =
  "metrics-test-quote-capability-key-with-at-least-32-characters";
process.env.TAVEN_ENVIRONMENT ??= "development";
process.env.TAVEN_QUOTE_CAPABILITY_KEY ??= quoteCapabilityKey;
process.env.TAVEN_QUOTE_CAPABILITY_PREVIOUS_KEYS ??= "[]";
process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??= uploadClientHashKey;
process.env.TAVEN_REDIS_URL ??= "redis://127.0.0.1:6381";

describe("v0-1 metrics reports", () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let baseUrl: URL;
  let adminCookie: string;
  let operatorCookie: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureHttpBodyParsers(app);
    await app.listen(0, "127.0.0.1");
    baseUrl = new URL(await app.getUrl());
    prisma = app.get(PrismaService);
    const node = await prisma.node.findFirstOrThrow({
      where: { active: true },
    });
    adminCookie = await sessionCookie("ADMIN", node.id);
    operatorCookie = await sessionCookie("OPERATOR", node.id);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("returns an aggregate platform report and a node-scoped operational report", async () => {
    const response = await metricsRequest(adminCookie);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      metricDefinition: "v0-1",
      interval: { currency: "CZK" },
      commercial: { scope: "PLATFORM" },
      operational: { scope: "OPERATIONAL_NODE" },
    });
  });

  it("fails closed for a role without metrics permission and rejects unknown fields", async () => {
    const forbidden = await metricsRequest(operatorCookie);
    expect(forbidden.status).toBe(403);

    const unknown = await metricsRequest(adminCookie, "&unexpected=value");
    expect(unknown.status).toBe(400);
  });

  it("validates the opaque, filter-bound order cursor", async () => {
    const response = await fetch(
      new URL(
        "/admin/metrics/orders?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z&cursor=not-a-cursor",
        baseUrl,
      ),
      { headers: { cookie: adminCookie } },
    );

    expect(response.status).toBe(400);
  });

  async function sessionCookie(
    role: "ADMIN" | "OPERATOR",
    nodeId: string,
  ): Promise<string> {
    const identity = await prisma.operatorIdentity.create({
      data: {
        email: `metrics-${role.toLowerCase()}-${randomUUID()}@example.test`,
        role,
        nodeGrants: { create: { nodeId } },
      },
    });
    const token = randomBytes(32).toString("base64url");
    const csrfKey = createHash("sha256")
      .update("openapi:TAVEN_ADMIN_CSRF_KEY")
      .digest();
    const csrfToken = createHmac("sha256", csrfKey)
      .update(token)
      .digest("base64url");
    await prisma.operatorSession.create({
      data: {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        csrfHash: createHash("sha256").update(csrfToken).digest("hex"),
        operatorId: identity.id,
        authenticationMethod: "DEVELOPMENT_PASSWORD",
        credentialVersion: 1,
        absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
    return `taven_admin=${token}`;
  }

  function metricsRequest(cookie: string, suffix = ""): Promise<Response> {
    return fetch(
      new URL(
        `/admin/metrics?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z${suffix}`,
        baseUrl,
      ),
      { headers: { cookie } },
    );
  }
});
