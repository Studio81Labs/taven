import { ServiceUnavailableException } from "@nestjs/common";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { describe, expect, it, vi } from "vitest";
import {
  computeLegalRevisionContentHash,
  isPublicationDocumentLockConflict,
  LegalDocumentsService,
  MAX_LEGAL_PAYLOAD_BYTES,
  normalizeLegalSections,
  REVISION_CODE_PATTERN,
} from "./legal-documents.service";
import {
  DATABASE_CLOCK_UNAVAILABLE_MESSAGE,
  isDatastoreUnavailable,
} from "../../prisma/datastore-availability";

const legalReader: OperatorContext = {
  operatorId: "11111111-1111-4111-8111-111111111111",
  role: "ADMIN",
  permissions: [OPERATOR_PERMISSIONS.LEGAL_READ],
  nodeIds: [],
  authenticationMethod: "DEVELOPMENT_PASSWORD",
  sessionId: "22222222-2222-4222-8222-222222222222",
};

describe("legal documents helper functions", () => {
  it("maps an unavailable idempotent legal datastore to 503", async () => {
    const service = new LegalDocumentsService(
      {
        $transaction: vi.fn().mockRejectedValue({
          code: "P2010",
          meta: { code: "57P01" },
        }),
      } as never,
      {} as never,
    );
    const serviceWithIdempotency = service as unknown as {
      executeWithIdempotency: <T>(
        namespace: string,
        idempotencyKey: string,
        input: unknown,
        execute: () => Promise<T>,
      ) => Promise<T>;
    };

    const error = await serviceWithIdempotency
      .executeWithIdempotency(
        "legal-document",
        "test-key",
        {},
        async () => "unreachable",
      )
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).message).toBe(
      "Legal document datastore is unavailable",
    );
  });

  it("maps a missing legal database decision time to 503", async () => {
    const service = new LegalDocumentsService(
      {
        $transaction: vi
          .fn()
          .mockRejectedValue(new Error(DATABASE_CLOCK_UNAVAILABLE_MESSAGE)),
      } as never,
      {} as never,
    );
    const serviceWithIdempotency = service as unknown as {
      executeWithIdempotency: <T>(
        namespace: string,
        idempotencyKey: string,
        input: unknown,
        execute: () => Promise<T>,
      ) => Promise<T>;
    };

    const error = await serviceWithIdempotency
      .executeWithIdempotency(
        "legal-document",
        "test-key",
        {},
        async () => "unreachable",
      )
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it("maps unavailable legal document reads to 503", async () => {
    const service = new LegalDocumentsService(
      {
        $transaction: vi.fn().mockRejectedValue({ code: "P1001" }),
      } as never,
      {} as never,
    );

    const error = await service
      .listDocuments(legalReader)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it("recognizes datastore connection exhaustion", () => {
    expect(
      isDatastoreUnavailable(new Error(DATABASE_CLOCK_UNAVAILABLE_MESSAGE)),
    ).toBe(true);
    expect(isDatastoreUnavailable({ code: "P2037" })).toBe(true);
    expect(isDatastoreUnavailable({ code: "P2024" })).toBe(true);
    expect(
      isDatastoreUnavailable({ code: "P2010", meta: { code: "53300" } }),
    ).toBe(true);
  });

  it("recognizes only the identified publication NOWAIT guard conflict", () => {
    expect(
      isPublicationDocumentLockConflict({
        code: "P2010",
        meta: {
          driverAdapterError: {
            message: "legal_document_publications_document_lock_conflict",
            cause: {
              originalCode: "55P03",
              originalMessage:
                "legal_document_publications_document_lock_conflict",
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      isPublicationDocumentLockConflict({
        code: "P2010",
        meta: { driverAdapterError: { cause: { originalCode: "55P03" } } },
      }),
    ).toBe(false);
    expect(
      isPublicationDocumentLockConflict({
        code: "P2010",
        meta: {
          driverAdapterError: {
            message: "legal_document_publications_document_lock_conflict",
            cause: { originalCode: "40P01" },
          },
        },
      }),
    ).toBe(false);
  });

  it("normalizes and validates section content", () => {
    const raw = [
      {
        title: "  1. Úvodní ustanovení  ",
        paragraphs: ["  První odstavec.  ", "Druhý odstavec."],
        items: ["  Bod A "],
        note: " Doplňující poznámka ",
      },
    ];

    const normalized = normalizeLegalSections(raw);
    expect(normalized).toEqual([
      {
        title: "1. Úvodní ustanovení",
        paragraphs: ["První odstavec.", "Druhý odstavec."],
        items: ["Bod A"],
        note: "Doplňující poznámka",
      },
    ]);
  });

  it("rejects empty sections array or missing title", () => {
    expect(() => normalizeLegalSections([])).toThrow(
      "Sections must be a non-empty array",
    );
    expect(() => normalizeLegalSections([{ title: "   " }])).toThrow(
      "Section title must not be empty",
    );
  });

  it.each([
    { paragraphs: [] },
    { paragraphs: ["  "] },
    { items: [] },
    { items: ["  "] },
  ])("rejects supplied empty or blank-only section arrays", (content) => {
    expect(() =>
      normalizeLegalSections([
        { title: "Section", note: "Content", ...content },
      ]),
    ).toThrow(/must (contain at least one non-empty string|not be empty)/);
  });

  it.each([
    [
      { paragraphs: ["Operative text", " "] },
      "Section 0 paragraph 1 must not be empty",
    ],
    [{ items: ["Operative item", " "] }, "Section 0 item 1 must not be empty"],
  ])(
    "rejects blank members in otherwise valid section arrays",
    (content, error) => {
      expect(() =>
        normalizeLegalSections([
          { title: "Section", note: "Content", ...content },
        ]),
      ).toThrow(error);
    },
  );

  it.each([
    [{ note: " " }, "Section 0 note must not be empty"],
    [{ note: null }, "Section 0 note must be a string"],
  ])("rejects invalid supplied section notes", (content, error) => {
    expect(() =>
      normalizeLegalSections([
        { title: "Section", paragraphs: ["Operative text"], ...content },
      ]),
    ).toThrow(error);
  });

  it("rejects unknown section fields", () => {
    expect(() =>
      normalizeLegalSections([
        { title: "Section", note: "Content", sourceUrl: "https://test" },
      ]),
    ).toThrow("Section 0 contains an unknown field");
  });

  it.each([
    { title: "\ud800", paragraphs: ["Content"] },
    { title: "Section", paragraphs: ["\udc00"] },
    { title: "Section", items: ["\ud800"] },
    { title: "Section", note: "\udc00" },
  ])("rejects an unpaired surrogate in section content", (section) => {
    expect(() => normalizeLegalSections([section])).toThrow(
      "invalid Unicode scalar",
    );
  });

  it("computes deterministic sha256 hash for canonical content", () => {
    const hash1 = computeLegalRevisionContentHash({
      contentVersion: 1,
      title: "Podmínky",
      summary: "Shrnutí",
      sections: [{ title: "Sekce", note: "Poznámka" }],
    });

    const hash2 = computeLegalRevisionContentHash({
      contentVersion: 1,
      title: "Podmínky",
      summary: "Shrnutí",
      sections: [{ title: "Sekce", note: "Poznámka" }],
    });

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("enforces revision code pattern", () => {
    expect(REVISION_CODE_PATTERN.test("terms-2026-09-v1")).toBe(true);
    expect(REVISION_CODE_PATTERN.test("CLAIMS_V2.1")).toBe(true);
    expect(REVISION_CODE_PATTERN.test("")).toBe(false);
    expect(
      REVISION_CODE_PATTERN.test("invalid revision code with spaces"),
    ).toBe(false);
    expect(REVISION_CODE_PATTERN.test("a".repeat(101))).toBe(false);
  });

  it("enforces max payload limit constant", () => {
    expect(MAX_LEGAL_PAYLOAD_BYTES).toBe(256 * 1024);
  });
});
