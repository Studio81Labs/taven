import { describe, expect, it } from "vitest";
import { Sha256Digest } from "./digest.js";
import { DomainError } from "./errors.js";
import { RevisionRef } from "./revision-ref.js";
import { FixedClock, Instant } from "./time.js";
import { Duration, Quantity, Weight } from "./units.js";

describe("integer units", () => {
  it.each([
    ["quantity", () => Quantity.of(3).count],
    ["weight", () => Weight.milligrams(3).milligrams],
    ["duration", () => Duration.seconds(3).seconds],
  ])("keeps %s in integral base units", (_name, create) => {
    expect(create()).toBe(3n);
  });

  it.each([
    () => Quantity.of(-1),
    () => Weight.grams(1.2),
    () => Duration.seconds(Number.MAX_SAFE_INTEGER + 1),
  ])("rejects invalid base units", (create) => {
    expect(create).toThrow(DomainError);
  });
});

describe("Sha256Digest", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("calculates SHA-256 for %j", (input, expected) => {
    expect(Sha256Digest.of(input).hex).toBe(expected);
  });

  it("matches the multi-block SHA-256 reference vector", () => {
    expect(
      Sha256Digest.of(
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      ).hex,
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });

  it("parses an existing canonical digest for adapter boundaries", () => {
    const hex = "a".repeat(64);
    expect(Sha256Digest.parse(hex).hex).toBe(hex);
    expect(() => Sha256Digest.parse("A".repeat(64))).toThrow(
      /64 lowercase hexadecimal/,
    );
  });
});

describe("revision references and instants", () => {
  it("makes typed immutable revision references", () => {
    const reference = RevisionRef.create("reference-profile", "rev_1");
    expect(reference.toString()).toBe("reference-profile:rev_1");
    expect(Object.isFrozen(reference)).toBe(true);
    expect(() => RevisionRef.create("", "rev_1")).toThrow(
      expect.objectContaining({ code: "INVALID_REVISION_REFERENCE" }),
    );
  });

  it("uses an injected clock", () => {
    const instant = Instant.parse("2026-01-02T03:04:05.000Z");
    expect(new FixedClock(instant).now()).toBe(instant);
    expect(instant.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(instant.add(Duration.seconds(5)).toISOString()).toBe(
      "2026-01-02T03:04:10.000Z",
    );
    expect(() => Instant.parse("2026-01-02T03:04:05Z")).toThrow(
      /canonical UTC ISO-8601/,
    );
  });
});
