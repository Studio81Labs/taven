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
import { type INestApplication, ForbiddenException } from "@nestjs/common";
import { AuditService } from "../src/modules/audit/audit.service";
import {
  computeLegalRevisionContentHash,
  LegalDocumentsService,
} from "../src/modules/legal-documents/legal-documents.service";
import { OPERATOR_PERMISSIONS } from "../src/modules/admin-access/operator-permissions";
import type { OperatorContext } from "../src/modules/admin-access/operator-context";
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

  function adminHeaders(idempotencyKey?: string) {
    return {
      Cookie: adminCookie,
      origin: "http://localhost:3002",
      "x-csrf-token": adminCsrfToken,
      "Content-Type": "application/json",
      ...(idempotencyKey !== undefined
        ? { "Idempotency-Key": idempotencyKey }
        : {}),
    };
  }

  function legalContentHash(
    title: string,
    summary: string,
    sections: Parameters<typeof computeLegalRevisionContentHash>[0]["sections"],
  ): string {
    return computeLegalRevisionContentHash({
      contentVersion: 1,
      title,
      summary,
      sections,
    });
  }

  async function resetLegalState() {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE legal_documents DISABLE TRIGGER ALL;
      ALTER TABLE legal_document_publications DISABLE TRIGGER ALL;
      ALTER TABLE legal_document_revisions DISABLE TRIGGER ALL;
      ALTER TABLE audit_events DISABLE TRIGGER ALL;
      DELETE FROM legal_document_publications;
      DELETE FROM legal_document_revisions WHERE sequence > 1;
      DELETE FROM audit_events WHERE legal_document_id IS NOT NULL;
      UPDATE legal_documents SET generation = 1;
      ALTER TABLE legal_documents ENABLE TRIGGER ALL;
      ALTER TABLE legal_document_publications ENABLE TRIGGER ALL;
      ALTER TABLE legal_document_revisions ENABLE TRIGGER ALL;
      ALTER TABLE audit_events ENABLE TRIGGER ALL;
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

  it("rejects NUL bytes in administrative legal route and query parameters", async () => {
    const nulDocumentKeyRes = await fetch(
      new URL("/admin/legal-documents/%00", baseUrl),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(nulDocumentKeyRes.status).toBe(400);

    const nulEventTypeRes = await fetch(
      new URL(
        "/admin/legal-documents/terms/audit-events?eventType=%00",
        baseUrl,
      ),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(nulEventTypeRes.status).toBe(400);
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

    // Missing Idempotency-Key is rejected with 400
    const missingKeyRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          expectedGeneration: gen,
          title: "Obchodní podmínky v2",
          summary: "Druhá verze",
          sections: [{ title: "Sekce 1", note: "Poznámka" }],
          reasonCode: "TEST_REASON",
          reason: "Test draft create",
        }),
      },
    );
    expect(missingKeyRes.status).toBe(400);

    const nulTitleRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedGeneration: gen,
          title: "Invalid\u0000title",
          summary: "Summary",
          sections: [{ title: "Section", note: "Content" }],
          reasonCode: "TEST_NUL",
          reason: "NUL input validation",
        }),
      },
    );
    expect(nulTitleRes.status).toBe(400);

    // 2. Reject mismatched expectedGeneration
    const conflictRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedGeneration: gen + 999,
          title: "Obchodní podmínky v2",
          summary: "Druhá verze",
          sections: [{ title: "Sekce 1", note: "Poznámka" }],
          reasonCode: "TEST_REASON",
          reason: "Test draft create",
        }),
      },
    );
    expect(conflictRes.status).toBe(409);

    // 3. Create draft revision with idempotency key
    const draftCreateKey = randomUUID();
    const draftPayload = {
      expectedGeneration: gen,
      title: "Obchodní podmínky v2",
      summary: "Druhá verze obchodních podmínek",
      sections: [
        {
          title: "1. Všeobecná ustanovení",
          paragraphs: ["Tento text definuje základní pravidla služby."],
        },
      ],
      reasonCode: "TERMS_V2_DRAFT",
      reason: "Příprava druhé verze obchodních podmínek",
    };
    const createRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: adminHeaders(draftCreateKey),
        body: JSON.stringify(draftPayload),
      },
    );
    expect(createRes.status).toBe(200);
    const createdDraft = await createRes.json();
    expect(createdDraft.sequence).toBe(2);
    expect(createdDraft.editVersion).toBe(1);
    expect(createdDraft.status).toBe("DRAFT");
    expect(createdDraft.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // 3b. Replaying identical input with the same idempotency key returns 200 with identical response
    const replayRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: adminHeaders(draftCreateKey),
        body: JSON.stringify(draftPayload),
      },
    );
    expect(replayRes.status).toBe(200);
    const replayedDraft = await replayRes.json();
    expect(replayedDraft.id).toBe(createdDraft.id);
    expect(replayedDraft.contentHash).toBe(createdDraft.contentHash);

    // 3c. Replaying altered input with the same idempotency key returns 409 Conflict
    const conflictReplayRes = await fetch(
      new URL("/admin/legal-documents/terms/revisions", baseUrl),
      {
        method: "POST",
        headers: adminHeaders(draftCreateKey),
        body: JSON.stringify({
          ...draftPayload,
          title: "Altered title",
        }),
      },
    );
    expect(conflictReplayRes.status).toBe(409);

    // 4. Update draft revision
    const updateRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: adminHeaders(randomUUID()),
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
          reasonCode: "TERMS_V2_UPDATE",
          reason: "Doplnění sekcí druhé verze obchodních podmínek",
        }),
      },
    );
    expect(updateRes.status).toBe(200);
    const updatedDraft = await updateRes.json();
    expect(updatedDraft.editVersion).toBe(2);
    expect(updatedDraft.title).toBe("Obchodní podmínky v2 - aktualizované");
    expect(updatedDraft.contentHash).not.toBe(createdDraft.contentHash);

    // 5. Mismatched expectedEditVersion is rejected with 409
    const mismatchEditRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: 999,
          expectedContentHash: updatedDraft.contentHash,
          revisionCode: "terms-2026-09-e2e-v1",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          approvalEvidence: "Právní posouzení č. 2026/09/LP-01",
          reasonCode: "LEGAL_APPROVED",
          reason: "Schválení nového znění podmínek vedením",
        }),
      },
    );
    expect(mismatchEditRes.status).toBe(409);

    // Rejects approval when effectiveAt lacks an explicit timezone
    const noTzApproveRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: updatedDraft.editVersion,
          expectedContentHash: updatedDraft.contentHash,
          revisionCode: "terms-2026-09-e2e-v1",
          effectiveAt: "2026-09-01T00:00:00",
          approvalEvidence: "Právní posouzení č. 2026/09/LP-01",
          reasonCode: "LEGAL_APPROVED",
          reason: "Schválení nového znění podmínek vedením",
        }),
      },
    );
    expect(noTzApproveRes.status).toBe(400);

    const outOfRangeApproveRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: updatedDraft.editVersion,
          expectedContentHash: updatedDraft.contentHash,
          revisionCode: "terms-2026-09-e2e-v1",
          effectiveAt: "-100000-01-01T00:00:00.000Z",
          approvalEvidence: "Právní posouzení č. 2026/09/LP-01",
          reasonCode: "LEGAL_APPROVED",
          reason: "Schválení nového znění podmínek vedením",
        }),
      },
    );
    expect(outOfRangeApproveRes.status).toBe(400);

    const invalidCalendarApproveRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: updatedDraft.editVersion,
          expectedContentHash: updatedDraft.contentHash,
          revisionCode: "terms-2026-09-e2e-v1",
          effectiveAt: "2027-02-30T00:00:00.000Z",
          approvalEvidence: "Právní posouzení č. 2026/09/LP-01",
          reasonCode: "LEGAL_APPROVED",
          reason: "Schválení nového znění podmínek vedením",
        }),
      },
    );
    expect(invalidCalendarApproveRes.status).toBe(400);

    // Approval recomputes canonical content under the document lock rather
    // than trusting a stale hash introduced by direct SQL/import work.
    await prisma.$executeRaw`
      UPDATE legal_document_revisions
      SET content_hash = ${"0".repeat(64)}
      WHERE id = ${createdDraft.id}::uuid
    `;
    const staleHashApproveRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: updatedDraft.editVersion,
          expectedContentHash: "0".repeat(64),
          revisionCode: "terms-2026-09-e2e-v1",
          effectiveAt: "2026-09-13T00:30:00+02:00",
          approvalEvidence: "Právní posouzení č. 2026/09/LP-01",
          reasonCode: "LEGAL_APPROVED",
          reason: "Schválení nového znění podmínek vedením",
        }),
      },
    );
    expect(staleHashApproveRes.status).toBe(409);

    // Approve draft revision with correct expectedEditVersion
    const approveRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}/approve`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: updatedDraft.editVersion,
          expectedContentHash: updatedDraft.contentHash,
          revisionCode: "terms-2026-09-e2e-v1",
          effectiveAt: "2026-09-13T00:30:00+02:00",
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
    expect(approved.effectiveAt).toBe("2026-09-12T22:30:00.000Z");
    expect(approved.approvalEvidence).toBe("Právní posouzení č. 2026/09/LP-01");

    // 6. Verify immutability via API
    const editApprovedRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${createdDraft.id}`,
        baseUrl,
      ),
      {
        method: "PUT",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: 2,
          title: "Pokus o změnu schváleného",
          summary: "test",
          sections: [{ title: "X", note: "Y" }],
          reasonCode: "UPDATE_ATTEMPT",
          reason: "Pokus o změnu",
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
    expect(beforePubRes.headers.get("cache-control")).toBe("no-store");

    const nulRevisionCodeRes = await fetch(
      new URL("/legal-documents/terms/revisions/%00", baseUrl),
    );
    expect(nulRevisionCodeRes.status).toBe(400);
    const nulDocumentKeyRes = await fetch(
      new URL("/legal-documents/%00/revisions/terms-2026-09-e2e-v1", baseUrl),
    );
    expect(nulDocumentKeyRes.status).toBe(400);

    // 3. Publish approved revision immediately
    const pubRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${approvedRev.id}/publish`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
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
        headers: adminHeaders(randomUUID()),
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
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedGeneration: termsDocAfter.generation,
          title: "Obchodní podmínky v3",
          summary: "Budoucí verze podmínek",
          sections: [{ title: "Budoucnost", note: "Platné od zítřka" }],
          reasonCode: "TERMS_V3_DRAFT",
          reason: "Příprava třetí verze obchodních podmínek",
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
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedEditVersion: draft3.editVersion,
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

    // Rejects publication when startsAt precedes decision time
    const backdatedPubRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${approved3.id}/publish`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedGeneration: docBeforeSchedule.generation,
          startsAt: new Date(Date.now() - 3600000).toISOString(),
          reasonCode: "SCHEDULE_PAST",
          reason: "Backdated publication attempt",
        }),
      },
    );
    expect(backdatedPubRes.status).toBe(400);

    const invalidCalendarScheduleRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${approved3.id}/publish`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedGeneration: docBeforeSchedule.generation,
          startsAt: "2027-02-30T00:00:00.000Z",
          reasonCode: "SCHEDULE_INVALID",
          reason: "Invalid calendar publication attempt",
        }),
      },
    );
    expect(invalidCalendarScheduleRes.status).toBe(400);

    const futureStartsAt = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const scheduleRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/revisions/${approved3.id}/publish`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
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

    // 7b. Reject archival at or before start boundary with 409 Conflict
    const archivePendingRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/publications/${scheduledPub.id}/archive`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedGeneration: docWhilePending.generation,
          reasonCode: "ARCHIVE_TEST",
          reason: "Archive test on pending future publication",
        }),
      },
    );
    expect(archivePendingRes.status).toBe(409);

    // 8. Cancel pending scheduled publication
    const cancelRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/publications/${scheduledPub.id}/cancel`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
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

    // Verify active publication endsAt was restored to undefined/null and publications history contains cancelled publication
    const docAfterCancel = await (
      await fetch(new URL("/admin/legal-documents/terms", baseUrl), {
        headers: { Cookie: adminCookie },
      })
    ).json();
    expect(docAfterCancel.pendingPublication).toBeUndefined();
    expect(docAfterCancel.activePublication.endsAt).toBeUndefined();
    expect(Array.isArray(docAfterCancel.publications)).toBe(true);
    expect(docAfterCancel.publications.length).toBeGreaterThan(0);
    const foundCancelled = docAfterCancel.publications.find(
      (p: { id: string; cancelledAt?: string }) => p.id === scheduledPub.id,
    );
    expect(foundCancelled).toBeDefined();
    expect(foundCancelled.cancelledAt).toBeDefined();

    // A normal archive uses a database-created operation instant, which the
    // integrity trigger accepts even though it captures its own later lock
    // timestamp.
    const archiveActiveRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/publications/${pub.id}/archive`,
        baseUrl,
      ),
      {
        method: "POST",
        headers: adminHeaders(randomUUID()),
        body: JSON.stringify({
          expectedGeneration: docAfterCancel.generation,
          reasonCode: "ARCHIVE_ACTIVE",
          reason: "Archive active publication",
        }),
      },
    );
    expect(archiveActiveRes.status).toBe(200);
    expect((await archiveActiveRes.json()).endsAt).toBeDefined();

    // 9. Verify legal audit events endpoint and filters
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
      const payload = item.payload as { contentHash?: string };
      expect(payload.contentHash).toBeDefined();
      expect(payload.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    const cancelAudit = auditPage.items.find(
      (item: { eventType: string }) =>
        item.eventType === "legal_document.publication_cancelled",
    );
    expect(cancelAudit).toBeDefined();
    expect(cancelAudit.createdAt).toBe(cancelled.cancelledAt);
    const initialPublicationAudit = auditPage.items.find(
      (item: { eventType: string; payload: unknown }) =>
        item.eventType === "legal_document.published" &&
        (item.payload as { publicationId?: string }).publicationId === pub.id,
    );
    expect(initialPublicationAudit).toBeDefined();
    expect(initialPublicationAudit.createdAt).toBe(pub.startsAt);
    expect(
      (cancelAudit.payload as { previousPublicationId?: string })
        .previousPublicationId,
    ).toBe(pub.id);

    const filteredAuditRes = await fetch(
      new URL(
        "/admin/legal-documents/terms/audit-events?eventType=legal_document.draft_created",
        baseUrl,
      ),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(filteredAuditRes.status).toBe(200);
    const filteredAuditPage = await filteredAuditRes.json();
    expect(filteredAuditPage.items.length).toBeGreaterThan(0);
    for (const item of filteredAuditPage.items) {
      expect(item.eventType).toBe("legal_document.draft_created");
    }

    // Dedicated publication history endpoint and pagination
    const pubListRes = await fetch(
      new URL("/admin/legal-documents/terms/publications?limit=1", baseUrl),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(pubListRes.status).toBe(200);
    const pubListPage = await pubListRes.json();
    expect(pubListPage.items.length).toBe(1);
    expect(pubListPage.nextCursor).toBeDefined();

    const nextPubListRes = await fetch(
      new URL(
        `/admin/legal-documents/terms/publications?limit=1&cursor=${encodeURIComponent(pubListPage.nextCursor)}`,
        baseUrl,
      ),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(nextPubListRes.status).toBe(200);
    const nextPubListPage = await nextPubListRes.json();
    expect(nextPubListPage.items.length).toBe(1);
    expect(nextPubListPage.items[0].id).not.toBe(pubListPage.items[0].id);

    // Detail publications pagination
    const detailPubRes = await fetch(
      new URL("/admin/legal-documents/terms?publicationLimit=1", baseUrl),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(detailPubRes.status).toBe(200);
    const detailPubDoc = await detailPubRes.json();
    expect(detailPubDoc.publications.length).toBe(1);
    expect(detailPubDoc.publicationsNextCursor).toBeDefined();

    // Query validation rejects repeated query params (Express array)
    const repeatedQueryRes = await fetch(
      new URL(
        "/admin/legal-documents/terms/audit-events?operatorIdentityId=a&operatorIdentityId=b",
        baseUrl,
      ),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(repeatedQueryRes.status).toBe(400);

    const repeatedEventQueryRes = await fetch(
      new URL(
        "/admin/legal-documents/terms/audit-events?eventType=a&eventType=b",
        baseUrl,
      ),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(repeatedEventQueryRes.status).toBe(400);

    const repeatedPubLimitRes = await fetch(
      new URL(
        "/admin/legal-documents/terms/publications?limit=1&limit=2",
        baseUrl,
      ),
      {
        headers: { Cookie: adminCookie },
      },
    );
    expect(repeatedPubLimitRes.status).toBe(400);

    // Pagination values must be complete positive integers, not parseInt
    // prefixes that could silently alter the requested page.
    for (const path of [
      "/admin/legal-documents/terms?limit=1junk",
      "/admin/legal-documents/terms?publicationLimit=1junk",
      "/admin/legal-documents/terms?cursor=1junk",
      "/admin/legal-documents/terms/publications?limit=1junk",
      "/admin/legal-documents/terms/audit-events?limit=1junk",
    ]) {
      const response = await fetch(new URL(path, baseUrl), {
        headers: { Cookie: adminCookie },
      });
      expect(response.status).toBe(400);
    }

    // 10. Database trigger/check constraint rejects invalid cancellation state on insert
    const invalidDraft = await prisma.legalDocumentRevision.create({
      data: {
        documentId: termsDoc.id,
        sequence: 999,
        editVersion: 1,
        status: "APPROVED",
        revisionCode: "terms-cancellation-test",
        effectiveAt: new Date(Date.now() - 7200000),
        approvalEvidence: "evidence",
        approvedBy: adminOperatorId,
        approvedAt: new Date(),
        contentVersion: 1,
        title: "Title",
        summary: "Summary",
        sections: [{ title: "Title", paragraphs: ["Content"] }],
        contentHash: legalContentHash("Title", "Summary", [
          { title: "Title", paragraphs: ["Content"] },
        ]),
      },
    });
    const invalidFuture = new Date(Date.now() + 3600000);
    await expect(
      prisma.legalDocumentPublication.create({
        data: {
          documentId: termsDoc.id,
          revisionId: invalidDraft.id,
          startsAt: invalidFuture,
          cancelledAt: new Date(),
          publishedBy: adminOperatorId,
          reason: "Invalid cancellation on insert",
        },
      }),
    ).rejects.toThrow(/Publication cannot be inserted cancelled/i);

    // 11. AuditService.recordLegalOperator requires legal:write permission
    const readOnlyOperator: OperatorContext = {
      operatorId: adminOperatorId,
      role: "ADMIN",
      nodeIds: [],
      permissions: [OPERATOR_PERMISSIONS.LEGAL_READ],
      authenticationMethod: "DEVELOPMENT_PASSWORD",
      sessionId: "00000000-0000-0000-0000-000000000000",
    };
    await expect(
      app.get(AuditService).recordLegalOperator(prisma, readOnlyOperator, {
        legalDocumentId: termsDoc.id,
        eventType: "legal_document.draft_created",
        reasonCode: "TEST",
        reason: "Test",
        payload: { test: true },
      }),
    ).rejects.toThrow(ForbiddenException);

    // 12. LegalDocumentsService document readers enforce legal:read permission
    const noReadOperator: OperatorContext = {
      operatorId: adminOperatorId,
      role: "ADMIN",
      nodeIds: [],
      permissions: [],
      authenticationMethod: "DEVELOPMENT_PASSWORD",
      sessionId: "00000000-0000-0000-0000-000000000000",
    };
    await expect(
      app.get(LegalDocumentsService).listDocuments(noReadOperator),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      app.get(LegalDocumentsService).getDocumentByKey(noReadOperator, "terms"),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      app.get(LegalDocumentsService).listPublications(noReadOperator, "terms"),
    ).rejects.toThrow(ForbiddenException);

    const privacyDoc = await prisma.legalDocument.findUniqueOrThrow({
      where: { key: "privacy" },
    });
    const decisionTimeDraft = await prisma.legalDocumentRevision.create({
      data: {
        documentId: privacyDoc.id,
        sequence: 999,
        editVersion: 1,
        status: "APPROVED",
        revisionCode: "privacy-decision-test",
        effectiveAt: new Date(Date.now() - 7200000),
        approvalEvidence: "evidence",
        approvedBy: adminOperatorId,
        approvedAt: new Date(0),
        contentVersion: 1,
        title: "Title",
        summary: "Summary",
        sections: [{ title: "Title", paragraphs: ["Content"] }],
        contentHash: legalContentHash("Title", "Summary", [
          { title: "Title", paragraphs: ["Content"] },
        ]),
      },
    });
    expect(decisionTimeDraft.approvedAt).not.toBeNull();
    expect(decisionTimeDraft.approvedAt?.getTime()).not.toBe(0);

    // A direct writer cannot backdate publication history: a past instant is
    // derived to the trigger's post-lock database time instead.
    const beforeDerivedPublication = Date.now() - 1000;
    const derivedPublication = await prisma.legalDocumentPublication.create({
      data: {
        documentId: privacyDoc.id,
        revisionId: decisionTimeDraft.id,
        startsAt: new Date(Date.now() - 1000),
        publishedBy: adminOperatorId,
        reason: "Past direct publication is derived to database time",
      },
    });
    expect(derivedPublication.startsAt.getTime()).toBeGreaterThanOrEqual(
      beforeDerivedPublication,
    );

    const cancelledHistoricalRevision =
      await prisma.legalDocumentRevision.create({
        data: {
          documentId: privacyDoc.id,
          sequence: 996,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "privacy-cancelled-history-test",
          effectiveAt: new Date(Date.now() - 7200000),
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Cancelled history",
          summary: "Cancelled history coverage",
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: legalContentHash(
            "Cancelled history",
            "Cancelled history coverage",
            [{ title: "Section 1", paragraphs: ["Content"] }],
          ),
        },
      });
    await expect(
      prisma.legalDocumentPublication.create({
        data: {
          documentId: privacyDoc.id,
          revisionId: cancelledHistoricalRevision.id,
          startsAt: new Date(Date.now() - 1000),
          cancelledAt: new Date(Date.now() - 2000),
          publishedBy: adminOperatorId,
          reason: "Invalid cancelled historical import",
        },
      }),
    ).rejects.toThrow(/Publication cannot be inserted cancelled/i);

    const directCancellationStartsAt = new Date(Date.now() + 3_600_000);
    const directCancellationRevision =
      await prisma.legalDocumentRevision.create({
        data: {
          documentId: privacyDoc.id,
          sequence: 998,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "privacy-direct-cancellation-test",
          effectiveAt: directCancellationStartsAt,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Direct cancellation",
          summary: "Direct cancellation coverage",
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: legalContentHash(
            "Direct cancellation",
            "Direct cancellation coverage",
            [{ title: "Section 1", paragraphs: ["Content"] }],
          ),
        },
      });
    const directCancellationPublication =
      await prisma.legalDocumentPublication.create({
        data: {
          documentId: privacyDoc.id,
          revisionId: directCancellationRevision.id,
          startsAt: directCancellationStartsAt,
          publishedBy: adminOperatorId,
          reason: "Direct scheduled publication for cancellation coverage",
        },
      });
    const pendingCollisionRevision = await prisma.legalDocumentRevision.create({
      data: {
        documentId: privacyDoc.id,
        sequence: 997,
        editVersion: 1,
        status: "APPROVED",
        revisionCode: "privacy-pending-collision-test",
        effectiveAt: new Date(Date.now() - 7200000),
        approvalEvidence: "evidence",
        approvedBy: adminOperatorId,
        approvedAt: new Date(),
        contentVersion: 1,
        title: "Pending collision",
        summary: "Pending collision coverage",
        sections: [{ title: "Section 1", paragraphs: ["Content"] }],
        contentHash: legalContentHash(
          "Pending collision",
          "Pending collision coverage",
          [{ title: "Section 1", paragraphs: ["Content"] }],
        ),
      },
    });
    // A direct writer cannot insert an immediate, non-overlapping publication
    // while another revision is already pending for this document.
    await expect(
      prisma.legalDocumentPublication.create({
        data: {
          documentId: privacyDoc.id,
          revisionId: pendingCollisionRevision.id,
          startsAt: new Date(),
          endsAt: directCancellationStartsAt,
          publishedBy: adminOperatorId,
          reason: "Invalid immediate publication while pending",
        },
      }),
    ).rejects.toThrow(/ends_at must be assigned by the database lifecycle/i);
    await expect(
      prisma.legalDocumentPublication.update({
        where: { id: directCancellationPublication.id },
        data: {
          cancelledAt: new Date(),
          endsAt: directCancellationStartsAt,
        },
      }),
    ).rejects.toThrow(/Cannot modify ends_at while cancelling a publication/i);
    await prisma.legalDocumentPublication.update({
      where: { id: directCancellationPublication.id },
      data: { cancelledAt: new Date() },
    });
    await expect(
      prisma.legalDocumentPublication.update({
        where: { id: directCancellationPublication.id },
        data: { endsAt: directCancellationStartsAt },
      }),
    ).rejects.toThrow(/Cancelled publication interval is permanent/i);
    const restoredPredecessor =
      await prisma.legalDocumentPublication.findUniqueOrThrow({
        where: { id: derivedPublication.id },
      });
    expect(restoredPredecessor.endsAt).toBeNull();

    // Database trigger rejects cancelling a publication that has already started
    await expect(
      prisma.$executeRawUnsafe(
        "UPDATE legal_document_publications SET cancelled_at = clock_timestamp() WHERE id = " +
          "\x27" +
          pub.id +
          "\x27",
      ),
    ).rejects.toThrow(/Cannot cancel a publication that has already started/i);

    // Database trigger rejects publication with starts_at < revision effective_at
    const futureEffectiveDate = new Date(Date.now() + 7200000);
    const futureEffectiveDraft = await prisma.legalDocumentRevision.create({
      data: {
        documentId: termsDoc.id,
        sequence: 998,
        editVersion: 1,
        status: "APPROVED",
        revisionCode: "terms-future-effective-test",
        effectiveAt: futureEffectiveDate,
        approvalEvidence: "evidence",
        approvedBy: adminOperatorId,
        approvedAt: new Date(),
        contentVersion: 1,
        title: "Title",
        summary: "Summary",
        sections: [{ title: "Section 1", paragraphs: ["Content"] }],
        contentHash: legalContentHash("Title", "Summary", [
          { title: "Section 1", paragraphs: ["Content"] },
        ]),
      },
    });
    await expect(
      prisma.legalDocumentPublication.create({
        data: {
          documentId: termsDoc.id,
          revisionId: futureEffectiveDraft.id,
          startsAt: new Date(futureEffectiveDate.getTime() - 3600000),
          publishedBy: adminOperatorId,
          reason: "Invalid starts_at before effective_at",
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 989,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-whitespace-title-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "\n",
          summary: "Summary",
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: legalContentHash("\n", "Summary", [
            { title: "Section 1", paragraphs: ["Content"] },
          ]),
        },
      }),
    ).rejects.toThrow();
    const blankNoteSections = [
      { title: "Section 1", paragraphs: ["Content"], note: "\n\t" },
    ] as Parameters<typeof computeLegalRevisionContentHash>[0]["sections"];
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 9911,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-blank-note-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [
            { title: "Section 1", paragraphs: ["Content"], note: "\n\t" },
          ],
          contentHash: legalContentHash("Title", "Summary", blankNoteSections),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 988,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-whitespace-summary-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "\n",
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: legalContentHash("Title", "\n", [
            { title: "Section 1", paragraphs: ["Content"] },
          ]),
        },
      }),
    ).rejects.toThrow();

    // Database immutability trigger rejects mutating id on approved revision
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legal_document_revisions SET id = gen_random_uuid() WHERE id = '${futureEffectiveDraft.id}'`,
      ),
    ).rejects.toThrow();

    // Database check constraint rejects approved revision with empty sections
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 997,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-empty-sections-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [],
          contentHash: "2".repeat(64),
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO legal_document_revisions (
          document_id, sequence, edit_version, status, content_version,
          revision_code, effective_at, approval_evidence, approved_by,
          title, summary, sections, content_hash
        ) VALUES (
          '${termsDoc.id}'::uuid, 9000, 1, 'APPROVED'::legal_revision_status, 1,
          'terms-infinite-effective-test', 'infinity'::timestamptz, 'evidence', '${adminOperatorId}'::uuid,
          'Title', 'Summary', '[{"title":"Section 1","paragraphs":["Content"]}]'::jsonb,
          legal_document_revision_content_hash(
            1, 'Title', 'Summary', '[{"title":"Section 1","paragraphs":["Content"]}]'::jsonb
          )
        )
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO legal_document_revisions (
          document_id, sequence, edit_version, status, content_version,
          revision_code, effective_at, approval_evidence, approved_by,
          title, summary, sections, content_hash
        ) VALUES (
          '${termsDoc.id}'::uuid, 9001, 1, 'APPROVED'::legal_revision_status, 1,
          'terms-out-of-range-effective-test', '280000-01-01'::timestamptz, 'evidence', '${adminOperatorId}'::uuid,
          'Title', 'Summary', '[{"title":"Section 1","paragraphs":["Content"]}]'::jsonb,
          legal_document_revision_content_hash(
            1, 'Title', 'Summary', '[{"title":"Section 1","paragraphs":["Content"]}]'::jsonb
          )
        )
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO legal_document_publications (
          document_id, revision_id, starts_at, published_by, reason
        ) VALUES (
          '${termsDoc.id}'::uuid, '${futureEffectiveDraft.id}'::uuid,
          'infinity'::timestamptz, '${adminOperatorId}'::uuid, 'Infinite publication start'
        )
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO legal_document_publications (
          document_id, revision_id, starts_at, published_by, reason,
          created_at, updated_at
        ) VALUES (
          '${termsDoc.id}'::uuid, '${futureEffectiveDraft.id}'::uuid,
          '2099-01-01'::timestamptz, '${adminOperatorId}'::uuid,
          'Out-of-range publication metadata',
          '280000-01-01'::timestamptz, '280000-01-01'::timestamptz
        )
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO legal_document_publications (
          document_id, revision_id, starts_at, published_by, reason
        ) VALUES (
          '${termsDoc.id}'::uuid, '${futureEffectiveDraft.id}'::uuid,
          '280000-01-01'::timestamptz, '${adminOperatorId}'::uuid, 'Out-of-range publication start'
        )
      `),
    ).rejects.toThrow();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO audit_events (
          id, event_type, actor_kind, actor_id, operator_identity_id,
          legal_document_id, schema_version, reason_code, reason, payload
        ) VALUES (
          gen_random_uuid(), 'legal_document.direct_import', 'OPERATOR'::audit_actor_kind,
          '${adminOperatorId}'::uuid, '${adminOperatorId}'::uuid,
          '${termsDoc.id}'::uuid, 3, 'DIRECT_IMPORT', E'\\n', '{}'::jsonb
        )
      `),
    ).rejects.toThrow();
    const nullNoteSections = [
      { title: "Section 1", paragraphs: ["Content"], note: null },
    ] as unknown as Parameters<
      typeof computeLegalRevisionContentHash
    >[0]["sections"];
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 990,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-null-note-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [
            { title: "Section 1", paragraphs: ["Content"], note: null },
          ],
          contentHash: legalContentHash("Title", "Summary", nullNoteSections),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 991,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-content-hash-mismatch-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: "8".repeat(64),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 994,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-null-evidence-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: null,
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: "5".repeat(64),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 993,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-numeric-title-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [{ title: 123, note: "Content" }],
          contentHash: "6".repeat(64),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 992,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-oversized-content-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "x".repeat(256 * 1024),
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: "7".repeat(64),
        },
      }),
    ).rejects.toThrow();

    // Direct imports cannot mark malformed content or blank approval evidence
    // as an approved revision.
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 996,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-invalid-section-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "evidence",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [{}],
          contentHash: "3".repeat(64),
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.legalDocumentRevision.create({
        data: {
          documentId: termsDoc.id,
          sequence: 995,
          editVersion: 1,
          status: "APPROVED",
          revisionCode: "terms-blank-evidence-test",
          effectiveAt: futureEffectiveDate,
          approvalEvidence: "\n\t",
          approvedBy: adminOperatorId,
          approvedAt: new Date(),
          contentVersion: 1,
          title: "Title",
          summary: "Summary",
          sections: [{ title: "Section 1", paragraphs: ["Content"] }],
          contentHash: "4".repeat(64),
        },
      }),
    ).rejects.toThrow();

    // Database publication integrity trigger rejects modifying historical fields (reason, id)
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legal_document_publications SET reason = 'modified reason' WHERE id = '${pub.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legal_document_publications SET ends_at = clock_timestamp() WHERE id = '${pub.id}'`,
      ),
    ).rejects.toThrow(/currently active publication/i);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legal_document_publications SET id = gen_random_uuid() WHERE id = '${pub.id}'`,
      ),
    ).rejects.toThrow();

    await expect(
      prisma.legalDocument.create({
        data: {
          key: "unrecognized",
          documentId: "unrecognized-document",
          generation: 1,
        },
      }),
    ).rejects.toThrow(/fixed legal document mapping/i);

    // Database legal documents integrity trigger rejects deletion, identity updates, and non-monotonic generation
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM legal_documents WHERE id = '${termsDoc.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legal_documents SET key = 'changed-key' WHERE id = '${termsDoc.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE legal_documents SET generation = 0 WHERE id = '${termsDoc.id}'`,
      ),
    ).rejects.toThrow();
  });
});
