import { describe, expect, it } from "vitest";
import {
  buildCanonicalKey,
  InvalidKeyComponentError,
} from "./canonical-key.js";
import {
  buildIdempotencyKey,
  buildOutboxDedupeKey,
} from "./idempotency-key.js";

describe("deterministic operation keys", () => {
  it("is deterministic and separates command and outbox namespaces", () => {
    const scope = [
      { name: "payment_id", value: "pay-1" },
      { name: "provider_transaction_id", value: "provider-1" },
    ] as const;

    expect(buildIdempotencyKey("late-capture", scope)).toBe(
      buildIdempotencyKey("late-capture", scope),
    );
    expect(buildOutboxDedupeKey("late-capture", scope)).not.toBe(
      buildIdempotencyKey("late-capture", scope),
    );
  });

  it("uses length prefixes to prevent delimiter collisions", () => {
    const first = buildCanonicalKey("test", 1, [
      { name: "left", value: "a|right:1:b" },
    ]);
    const second = buildCanonicalKey("test", 1, [
      { name: "left", value: "a" },
      { name: "right", value: "b" },
    ]);

    expect(first).not.toBe(second);
  });

  it("requires a named operation", () => {
    expect(() => buildIdempotencyKey("", [{ name: "id", value: "1" }])).toThrow(
      InvalidKeyComponentError,
    );
  });

  it.each([
    ["invalid namespace", () => buildCanonicalKey("Invalid", 1, [])],
    [
      "invalid version",
      () => buildCanonicalKey("test", 0, [{ name: "id", value: "1" }]),
    ],
    [
      "empty component",
      () => buildCanonicalKey("test", 1, [{ name: "id", value: "" }]),
    ],
    [
      "unsafe number",
      () =>
        buildCanonicalKey("test", 1, [
          { name: "id", value: Number.MAX_SAFE_INTEGER + 1 },
        ]),
    ],
    [
      "duplicate component names",
      () =>
        buildCanonicalKey("test", 1, [
          { name: "id", value: "1" },
          { name: "id", value: "2" },
        ]),
    ],
  ])("rejects %s", (_label, build) => {
    expect(build).toThrow(InvalidKeyComponentError);
  });
});
