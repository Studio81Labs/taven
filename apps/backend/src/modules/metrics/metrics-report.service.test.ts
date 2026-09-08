import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import {
  acquisitionMetrics,
  assistedSlaMetrics,
  automationMetrics,
  completenessFor,
  finalContributionMargin,
  isFinalMarginTerminal,
  MetricsReportService,
  operationalReport,
  outstandingGross,
  parseMetricsQuery,
  quoteMetrics,
  type MetricsQuery,
} from "./metrics-report.service";

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

  it.each([
    ["2026-02-30T00:00:00Z"],
    ["2026-01-01T24:00:00Z"],
    ["2026-01-01T00:60:00Z"],
    ["2026-01-01T00:00:60Z"],
    ["2026-01-01T00:00:00+24:00"],
  ])("rejects a calendar-invalid ISO instant: %s", (from) => {
    expect(() =>
      parseMetricsQuery({ from, to: "2026-01-02T00:00:00Z" }, [nodeId]),
    ).toThrow(BadRequestException);
  });
});

describe("v0-1 metric classifications", () => {
  const query: MetricsQuery = {
    from: new Date("2026-01-01T00:00:00.000Z"),
    to: new Date("2026-01-02T00:00:00.000Z"),
    currency: "CZK",
    channel: "paid",
    nodeId,
  };

  it("keeps post-production cancellations out of the pre-production bucket", () => {
    const report = operationalReport(
      [],
      [
        {
          replacesJobId: null,
          status: "CANCELLED",
          failedAt: null,
          printingAt: null,
          printedAt: null,
          qcApprovedAt: new Date("2026-01-01T00:00:00Z"),
          qcRejectedAt: null,
        },
        {
          replacesJobId: null,
          status: "CANCELLED",
          failedAt: null,
          printingAt: new Date("2026-01-01T00:00:00Z"),
          printedAt: null,
          qcApprovedAt: null,
          qcRejectedAt: null,
        },
        {
          replacesJobId: null,
          status: "CANCELLED",
          failedAt: null,
          printingAt: null,
          printedAt: null,
          qcApprovedAt: null,
          qcRejectedAt: null,
        },
      ],
      [],
      new Date("2026-01-02T00:00:00Z"),
      query,
    ) as {
      firstPassYield: {
        firstQcPasses: number;
        cancelledBeforeProduction: number;
      };
    };

    expect(report.firstPassYield).toMatchObject({
      firstQcPasses: 1,
      cancelledBeforeProduction: 1,
    });
  });

  it("excludes expired reserved capacity in the database query", async () => {
    const capacityReservation = { findMany: vi.fn().mockResolvedValue([]) };
    const service = new MetricsReportService({} as never);
    const generatedAt = new Date("2026-01-02T00:00:00Z");
    await service["readMetricFacts"](
      {
        businessEvent: { findMany: vi.fn().mockResolvedValue([]) },
        quoteSession: { findMany: vi.fn().mockResolvedValue([]) },
        automaticQuoteModelFile: { findMany: vi.fn().mockResolvedValue([]) },
        order: { findMany: vi.fn().mockResolvedValue([]) },
        orderPriceBinding: { findMany: vi.fn().mockResolvedValue([]) },
        automaticQuoteRiskDecisionRecord: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        quote: { findMany: vi.fn().mockResolvedValue([]) },
        job: { findMany: vi.fn().mockResolvedValue([]) },
        capacityReservation,
        quoteRequest: { findMany: vi.fn().mockResolvedValue([]) },
        acquisitionSpend: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn().mockResolvedValue([]),
      } as never,
      query,
      generatedAt,
      [],
      new Map(),
      [],
      [],
      [],
    );

    expect(capacityReservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { status: { not: "RESERVED" } },
            { expiresAt: { gt: generatedAt } },
          ],
        }),
      }),
    );
  });

  it("reports no outstanding balance after terminal financial settlement", () => {
    expect(
      outstandingGross(
        {
          status: "REFUNDED",
          settlements: [],
        } as never,
        "CZK",
      ),
    ).toBe(0n);
    expect(
      outstandingGross(
        {
          status: "CANCELLED_SETTLED",
          settlements: [
            {
              kind: "BALANCE_SETTLEMENT",
              currency: "CZK",
              amountDueMinor: 0n,
            },
          ],
        } as never,
        "CZK",
      ),
    ).toBe(0n);
  });

  it("separates persisted assisted handoffs from unresolved automatic uses", () => {
    const report = automationMetrics(
      [
        {
          modelFileId: "model-file",
          draft: {
            order: {
              confirmedAt: null,
              acceptedOrderPriceBindingId: null,
              automaticOrigin: {
                quoteSession: { attribution: { channel: "paid" } },
              },
            },
          },
        },
      ],
      [
        {
          modelFileIds: ["model-file"],
          sourceQuoteSession: { attribution: { channel: "paid" } },
        },
      ],
      new Set(["model-file"]),
      "paid",
    );

    expect(report).toMatchObject({
      confirmedModelFiles: 1,
      successfulAutomaticUses: 0,
      unresolvedOrPending: 0,
      blockedOrHandoff: 1,
      evidenceUnavailable: 0,
    });
  });

  it("scopes partial acquisition spend and completeness warnings to report dimensions", () => {
    const spend = [
      {
        channel: "PAID",
        currency: "CZK",
        periodStart: new Date("2025-12-31T00:00:00.000Z"),
        periodEnd: new Date("2026-01-01T12:00:00.000Z"),
        amountMinor: 100n,
        successor: null,
      },
      {
        channel: "ORGANIC",
        currency: "CZK",
        periodStart: new Date("2025-12-31T00:00:00.000Z"),
        periodEnd: new Date("2026-01-01T12:00:00.000Z"),
        amountMinor: 200n,
        successor: null,
      },
      {
        channel: "PAID",
        currency: "EUR",
        periodStart: new Date("2025-12-31T00:00:00.000Z"),
        periodEnd: new Date("2026-01-01T12:00:00.000Z"),
        amountMinor: 300n,
        successor: null,
      },
    ];

    expect(acquisitionMetrics([], [], new Set(), spend, query)).toMatchObject({
      partialPeriodSpendExcluded: 1,
    });
    expect(
      completenessFor(
        { excludedCurrencyOrders: 0 },
        query.channel,
        spend,
        query,
      ).flags,
    ).toContain("partial_period_acquisition_spend_excluded");
  });

  it("keeps late assisted offers measurable without treating them as timely", () => {
    const report = assistedSlaMetrics(
      [
        {
          attribution: { channel: "paid" },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          slaDueAt: new Date("2026-01-01T01:00:00.000Z"),
          slaRespondedAt: new Date("2026-01-01T02:00:00.000Z"),
          status: "QUOTED",
          quote: { issuedAt: new Date("2026-01-01T02:00:00.000Z") },
        },
      ],
      new Date("2026-01-01T03:00:00.000Z"),
      "paid",
    );

    expect(report).toMatchObject({
      requests: 1,
      responded: 1,
      respondedOnTime: 0,
      respondedLate: 1,
      pendingOverdue: 0,
      responseRate: { numerator: 0, denominator: 1, value: 0 },
    });
  });

  it("reports separate automatic preflight cohort conversion", () => {
    const report = quoteMetrics(
      [
        {
          kind: "automatic",
          channel: "paid",
          accepted: true,
          grossMinor: 10_000n,
          preflight: "clean",
        },
        {
          kind: "automatic",
          channel: "paid",
          accepted: false,
          grossMinor: 10_000n,
          preflight: "warning",
        },
        {
          kind: "automatic",
          channel: "paid",
          accepted: true,
          grossMinor: 10_000n,
          preflight: "warning",
        },
      ],
      "CZK",
      "paid",
    );

    expect(report).toMatchObject({
      automatic: {
        preflightCohorts: {
          clean: {
            offersIssued: 1,
            acceptedBindings: 1,
            conversion: { value: 1 },
          },
          warning: {
            offersIssued: 2,
            acceptedBindings: 1,
            conversion: { value: 0.5 },
          },
        },
      },
    });
  });

  it("treats partially fulfilled orders as terminal for final margin eligibility", () => {
    expect(isFinalMarginTerminal("PARTIALLY_FULFILLED")).toBe(true);
    expect(
      finalContributionMargin(
        {
          status: "PARTIALLY_FULFILLED",
          activeContractPrice: {
            contractPriceRevision: {
              contractTotalMinor: 100n,
              netAmountMinor: 80n,
              currency: "CZK",
            },
          },
          priceBindings: [
            {
              payments: [
                {
                  status: "CAPTURED",
                  currency: "CZK",
                  capturedAmountMinor: 100n,
                  refunds: [],
                },
              ],
            },
          ],
          actualCosts: [
            "MATERIAL",
            "VARIABLE_MACHINE",
            "CARRIER",
            "PACKAGING",
            "PAYMENT_FEE",
          ].map((category) => ({
            category,
            amountMinor: 0n,
            currency: "CZK",
            successor: null,
          })),
          handlingAllocations: [
            {
              allocatedCostMinor: 0n,
              currency: "CZK",
              session: { lifecycle: "COMPLETED", voidedAt: null },
            },
          ],
        } as never,
        "CZK",
      ),
    ).toBe(80n);
  });

  it("uses reconciled retained balance cash for cancelled-settled margin", () => {
    expect(
      finalContributionMargin(
        {
          status: "CANCELLED_SETTLED",
          activeContractPrice: {
            contractPriceRevision: {
              contractTotalMinor: 100n,
              netAmountMinor: 80n,
              vatAmountMinor: 20n,
              taxRegime: "VAT_PAYER",
              vatRateBasisPoints: 2_500,
              currency: "CZK",
            },
          },
          priceBindings: [
            {
              payments: [
                {
                  status: "CAPTURED",
                  currency: "CZK",
                  capturedAmountMinor: 100n,
                  refunds: [{ amountMinor: 50n, status: "SUCCEEDED" }],
                },
              ],
            },
          ],
          settlements: [
            {
              kind: "BALANCE_SETTLEMENT",
              currency: "CZK",
              contractTotalMinor: 100n,
              capturedTotalMinor: 100n,
              retainedAmountMinor: 50n,
              refundAmountMinor: 50n,
              amountDueMinor: 0n,
            },
          ],
          actualCosts: [
            "MATERIAL",
            "VARIABLE_MACHINE",
            "CARRIER",
            "PACKAGING",
            "PAYMENT_FEE",
          ].map((category) => ({
            category,
            amountMinor: 0n,
            currency: "CZK",
            successor: null,
          })),
          handlingAllocations: [
            {
              allocatedCostMinor: 0n,
              currency: "CZK",
              session: { lifecycle: "COMPLETED", voidedAt: null },
            },
          ],
        } as never,
        "CZK",
      ),
    ).toBe(40n);
  });
});
