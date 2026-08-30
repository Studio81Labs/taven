import { describe, expect, it } from "vitest";
import { addBusinessHours } from "./quotes.service";

describe("quote-request SLA", () => {
  it("adds 24 weekday hours without counting the weekend", () => {
    expect(
      addBusinessHours(new Date("2026-08-28T10:30:00.000Z"), 24).toISOString(),
    ).toBe("2026-08-31T10:30:00.000Z");
  });

  it("starts counting when a weekend submission reaches Monday", () => {
    expect(
      addBusinessHours(new Date("2026-08-29T10:30:00.000Z"), 24).toISOString(),
    ).toBe("2026-09-01T00:30:00.000Z");
  });
});
