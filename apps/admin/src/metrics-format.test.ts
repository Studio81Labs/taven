import { describe, expect, it } from "vitest";
import { isoFromZonedInput } from "./operator-requests";
import {
  currentPragueMonth,
  moneyRatio,
  pragueMidnight,
  ratio,
} from "./metrics-format";

describe("Prague report periods and evidence", () => {
  it("uses the offset in effect at each midnight around daylight saving changes", () => {
    expect(pragueMidnight("2026-03-29")).toBe("2026-03-28T23:00:00.000Z");
    expect(pragueMidnight("2026-03-30")).toBe("2026-03-29T22:00:00.000Z");
    expect(pragueMidnight("2026-10-25")).toBe("2026-10-24T22:00:00.000Z");
    expect(pragueMidnight("2026-10-26")).toBe("2026-10-25T23:00:00.000Z");
  });

  it("chooses the report month in Prague at a UTC month boundary", () => {
    expect(currentPragueMonth(new Date("2026-09-30T22:30:00Z"))).toBe(
      "2026-10",
    );
  });

  it("rejects nonexistent Prague wall times and incorrect offsets", () => {
    expect(() => isoFromZonedInput("2026-03-29T02:30:00+01:00")).toThrow();
    expect(() => isoFromZonedInput("2026-01-15T10:00:00+02:00")).toThrow();
    expect(isoFromZonedInput("2026-10-25T02:30:00+02:00")).toBe(
      "2026-10-25T00:30:00.000Z",
    );
    expect(isoFromZonedInput("2026-10-25T02:30:00+01:00")).toBe(
      "2026-10-25T01:30:00.000Z",
    );
    expect(() => isoFromZonedInput("2026-10-25T02:30:00")).toThrow();
  });

  it("keeps unavailable ratios explicit, including nonzero denominators", () => {
    expect(ratio({ numerator: 0, denominator: 3, value: null })).toContain(
      "0/3",
    );
    expect(
      moneyRatio({
        numerator: { amountMinor: "0", currency: "CZK" },
        denominator: 0,
        value: null,
      }),
    ).toBe("Neznámé / 0");
  });
});
