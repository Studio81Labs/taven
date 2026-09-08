import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { parseMetricsQuery } from "./metrics-report.service";

const nodeId = "981cd2d0-7a70-4e4b-9bba-6928f6834ce4";

describe("parseMetricsQuery", () => {
  it("accepts a bounded half-open interval and defaults CZK and the sole granted node", () => {
    expect(
      parseMetricsQuery(
        {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
        },
        [nodeId],
      ),
    ).toMatchObject({ currency: "CZK", nodeId });
  });

  it("rejects an unbounded interval and unknown reporting dimensions", () => {
    expect(() =>
      parseMetricsQuery(
        {
          from: "2026-01-01T00:00:00.000Z",
          to: "2027-01-03T00:00:00.000Z",
        },
        [nodeId],
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      parseMetricsQuery(
        {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
          channel: "social",
        },
        [nodeId],
      ),
    ).toThrow(BadRequestException);
  });

  it("requires a granted node without disclosing an ungranted id", () => {
    expect(() =>
      parseMetricsQuery(
        {
          from: "2026-01-01T00:00:00.000Z",
          to: "2026-01-02T00:00:00.000Z",
          nodeId: "271cd2d0-7a70-4e4b-9bba-6928f6834ce4",
        },
        [nodeId],
      ),
    ).toThrow(NotFoundException);
  });
});
