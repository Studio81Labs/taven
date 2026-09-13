import { describe, expect, it } from "vitest";
import {
  computeLegalRevisionContentHash,
  MAX_LEGAL_PAYLOAD_BYTES,
  normalizeLegalSections,
  REVISION_CODE_PATTERN,
} from "./legal-documents.service";

describe("legal documents helper functions", () => {
  it("normalizes and validates section content", () => {
    const raw = [
      {
        title: "  1. Úvodní ustanovení  ",
        paragraphs: ["  První odstavec.  ", "  ", "Druhý odstavec."],
        items: ["  Bod A ", ""],
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

  it("rejects a section with no paragraphs, items, or note", () => {
    expect(() =>
      normalizeLegalSections([{ title: "Prázdná sekce", paragraphs: ["  "] }]),
    ).toThrow(
      "Each section must contain at least one paragraph, item, or note",
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
