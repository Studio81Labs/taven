import "dotenv/config";
process.env.DATABASE_URL ??= "postgresql://taven:taven@127.0.0.1:5435/taven";
process.env.TAVEN_ENVIRONMENT ??= "development";
process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
process.env.TAVEN_S3_REGION ??= "us-east-1";
process.env.TAVEN_S3_BUCKET ??= "taven";
process.env.TAVEN_S3_ACCESS_KEY_ID ??= "taven";
process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "taven-local-only";
process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??=
  "test-only-upload-client-hash-key-32";
import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { readAdminAccessConfig } from "../src/modules/admin-access/admin-access.config";
import { PrismaService } from "../src/prisma/prisma.service";

describe("Legal Documents & Node-Free Admin E2E", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  let adminCookie: string;
  let adminCsrfToken: string;
  let adminOperatorId: string;

  async function resetLegalState() {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE legal_document_publications DISABLE TRIGGER ALL;
      ALTER TABLE legal_document_revisions DISABLE TRIGGER ALL;
      DELETE FROM legal_document_publications;
      DELETE FROM legal_document_revisions WHERE sequence > 1;
      UPDATE legal_documents SET generation = 1;
      ALTER TABLE legal_document_publications ENABLE TRIGGER ALL;
      ALTER TABLE legal_document_revisions ENABLE TRIGGER ALL;
    `);
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await resetLegalState();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();

    // Create node-free ADMIN operator (0 node grants)
    const adminIdentity = await prisma.operatorIdentity.create({
      data: {
        email: `node-free-admin-${randomUUID()}@example.test`,
        role: "ADMIN",
      },
    });
    adminOperatorId = adminIdentity.id;

    const token = randomBytes(32).toString("base64url");
    const adminConfig = readAdminAccessConfig();
    const csrfKey = adminConfig.csrfKey;
    adminCsrfToken = createHmac("sha256", csrfKey)
      .update(token)
      .digest("base64url");

    await prisma.operatorSession.create({
      data: {
        tokenHash: createHash("sha256").update(token).digest("hex"),
        csrfHash: createHash("sha256").update(adminCsrfToken).digest("hex"),
        operatorId: adminIdentity.id,
        authenticationMethod: "DEVELOPMENT_PASSWORD",
        credentialVersion: 1,
        absoluteExpiresAt: new Date(Date.now() + 60 * 60 * 1_000),
      },
    });
    adminCookie = `taven_admin=${token}`;
  });

  afterAll(async () => {
    await app.close();
    await resetLegalState();
    await prisma.onModuleDestroy();
  });

  it("authenticates node-free admin and issues restricted legal/audit permissions", async () => {
    const res = await fetch(new URL("/admin/auth/session", baseUrl), {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.operator.operatorId).toBe(adminOperatorId);
    expect(body.operator.role).toBe("ADMIN");
    expect(body.operator.nodeIds).toEqual([]);
  });

  it("blocks node-free admin from node-scoped operational audit endpoint", async () => {
    const res = await fetch(new URL("/admin/audit-events", baseUrl), {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.message).toContain("Operator node scope is unavailable");
  });

  it("lists all 6 managed legal documents with initial draft sequence 1", async () => {
    const res = await fetch(new URL("/admin/legal-documents", baseUrl), {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const docs = await res.json();
    expect(docs).toHaveLength(6);
    const keys = docs.map((d: { key: string }) => d.key).sort();
    expect(keys).toEqual([
      "claims",
      "photoConsent",
      "privacy",
      "prohibitedContent",
      "retention",
      "terms",
    ]);

    for (const doc of docs) {
      expect(doc.draftRevisionsCount).toBeGreaterThanOrEqual(1);
      expect(doc.latestDraft).toBeDefined();
      expect(doc.latestDraft.status).toBe("DRAFT");
    }
  });

  it("reads single legal document detail with draft revision", async () => {
    const res = await fetch(new URL("/admin/legal-documents/terms", baseUrl), {
      headers: { Cookie: adminCookie },
    });

    expect(res.status).toBe(200);
    const terms = await res.json();
    expect(terms.key).toBe("terms");
    expect(terms.documentId).toBe("terms-of-service");
    expect(terms.revisions.length).toBeGreaterThanOrEqual(1);
    expect(terms.revisions[0].sequence).toBe(1);
    expect(terms.revisions[0].status).toBe("DRAFT");
    expect(terms.revisions[0].sections.length).toBeGreaterThan(0);
  });

  it("performs full revision lifecycle: create draft, update draft, approve revision", async () => {
    // 1. Get current generation of terms
    const getRes = await fetch(
      new URL("/admin/legal-documents/terms", baseUrl),
      {
        headers: { Cookie: adminCookie },
      },
    );
    const docBefore = await getRes.json();
    const gen = docBefore.generation;

    // 2. Reject mismatched expectedGeneration
    const conflictRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedGeneration: gen + 999,
          title: "Obchodní podmínky v2",
          summary: "Druhá verze",
          sections: [{ title: "Sekce 1", note: "Poznámka" }],
        }),
      },
    );
    expect(conflictRes.status).toBe(409);

    // 3. Create draft revision
    const createRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedGeneration: gen,
          title: "Obchodní podmínky v2",
          summary: "Druhá verze obchodních podmínek",
          sections: [
            {
              title: "1. Všeobecná ustanovení",
              paragraphs: ["Tento text definuje základní pravidla služby."],
            },
          ],
        }),
      },
    );
    expect(createRes.status).toBe(200);
    const createdDraft = await createRes.json();
    expect(createdDraft.sequence).toBe(2);
    expect(createdDraft.editVersion).toBe(1);
    expect(createdDraft.status).toBe("DRAFT");
    expect(createdDraft.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // 4. Update draft revision
    const updateRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedEditVersion: 1,
          title: "Obchodní podmínky v2 - aktualizované",
          summary: "Druhá aktualizovaná verze obchodních podmínek",
          sections: [
            {
              title: "1. Všeobecná ustanovení",
              paragraphs: ["Aktualizovaný text první sekce."],
              items: ["Položka A", "Položka B"],
            },
          ],
        }),
      },
    );
    expect(updateRes.status).toBe(200);
    const updatedDraft = await updateRes.json();
    expect(updatedDraft.editVersion).toBe(2);
    expect(updatedDraft.title).toBe("Obchodní podmínky v2 - aktualizované");
    expect(updatedDraft.contentHash).not.toBe(createdDraft.contentHash);

    // 5. Approve draft revision
    const approveRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedContentHash: updatedDraft.contentHash,
          revisionCode: "terms-2026-09-e2e-v1",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          approvalEvidence: "Právní posouzení č. 2026/09/LP-01",
          reasonCode: "LEGAL_APPROVED",
          reason: "Schválení nového znění podmínek vedením",
        }),
      },
    );
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json();
    expect(approved.status).toBe("APPROVED");
    expect(approved.revisionCode).toBe("terms-2026-09-e2e-v1");
    expect(approved.approvalEvidence).toBe("Právní posouzení č. 2026/09/LP-01");

    // 6. Verify immutability via API
    const editApprovedRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedEditVersion: 2,
          title: "Pokus o změnu schváleného",
          summary: "test",
          sections: [{ title: "X", note: "Y" }],
        }),
      },
    );
    expect(editApprovedRes.status).toBe(409);

    // 7. Verify PostgreSQL trigger immutability enforcement
    await expect(
      prisma.$executeRaw`
        UPDATE legal_document_revisions
        SET title = 'Modifikace v DB'
        WHERE id = ${createdDraft.id}::uuid
      `,
    ).rejects.toThrow(/is immutable and cannot be modified/i);

    await expect(
      prisma.$executeRaw`
        DELETE FROM legal_document_revisions
        WHERE id = ${createdDraft.id}::uuid
      `,
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it("publishes approved revision, serves public exact-version reader, handles schedule, collision and cancellation", async () => {
    // 1. Get current document state
    const getRes = await fetch(
      new URL("/admin/legal-documents/terms", baseUrl),
      {
        headers: { Cookie: adminCookie },
      },
    );
    const termsDoc = await getRes.json();
    const approvedRev = termsDoc.revisions.find(
      (r: { revisionCode?: string }) =>
        r.revisionCode === "terms-2026-09-e2e-v1",
    );
    expect(approvedRev).toBeDefined();

    // 2. Public endpoint before publication returns 404
    const beforePubRes = await fetch(
      new URL("/legal-documents/terms/revisions/terms-2026-09-e2e-v1", baseUrl),
    );
    expect(beforePubRes.status).toBe(404);

    // 3. Publish approved revision immediately
    const pubRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${approvedRev.id}/publish`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedGeneration: termsDoc.generation,
          reasonCode: "PUBLISH_TERMS",
          reason: "Okamžitá publikace schválených podmínek",
        }),
      },
    );
    expect(pubRes.status).toBe(200);
    const pub = await pubRes.json();
    expect(pub.revisionId).toBe(approvedRev.id);
    expect(pub.revisionCode).toBe("terms-2026-09-e2e-v1");

    // 4. Public endpoint now returns 200 with headers and content
    const publicRes = await fetch(
      new URL("/legal-documents/terms/revisions/terms-2026-09-e2e-v1", baseUrl),
    );
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get("cache-control")).toContain("immutable");
    expect(publicRes.headers.get("etag")).toBe(`"${approvedRev.contentHash}"`);
    const publicBody = await publicRes.json();
    expect(publicBody.revisionCode).toBe("terms-2026-09-e2e-v1");
    expect(publicBody.contentVersion).toBe(1);
    expect(publicBody.contentHash).toBe(approvedRev.contentHash);
    expect(publicBody.sections.length).toBeGreaterThan(0);

    // 5. Republication of same revision is rejected with 409
    const termsDocAfter = await (
      await fetch(new URL("/admin/legal-documents/terms", baseUrl), {
        headers: { Cookie: adminCookie },
      })
    ).json();

    const republishRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${approvedRev.id}/publish`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedGeneration: termsDocAfter.generation,
          reasonCode: "REPUBLISH_ATTEMPT",
          reason: "Pokus o opětovnou publikaci",
        }),
      },
    );
    expect(republishRes.status).toBe(409);

    // 6. Create, approve, and schedule a future publication
    const draft3Res = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedGeneration: termsDocAfter.generation,
          title: "Obchodní podmínky v3",
          summary: "Budoucí verze podmínek",
          sections: [{ title: "Budoucnost", note: "Platné od zítřka" }],
        }),
      },
    );
    const draft3 = await draft3Res.json();

    const approve3Res = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${draft3.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedContentHash: draft3.contentHash,
          revisionCode: "terms-2026-10-future-v1",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          approvalEvidence: "Board Resolution 2026-10",
          reasonCode: "LEGAL_APPROVED",
          reason: "Schválení budoucí verze",
        }),
      },
    );
    const approved3 = await approve3Res.json();

    const docBeforeSchedule = await (
      await fetch(new URL("/admin/legal-documents/terms", baseUrl), {
        headers: { Cookie: adminCookie },
      })
    ).json();

    const futureStartsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const scheduleRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${approved3.id}/publish`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedGeneration: docBeforeSchedule.generation,
          startsAt: futureStartsAt,
          reasonCode: "SCHEDULE_FUTURE",
          reason: "Naplánovaná publikace",
        }),
      },
    );
    expect(scheduleRes.status).toBe(200);
    const scheduledPub = await scheduleRes.json();
    expect(scheduledPub.startsAt).toBe(futureStartsAt);

    // 7. Verify pending publication collision guard
    const docWhilePending = await (
      await fetch(new URL("/admin/legal-documents/terms", baseUrl), {
        headers: { Cookie: adminCookie },
      })
    ).json();
    expect(docWhilePending.pendingPublication).toBeDefined();
    expect(docWhilePending.activePublication.endsAt).toBe(futureStartsAt);

    // 8. Cancel pending scheduled publication
    const cancelRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/publications/${scheduledPub.id}/cancel`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: {
          Cookie: adminCookie,
          origin: "http://localhost:3002",
          "x-csrf-token": adminCsrfToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expectedGeneration: docWhilePending.generation,
          reasonCode: "CANCEL_SCHEDULED",
          reason: "Zrušení naplánované publikace",
        }),
      },
    );
    expect(cancelRes.status).toBe(200);
    const cancelled = await cancelRes.json();
    expect(cancelled.cancelledAt).toBeDefined();

    // Verify active publication endsAt was restored to undefined/null
    const docAfterCancel = await (
      await fetch(new URL("/admin/legal-documents/terms", baseUrl), {
        headers: { Cookie: adminCookie },
      })
    ).json();
    expect(docAfterCancel.pendingPublication).toBeUndefined();
    expect(docAfterCancel.activePublication.endsAt).toBeUndefined();

    // 9. Verify legal audit events endpoint
    const auditRes = await fetch(
      new URL("/admin/legal-documents/terms/audit-events", baseUrl),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(auditRes.status).toBe(200);
    const auditPage = await auditRes.json();
    expect(auditPage.items.length).toBeGreaterThan(0);
    for (const item of auditPage.items) {
      expect(item.legalDocumentId).toBe(termsDoc.id);
      expect(item.nodeId).toBeUndefined();
      expect(item.payload).toBeDefined();
    }
  });
});
