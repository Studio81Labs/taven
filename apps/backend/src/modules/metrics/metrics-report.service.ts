import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import type { OperatorContext } from "../admin-access/operator-context";
import { requireOperatorPermission } from "../admin-access/operator-command";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import type {
  MetricMoney,
  MetricRatio,
  MetricsCompleteness,
  MetricsInterval,
  MetricsOrderPageDto,
  MetricsReportDto,
} from "./metrics-report.dto";

const MAX_INTERVAL_MILLISECONDS = 366 * 24 * 60 * 60 * 1_000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CHANNELS = new Set(["direct", "organic", "paid", "referral", "unknown"]);
const CURRENCIES = new Set(["CZK"]);
type PriceBand =
  | "under_25000"
  | "25000_to_49999"
  | "50000_to_99999"
  | "100000_to_199999"
  | "200000_or_more";

type Transaction = Prisma.TransactionClient;
type Channel = "direct" | "organic" | "paid" | "referral" | "unknown";

export type MetricsQuery = Readonly<{
  from: Date;
  to: Date;
  channel?: Channel;
  currency: string;
  nodeId: string;
}>;

type ReportOrder = Readonly<{
  id: string;
  publicReference: string;
  status: string;
  confirmedAt: Date | null;
  customerId: string | null;
  customer: Readonly<{ firstAttribution: Prisma.JsonValue | null }> | null;
  automaticOrigin: Readonly<{
    quoteSession: Readonly<{ attribution: Prisma.JsonValue | null }>;
  }> | null;
  individualOrigin: Readonly<{
    quote: Readonly<{
      quoteRequest: Readonly<{ attribution: Prisma.JsonValue | null }>;
    }>;
  }> | null;
  acceptedPriceBinding: Readonly<{
    id: string;
    priceSnapshot: Readonly<{
      contractTotalMinor: bigint;
      netAmountMinor: bigint;
      vatAmountMinor: bigint;
      currency: string;
      components: readonly Readonly<{ kind: string }>[];
    }>;
  }> | null;
  activeContractPrice: Readonly<{
    contractPriceRevision: Readonly<{
      contractTotalMinor: bigint;
      netAmountMinor: bigint;
      vatAmountMinor: bigint;
      taxRegime: "NON_VAT_PAYER" | "VAT_PAYER";
      vatRateBasisPoints: number;
      currency: string;
    }>;
  }> | null;
  priceBindings: readonly Readonly<{
    payments: readonly Readonly<{
      capturedAmountMinor: bigint | null;
      currency: string;
      status: string;
      refunds: readonly Readonly<{
        amountMinor: bigint;
        status: string;
      }>[];
    }>[];
  }>[];
  actualCosts: readonly Readonly<{
    amountMinor: bigint;
    currency: string;
    category: string;
    successor: Readonly<{ id: string }> | null;
  }>[];
  handlingAllocations: readonly Readonly<{
    allocatedCostMinor: bigint;
    currency: string;
    session: Readonly<{ lifecycle: string; voidedAt: Date | null }>;
  }>[];
  settlements: readonly Readonly<{
    kind: string;
    currency: string;
    contractTotalMinor: bigint;
    capturedTotalMinor: bigint;
    retainedAmountMinor: bigint;
    refundAmountMinor: bigint;
    amountDueMinor: bigint;
  }>[];
  jobs: readonly Readonly<{ nodeId: string }>[];
  phases: readonly Readonly<{
    eligibilitySnapshots: readonly Readonly<{ nodeId: string }>[];
  }>[];
}>;

type Cursor = Readonly<{
  confirmedAt: string;
  id: string;
  filterHash: string;
}>;

type OperationalJob = Readonly<{
  replacesJobId: string | null;
  status: string;
  failedAt: Date | null;
  printingAt: Date | null;
  printedAt: Date | null;
  qcApprovedAt: Date | null;
  qcRejectedAt: Date | null;
}>;

@Injectable()
export class MetricsReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(
    operator: OperatorContext,
    query: MetricsQuery,
  ): Promise<MetricsReportDto> {
    this.authorize(operator, query.nodeId);
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
        const generatedAt = await databaseNow(transaction);
        const orders = (await transaction.order.findMany({
          where: {
            confirmedAt: { gte: query.from, lt: query.to },
          },
          orderBy: [{ confirmedAt: "desc" }, { id: "desc" }],
          include: reportOrderInclude,
        })) as unknown as readonly ReportOrder[];
        const filteredOrders = orders.filter(
          (order) =>
            selectedCurrency(order, query.currency) &&
            matchesChannel(orderChannel(order), query.channel),
        );
        const operationalOrders = filteredOrders.filter((order) =>
          hasProvenOperationalScope(order, query.nodeId),
        );
        const events = await transaction.businessEvent.findMany({
          where: {
            observedAt: { gte: query.from, lt: query.to },
            eventType: {
              in: [
                "upload.confirmed",
                "quote.viewed",
                "checkout.started",
                "quote.bound",
              ],
            },
          },
          select: {
            eventType: true,
            observedAt: true,
            quoteSessionId: true,
            orderId: true,
            payload: true,
          },
        });
        const quoteSessions = await transaction.quoteSession.findMany({
          where: {
            id: {
              in: events
                .map((event) => event.quoteSessionId)
                .filter((id): id is string => id !== null),
            },
          },
          select: { id: true, attribution: true },
        });
        const sessionChannels = new Map(
          quoteSessions.map((session) => [
            session.id,
            attributionChannel(session.attribution),
          ]),
        );
        const metricFacts = await this.readMetricFacts(
          transaction,
          query,
          generatedAt,
          events,
          sessionChannels,
          orders,
          filteredOrders,
          operationalOrders,
        );
        return {
          metricDefinition: "v0-1",
          generatedAt: generatedAt.toISOString(),
          interval: intervalDto(query),
          sourceCoverage: metricFacts.sourceCoverage,
          completeness: metricFacts.completeness,
          commercial: metricFacts.commercial,
          operational: metricFacts.operational,
        } as unknown as MetricsReportDto;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async orders(
    operator: OperatorContext,
    query: MetricsQuery,
    cursor: string | undefined,
    limit = DEFAULT_LIMIT,
  ): Promise<MetricsOrderPageDto> {
    this.authorize(operator, query.nodeId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException("metrics orders limit is invalid");
    }
    const filterHash = digest({
      from: query.from.toISOString(),
      to: query.to.toISOString(),
      channel: query.channel,
      currency: query.currency,
      nodeId: query.nodeId,
    });
    const keyset = cursor ? parseCursor(cursor, filterHash) : undefined;
    return this.prisma.$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SET TRANSACTION READ ONLY`;
        const generatedAt = await databaseNow(transaction);
        const keys = await pageOrderKeys(transaction, query, keyset, limit);
        const rows = (await transaction.order.findMany({
          where: { id: { in: keys.map((key) => key.id) } },
          include: reportOrderInclude,
        })) as unknown as readonly ReportOrder[];
        const byId = new Map(rows.map((order) => [order.id, order]));
        const scoped = keys
          .map((key) => byId.get(key.id))
          .filter((order): order is ReportOrder => order !== undefined);
        const page = scoped.slice(0, limit);
        const last = page.at(-1);
        const more = keys.length > limit;
        const coverage = await pageSourceCoverage(transaction, query);
        return {
          metricDefinition: "v0-1",
          generatedAt: generatedAt.toISOString(),
          interval: intervalDto(query),
          sourceCoverage: coverage,
          completeness: completenessFor(coverage, query.channel),
          scope: "OPERATIONAL_NODE",
          nodeId: query.nodeId,
          items: page.map((order) => orderDetail(order, query.currency)),
          ...(more && last
            ? {
                nextCursor: encodeCursor({
                  confirmedAt: requiredConfirmedAt(last).toISOString(),
                  id: last.id,
                  filterHash,
                }),
              }
            : {}),
        } as unknown as MetricsOrderPageDto;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private authorize(operator: OperatorContext, nodeId: string): void {
    requireOperatorPermission(operator, OPERATOR_PERMISSIONS.METRICS_READ);
    if (operator.role !== "ADMIN") {
      throw new ForbiddenException(
        "Metrics reports are limited to administrators",
      );
    }
    if (!operator.nodeIds.includes(nodeId)) {
      throw new NotFoundException("Metrics node was not found");
    }
  }

  private async readMetricFacts(
    transaction: Transaction,
    query: MetricsQuery,
    generatedAt: Date,
    events: readonly Readonly<{
      eventType: string;
      observedAt: Date;
      quoteSessionId: string | null;
      orderId: string | null;
      payload: Prisma.JsonValue;
    }>[],
    sessionChannels: ReadonlyMap<string, Channel>,
    allIntervalOrders: readonly ReportOrder[],
    commercialOrders: readonly ReportOrder[],
    operationalOrders: readonly ReportOrder[],
  ): Promise<
    Readonly<{
      sourceCoverage: Record<string, unknown>;
      completeness: MetricsCompleteness;
      commercial: Record<string, unknown>;
      operational: Record<string, unknown>;
    }>
  > {
    const bound = await bindingFacts(
      transaction,
      events,
      sessionChannels,
      query.currency,
    );
    const uploadModelFileIds = new Set(
      events
        .filter((event) => event.eventType === "upload.confirmed")
        .map((event) => jsonString(event.payload, "modelFileId"))
        .filter((id): id is string => id !== undefined),
    );
    const automaticUses = await transaction.automaticQuoteModelFile.findMany({
      where: { modelFileId: { in: [...uploadModelFileIds] } },
      include: {
        draft: {
          include: {
            order: {
              include: {
                automaticOrigin: {
                  include: { quoteSession: { select: { attribution: true } } },
                },
              },
            },
          },
        },
      },
    });
    const automaticHandoffs =
      uploadModelFileIds.size === 0
        ? []
        : await transaction.automaticQuoteRequestHandoff.findMany({
            where: { modelFileIds: { hasSome: [...uploadModelFileIds] } },
            select: {
              modelFileIds: true,
              sourceQuoteSession: { select: { attribution: true } },
            },
          });
    const firstConfirmedOrders = await transaction.$queryRaw<
      Array<{ customerId: string; id: string }>
    >`
      SELECT DISTINCT ON ("customer_id")
        "customer_id" AS "customerId",
        "id"
      FROM "orders"
      WHERE "customer_id" IS NOT NULL
        AND "confirmed_at" IS NOT NULL
        AND "confirmed_at" < ${query.to}
      ORDER BY "customer_id", "confirmed_at" ASC, "id" ASC
    `;
    const jobs = await operationalJobs(transaction, query);
    const queue = await transaction.capacityReservation.findMany({
      where: {
        nodeId: query.nodeId,
        status: { in: ["RESERVED", "HELD", "SCHEDULED", "PRINTING"] },
        endsAt: { gt: generatedAt },
        OR: [
          { status: { not: "RESERVED" } },
          { expiresAt: { gt: generatedAt } },
        ],
      },
      select: { machineId: true, startsAt: true, endsAt: true, status: true },
    });
    const requests = await transaction.quoteRequest.findMany({
      where: { createdAt: { gte: query.from, lt: query.to } },
      select: {
        id: true,
        attribution: true,
        createdAt: true,
        slaDueAt: true,
        slaRespondedAt: true,
        status: true,
        quote: { select: { issuedAt: true } },
      },
    });
    const spend = await transaction.acquisitionSpend.findMany({
      where: {
        periodEnd: { gt: query.from },
        periodStart: { lt: query.to },
      },
      include: { successor: { select: { id: true } } },
    });
    const coverage = sourceCoverage(allIntervalOrders, query.currency);
    const completeness = completenessFor(coverage, query.channel, spend, query);
    const firstOrderIds = new Set(
      firstConfirmedOrders.map((order) => order.id),
    );
    return {
      sourceCoverage: coverage,
      completeness,
      commercial: commercialReport(
        commercialOrders,
        events,
        sessionChannels,
        bound,
        automaticUses,
        automaticHandoffs,
        uploadModelFileIds,
        firstOrderIds,
        spend,
        requests,
        generatedAt,
        query,
      ),
      operational: operationalReport(
        operationalOrders,
        jobs,
        queue,
        generatedAt,
        query,
      ),
    };
  }
}

const reportOrderInclude = {
  customer: { select: { firstAttribution: true } },
  automaticOrigin: {
    include: { quoteSession: { select: { attribution: true } } },
  },
  individualOrigin: {
    include: {
      quote: { include: { quoteRequest: { select: { attribution: true } } } },
    },
  },
  acceptedPriceBinding: {
    include: {
      priceSnapshot: { include: { components: { select: { kind: true } } } },
    },
  },
  activeContractPrice: { include: { contractPriceRevision: true } },
  priceBindings: { include: { payments: { include: { refunds: true } } } },
  actualCosts: { include: { successor: { select: { id: true } } } },
  handlingAllocations: {
    include: { session: { select: { lifecycle: true, voidedAt: true } } },
  },
  settlements: {
    select: {
      kind: true,
      currency: true,
      contractTotalMinor: true,
      capturedTotalMinor: true,
      retainedAmountMinor: true,
      refundAmountMinor: true,
      amountDueMinor: true,
    },
  },
  jobs: { select: { nodeId: true } },
  phases: { include: { eligibilitySnapshots: { select: { nodeId: true } } } },
} as const;

export function parseMetricsQuery(
  values: Readonly<Record<string, string | undefined>>,
  nodeIds: readonly string[],
): MetricsQuery {
  const from = parseInstant("from", values.from);
  const to = parseInstant("to", values.to);
  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException("from must be before to");
  }
  if (to.getTime() - from.getTime() > MAX_INTERVAL_MILLISECONDS) {
    throw new BadRequestException("metrics interval must be at most 366 days");
  }
  const channel = values.channel;
  if (channel !== undefined && !CHANNELS.has(channel)) {
    throw new BadRequestException("channel is invalid");
  }
  const currency = values.currency ?? "CZK";
  if (!CURRENCIES.has(currency)) {
    throw new BadRequestException("currency is invalid");
  }
  const explicitNode = values.nodeId;
  if (explicitNode !== undefined && !UUID_PATTERN.test(explicitNode)) {
    throw new BadRequestException("nodeId is invalid");
  }
  const nodeId = explicitNode ?? defaultNode(nodeIds);
  if (!nodeIds.includes(nodeId)) {
    throw new NotFoundException("Metrics node was not found");
  }
  return {
    from,
    to,
    currency,
    nodeId,
    ...(channel ? { channel: channel as Channel } : {}),
  };
}

async function operationalJobs(
  transaction: Transaction,
  query: MetricsQuery,
): Promise<readonly OperationalJob[]> {
  const select = {
    replacesJobId: true,
    status: true,
    failedAt: true,
    printingAt: true,
    printedAt: true,
    qcApprovedAt: true,
    qcRejectedAt: true,
  } as const;
  if (!query.channel) {
    return transaction.job.findMany({
      where: {
        nodeId: query.nodeId,
        createdAt: { gte: query.from, lt: query.to },
      },
      select,
    });
  }
  return transaction.$queryRaw<OperationalJob[]>`
    SELECT
      job.replaces_job_id AS "replacesJobId",
      job.status::text AS status,
      job.failed_at AS "failedAt",
      job.printing_at AS "printingAt",
      job.printed_at AS "printedAt",
      job.qc_approved_at AS "qcApprovedAt",
      job.qc_rejected_at AS "qcRejectedAt"
    FROM jobs AS job
    JOIN orders AS "order" ON "order".id = job.order_id
    LEFT JOIN automatic_order_origins AS automatic_origin
      ON automatic_origin.order_id = "order".id
    LEFT JOIN quote_sessions AS automatic_session
      ON automatic_session.id = automatic_origin.quote_session_id
    LEFT JOIN individual_order_origins AS individual_origin
      ON individual_origin.order_id = "order".id
    LEFT JOIN quotes AS individual_quote
      ON individual_quote.id = individual_origin.quote_id
    LEFT JOIN quote_requests AS individual_request
      ON individual_request.id = individual_quote.quote_request_id
    LEFT JOIN customers AS customer ON customer.id = "order".customer_id
    WHERE job.node_id = ${query.nodeId}::uuid
      AND job.created_at >= ${query.from}
      AND job.created_at < ${query.to}
      AND CASE
        WHEN automatic_session.attribution IS NOT NULL
          AND automatic_session.attribution <> 'null'::jsonb
          THEN COALESCE(automatic_session.attribution->>'channel', 'unknown')
        WHEN individual_request.attribution IS NOT NULL
          AND individual_request.attribution <> 'null'::jsonb
          THEN COALESCE(individual_request.attribution->>'channel', 'unknown')
        ELSE COALESCE(customer.first_attribution->>'channel', 'unknown')
      END = ${query.channel}
  `;
}

function defaultNode(nodeIds: readonly string[]): string {
  if (nodeIds.length !== 1 || !nodeIds[0]) {
    throw new BadRequestException("nodeId is required for this administrator");
  }
  return nodeIds[0];
}

function parseInstant(name: string, value: string | undefined): Date {
  if (!value || !INSTANT_PATTERN.test(value)) {
    throw new BadRequestException(`${name} is an ISO instant`);
  }
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!parts) throw new BadRequestException(`${name} is an ISO instant`);
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    offsetHourText,
    offsetMinuteText,
  ] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute =
    offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${name} is an ISO instant`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException(`${name} is an ISO instant`);
  }
  return date;
}

async function databaseNow(transaction: Transaction): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
    SELECT clock_timestamp() AS now
  `;
  const now = rows[0]?.now;
  if (!now) throw new Error("Metrics database clock is unavailable");
  return now;
}

async function pageOrderKeys(
  transaction: Transaction,
  query: MetricsQuery,
  cursor: Cursor | undefined,
  limit: number,
): Promise<readonly Readonly<{ id: string; confirmedAt: Date }>[]> {
  const channel = query.channel
    ? Prisma.sql`
        AND CASE
          WHEN automatic_session.attribution IS NOT NULL
            AND automatic_session.attribution <> 'null'::jsonb
            THEN COALESCE(automatic_session.attribution->>'channel', 'unknown')
          WHEN individual_request.attribution IS NOT NULL
            AND individual_request.attribution <> 'null'::jsonb
            THEN COALESCE(individual_request.attribution->>'channel', 'unknown')
          ELSE COALESCE(customer.first_attribution->>'channel', 'unknown')
        END = ${query.channel}
      `
    : Prisma.empty;
  const keyset = cursor
    ? Prisma.sql`
        AND (
          "order".confirmed_at < ${new Date(cursor.confirmedAt)}
          OR (
            "order".confirmed_at = ${new Date(cursor.confirmedAt)}
            AND "order".id < ${cursor.id}::uuid
          )
        )
      `
    : Prisma.empty;
  return transaction.$queryRaw<
    Array<Readonly<{ id: string; confirmedAt: Date }>>
  >`
    SELECT "order".id, "order".confirmed_at AS "confirmedAt"
    FROM orders AS "order"
    JOIN order_price_bindings AS accepted_binding
      ON accepted_binding.id = "order".accepted_order_price_binding_id
    JOIN price_snapshots AS accepted_price
      ON accepted_price.id = accepted_binding.price_snapshot_id
    LEFT JOIN automatic_order_origins AS automatic_origin
      ON automatic_origin.order_id = "order".id
    LEFT JOIN quote_sessions AS automatic_session
      ON automatic_session.id = automatic_origin.quote_session_id
    LEFT JOIN individual_order_origins AS individual_origin
      ON individual_origin.order_id = "order".id
    LEFT JOIN quotes AS individual_quote
      ON individual_quote.id = individual_origin.quote_id
    LEFT JOIN quote_requests AS individual_request
      ON individual_request.id = individual_quote.quote_request_id
    LEFT JOIN customers AS customer ON customer.id = "order".customer_id
    WHERE "order".confirmed_at >= ${query.from}
      AND "order".confirmed_at < ${query.to}
      AND accepted_price.currency = ${query.currency}
      AND NOT EXISTS (
        SELECT 1
        FROM jobs AS job
        WHERE job.order_id = "order".id
          AND job.node_id <> ${query.nodeId}::uuid
      )
      AND NOT EXISTS (
        SELECT 1
        FROM order_phases AS phase
        JOIN eligibility_snapshots AS eligibility
          ON eligibility.order_phase_id = phase.id
        WHERE phase.order_id = "order".id
          AND eligibility.node_id <> ${query.nodeId}::uuid
      )
      AND (
        EXISTS (
          SELECT 1
          FROM jobs AS job
          WHERE job.order_id = "order".id
            AND job.node_id = ${query.nodeId}::uuid
        )
        OR EXISTS (
          SELECT 1
          FROM order_phases AS phase
          JOIN eligibility_snapshots AS eligibility
            ON eligibility.order_phase_id = phase.id
          WHERE phase.order_id = "order".id
            AND eligibility.node_id = ${query.nodeId}::uuid
        )
      )
      ${channel}
      ${keyset}
    ORDER BY "order".confirmed_at DESC, "order".id DESC
    LIMIT ${limit + 1}
  `;
}

async function pageSourceCoverage(
  transaction: Transaction,
  query: MetricsQuery,
): Promise<Record<string, unknown>> {
  const rows = await transaction.$queryRaw<
    Array<{ selectedCurrencyOrders: bigint; excludedCurrencyOrders: bigint }>
  >`
    SELECT
      count(*) FILTER (
        WHERE accepted_price.currency = ${query.currency}
      ) AS "selectedCurrencyOrders",
      count(*) FILTER (
        WHERE accepted_price.currency <> ${query.currency}
      ) AS "excludedCurrencyOrders"
    FROM orders AS "order"
    LEFT JOIN order_price_bindings AS accepted_binding
      ON accepted_binding.id = "order".accepted_order_price_binding_id
    LEFT JOIN price_snapshots AS accepted_price
      ON accepted_price.id = accepted_binding.price_snapshot_id
    WHERE "order".confirmed_at >= ${query.from}
      AND "order".confirmed_at < ${query.to}
  `;
  const coverage = rows[0];
  return {
    businessEvents: {
      retainedClientObservations: true,
      historicalBackfill: "not_performed",
    },
    directRelationalFacts: true,
    selectedCurrencyOrders: boundedCount(coverage?.selectedCurrencyOrders),
    excludedCurrencyOrders: boundedCount(coverage?.excludedCurrencyOrders),
  };
}

function intervalDto(query: MetricsQuery): MetricsInterval {
  return {
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    currency: query.currency,
    nodeId: query.nodeId,
    ...(query.channel ? { channel: query.channel } : {}),
  };
}

function selectedCurrency(order: ReportOrder, currency: string): boolean {
  return order.acceptedPriceBinding?.priceSnapshot.currency === currency;
}

function orderChannel(order: ReportOrder): Channel {
  return attributionChannel(
    order.automaticOrigin?.quoteSession.attribution ??
      order.individualOrigin?.quote.quoteRequest.attribution ??
      order.customer?.firstAttribution,
  );
}

function attributionChannel(
  value: Prisma.JsonValue | null | undefined,
): Channel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "unknown";
  }
  const channel = value.channel;
  return typeof channel === "string" && CHANNELS.has(channel)
    ? (channel as Channel)
    : "unknown";
}

function matchesChannel(value: Channel, channel: Channel | undefined): boolean {
  return channel === undefined || value === channel;
}

function hasProvenOperationalScope(
  order: ReportOrder,
  nodeId: string,
): boolean {
  const nodeIds = new Set<string>();
  for (const job of order.jobs) nodeIds.add(job.nodeId);
  for (const phase of order.phases) {
    for (const snapshot of phase.eligibilitySnapshots)
      nodeIds.add(snapshot.nodeId);
  }
  return nodeIds.size === 1 && nodeIds.has(nodeId);
}

function commercialReport(
  orders: readonly ReportOrder[],
  events: readonly Readonly<{
    eventType: string;
    quoteSessionId: string | null;
    orderId: string | null;
    payload: Prisma.JsonValue;
  }>[],
  sessionChannels: ReadonlyMap<string, Channel>,
  bound: readonly BindingFact[],
  automaticUses: readonly AutomaticUse[],
  automaticHandoffs: readonly AutomaticHandoff[],
  uploadModelFileIds: ReadonlySet<string>,
  firstOrderIds: ReadonlySet<string>,
  spend: readonly SpendFact[],
  requests: readonly AssistedRequest[],
  generatedAt: Date,
  query: MetricsQuery,
): Record<string, unknown> {
  const acceptedGross = orders.map(acceptedGrossMinor);
  const captured = orders.map((order) => capturedMinor(order, query.currency));
  const refunds = orders.map((order) => refundedMinor(order, query.currency));
  const active = orders.map((order) => activeContract(order, query.currency));
  const finalMargin = orders.map((order) =>
    finalContributionMargin(order, query.currency),
  );
  const firstOrder = orders.filter((order) => firstOrderIds.has(order.id));
  const attributedEvents = events.filter((event) =>
    eventMatchesChannel(event, sessionChannels, query.channel),
  );
  const quoteFacts = quoteMetrics(bound, query.currency, query.channel);
  return {
    scope: "PLATFORM",
    funnel: {
      definition:
        "Distinct confirmed uploads, automatic binding-price quote views, checkout starts, and confirmed orders observed in [from,to); impressions and clicks are not collected.",
      uploads:
        query.channel === undefined
          ? count(events, "upload.confirmed")
          : uploadCountForChannel(
              uploadModelFileIds,
              automaticUses,
              query.channel,
            ),
      automaticBindingPriceQuoteViews: distinctEventSessions(
        attributedEvents,
        "quote.viewed",
      ),
      checkoutStarts: distinctEventSessions(
        attributedEvents,
        "checkout.started",
      ),
      confirmedOrders: orders.length,
      impressions: "not_collected",
      clicks: "not_collected",
    },
    quoteToPaid: quoteFacts,
    orders: {
      definition:
        "Confirmed orders use their immutable accepted price binding; compensated captures without activation are excluded.",
      confirmedOrders: orders.length,
      acceptedGross: money(sum(acceptedGross), query.currency),
      averageOrderValue: ratioMoney(
        sum(acceptedGross),
        orders.length,
        query.currency,
      ),
      acceptedGrossBands: priceBands(acceptedGross),
      origins: countOrigins(orders),
      express: {
        numerator: orders.filter(hasAcceptedExpress).length,
        denominator: orders.length,
        value: ratio(orders.filter(hasAcceptedExpress).length, orders.length)
          .value,
      },
      capturedCash: money(sum(captured), query.currency),
      succeededRefunds: money(sum(refunds), query.currency),
      activeContract: sumsContract(active, query.currency),
    },
    commercialTurnover: {
      scope: "PLATFORM",
      definition:
        "Confirmed order value is counted once by immutable accepted price; captured cash, successful refunds, and net receipts stay separate.",
      confirmedOrderValue: money(sum(acceptedGross), query.currency),
      capturedCash: money(sum(captured), query.currency),
      succeededRefunds: money(sum(refunds), query.currency),
      netReceipts: money(sum(captured) - sum(refunds), query.currency),
    },
    automationShare: automationMetrics(
      automaticUses,
      automaticHandoffs,
      uploadModelFileIds,
      query.channel,
    ),
    handlingAndContributionMargin: {
      definition:
        "Leaf actual costs and completed non-voided handling allocations are retained even for failed or replaced jobs; final margin is null until settlement and coverage are complete.",
      handlingCost: money(
        sum(orders.map((order) => handlingMinor(order, query.currency))),
        query.currency,
      ),
      actualCosts: costBreakdown(orders, query.currency),
      finalContributionMargin: {
        knownOrders: finalMargin.filter(
          (value): value is bigint => value !== null,
        ).length,
        provisionalOrders: finalMargin.filter((value) => value === null).length,
        value: finalMargin.every((value) => value !== null)
          ? money(
              sum(
                finalMargin.filter((value): value is bigint => value !== null),
              ),
              query.currency,
            )
          : null,
        explicitCoverage: {
          completeOrders: orders.filter((order) =>
            hasExplicitMarginCoverage(order, query.currency),
          ).length,
          incompleteOrders: orders.filter(
            (order) => !hasExplicitMarginCoverage(order, query.currency),
          ).length,
        },
      },
    },
    refundsAndAdjustments: {
      definition:
        "Captured cash, selected successful refunds, and current active-contract balances are reported separately so price adjustments and their cash refunds are not double deducted.",
      capturedCash: money(sum(captured), query.currency),
      succeededRefunds: money(sum(refunds), query.currency),
      pendingOrSuspendedRefunds: orders.reduce(
        (total, order) =>
          total +
          paymentsFor(order)
            .flatMap((payment) => payment.refunds)
            .filter((refund) =>
              ["PENDING", "SUSPENDED"].includes(refund.status),
            ).length,
        0,
      ),
      activeContract: sumsContract(active, query.currency),
    },
    acquisitionAndRepeat: acquisitionMetrics(
      orders,
      firstOrder,
      firstOrderIds,
      spend,
      query,
    ),
    assistedSla: assistedSlaMetrics(requests, generatedAt, query.channel),
  };
}

export function operationalReport(
  orders: readonly ReportOrder[],
  jobs: readonly OperationalJob[],
  queue: readonly Readonly<{
    machineId: string;
    startsAt: Date;
    endsAt: Date;
    status: string;
  }>[],
  generatedAt: Date,
  query: MetricsQuery,
): Record<string, unknown> {
  const original = jobs.filter((job) => job.replacesJobId === null);
  const passed = original.filter((job) => job.qcApprovedAt !== null).length;
  const failed = original.filter(
    (job) =>
      job.qcApprovedAt === null &&
      (job.failedAt !== null || job.qcRejectedAt !== null),
  ).length;
  const unresolved = original.filter(
    (job) =>
      job.qcApprovedAt === null &&
      job.failedAt === null &&
      job.qcRejectedAt === null &&
      job.status !== "CANCELLED",
  ).length;
  const cancelled = original.filter(
    (job) =>
      job.status === "CANCELLED" &&
      job.failedAt === null &&
      job.printingAt === null &&
      job.printedAt === null &&
      job.qcApprovedAt === null &&
      job.qcRejectedAt === null,
  ).length;
  const queueByMachine = new Map<string, bigint>();
  for (const reservation of queue) {
    const startsAt = Math.max(
      reservation.startsAt.getTime(),
      generatedAt.getTime(),
    );
    const remaining = Math.max(0, reservation.endsAt.getTime() - startsAt);
    queueByMachine.set(
      reservation.machineId,
      (queueByMachine.get(reservation.machineId) ?? 0n) +
        BigInt(Math.trunc(remaining / 1_000)),
    );
  }
  return {
    scope: "OPERATIONAL_NODE",
    nodeId: query.nodeId,
    firstPassYield: {
      definition:
        "Original jobs only: a replacement does not erase an original terminal failure.",
      firstQcPasses: passed,
      originalTerminalFailures: failed,
      pending: unresolved,
      cancelledBeforeProduction: cancelled,
      value: ratio(passed, passed + failed),
    },
    queue: {
      definition:
        "Machine queue derives from unconsumed planned or active capacity intervals, not measured labour time.",
      machineCount: queueByMachine.size,
      scheduledRemainingSeconds: [...queueByMachine.values()]
        .reduce((total, seconds) => total + seconds, 0n)
        .toString(),
      reservations: queue.length,
    },
    monthlyTurnover: monthlyTurnover(orders, query.currency),
  };
}

type BindingFact = Readonly<{
  kind: "automatic" | "individual";
  channel: Channel;
  accepted: boolean;
  grossMinor: bigint | null;
  preflight: "clean" | "warning" | "unknown";
}>;

type AssistedRequest = Readonly<{
  attribution: Prisma.JsonValue | null;
  createdAt: Date;
  slaDueAt: Date;
  slaRespondedAt: Date | null;
  status: string;
  quote: Readonly<{ issuedAt: Date }> | null;
}>;

type AutomaticUse = Readonly<{
  modelFileId: string;
  draft: Readonly<{
    order: Readonly<{
      confirmedAt: Date | null;
      acceptedOrderPriceBindingId: string | null;
      automaticOrigin: Readonly<{
        quoteSession: Readonly<{ attribution: Prisma.JsonValue | null }>;
      }> | null;
    }>;
  }>;
}>;

type AutomaticHandoff = Readonly<{
  modelFileIds: readonly string[];
  sourceQuoteSession: Readonly<{ attribution: Prisma.JsonValue | null }>;
}>;

export function automationMetrics(
  uses: readonly AutomaticUse[],
  handoffs: readonly AutomaticHandoff[],
  uploadModelFileIds: ReadonlySet<string>,
  channel: Channel | undefined,
): Record<string, unknown> {
  const eligibleUses = uses.filter((use) =>
    matchesChannel(
      attributionChannel(
        use.draft.order.automaticOrigin?.quoteSession.attribution,
      ),
      channel,
    ),
  );
  const successfulFiles = new Set(
    eligibleUses
      .filter(
        (use) =>
          use.draft.order.confirmedAt !== null &&
          use.draft.order.acceptedOrderPriceBindingId !== null,
      )
      .map((use) => use.modelFileId),
  );
  const handoffFiles = new Set(
    handoffs
      .filter((handoff) =>
        matchesChannel(
          attributionChannel(handoff.sourceQuoteSession.attribution),
          channel,
        ),
      )
      .flatMap((handoff) => handoff.modelFileIds)
      .filter((modelFileId) => uploadModelFileIds.has(modelFileId)),
  );
  const usedFiles = new Set(eligibleUses.map((use) => use.modelFileId));
  const observedFiles = new Set(
    [...uploadModelFileIds].filter((modelFileId) =>
      channel === undefined
        ? true
        : usedFiles.has(modelFileId) || handoffFiles.has(modelFileId),
    ),
  );
  return {
    scope: "PLATFORM",
    definition:
      "Confirmed model files are counted once across body/item splits. Successful automatic use requires a completed accepted automatic binding; persisted assisted handoffs, unresolved, and evidence-unavailable states remain separate.",
    successfulAutomaticUses: successfulFiles.size,
    confirmedModelFiles: observedFiles.size,
    value: ratio(successfulFiles.size, observedFiles.size),
    unresolvedOrPending: [...usedFiles].filter(
      (modelFileId) =>
        !successfulFiles.has(modelFileId) && !handoffFiles.has(modelFileId),
    ).length,
    blockedOrHandoff: [...handoffFiles].filter(
      (modelFileId) => !successfulFiles.has(modelFileId),
    ).length,
    evidenceUnavailable: [...observedFiles].filter(
      (modelFileId) =>
        !usedFiles.has(modelFileId) && !handoffFiles.has(modelFileId),
    ).length,
  };
}

function uploadCountForChannel(
  uploadModelFileIds: ReadonlySet<string>,
  uses: readonly AutomaticUse[],
  channel: Channel,
): number {
  return new Set(
    uses
      .filter((use) =>
        matchesChannel(
          attributionChannel(
            use.draft.order.automaticOrigin?.quoteSession.attribution,
          ),
          channel,
        ),
      )
      .map((use) => use.modelFileId)
      .filter((modelFileId) => uploadModelFileIds.has(modelFileId)),
  ).size;
}

function eventMatchesChannel(
  event: Readonly<{ eventType: string; quoteSessionId: string | null }>,
  sessionChannels: ReadonlyMap<string, Channel>,
  channel: Channel | undefined,
): boolean {
  if (event.eventType === "upload.confirmed") return channel === undefined;
  return matchesChannel(
    event.quoteSessionId === null
      ? "unknown"
      : (sessionChannels.get(event.quoteSessionId) ?? "unknown"),
    channel,
  );
}

export function assistedSlaMetrics(
  requests: readonly AssistedRequest[],
  generatedAt: Date,
  channel: Channel | undefined,
): Record<string, unknown> {
  const assisted = requests.filter((request) =>
    matchesChannel(attributionChannel(request.attribution), channel),
  );
  const responded = assisted.filter((request) => responseAt(request) !== null);
  const respondedOnTime = responded.filter(
    (request) => responseAt(request)! <= request.slaDueAt,
  );
  const respondedLate = responded.filter(
    (request) => responseAt(request)! > request.slaDueAt,
  );
  const pendingOverdue = assisted.filter(
    (request) => responseAt(request) === null && request.slaDueAt < generatedAt,
  );
  return {
    scope: "PLATFORM",
    definition:
      "Assisted SLA uses persisted request creation, due, and first issued-offer evidence against the database clock.",
    requests: assisted.length,
    responded: responded.length,
    respondedOnTime: respondedOnTime.length,
    respondedLate: respondedLate.length,
    pendingOverdue: pendingOverdue.length,
    responseRate: ratio(respondedOnTime.length, assisted.length),
  };
}

function responseAt(request: AssistedRequest): Date | null {
  const timestamps = [request.slaRespondedAt, request.quote?.issuedAt].filter(
    (value): value is Date => value !== null && value !== undefined,
  );
  if (timestamps.length === 0) return null;
  return timestamps.reduce((earliest, candidate) =>
    candidate.getTime() < earliest.getTime() ? candidate : earliest,
  );
}

async function bindingFacts(
  transaction: Transaction,
  events: readonly Readonly<{
    eventType: string;
    orderId: string | null;
    quoteSessionId: string | null;
    payload: Prisma.JsonValue;
  }>[],
  sessionChannels: ReadonlyMap<string, Channel>,
  currency: string,
): Promise<readonly BindingFact[]> {
  const bound = events.filter((event) => event.eventType === "quote.bound");
  const orderBindingIds = bound
    .filter((event) => event.orderId !== null)
    .map((event) => jsonString(event.payload, "bindingId"))
    .filter((id): id is string => id !== undefined);
  const quoteIds = bound
    .filter((event) => event.orderId === null)
    .map((event) => jsonString(event.payload, "quoteId"))
    .filter((id): id is string => id !== undefined);
  const orderBindings = await transaction.orderPriceBinding.findMany({
    where: { id: { in: orderBindingIds } },
    include: {
      priceSnapshot: true,
      checkoutAcceptanceOrder: { select: { confirmedAt: true } },
    },
  });
  const riskDecisions =
    await transaction.automaticQuoteRiskDecisionRecord.findMany({
      where: {
        orderId: { in: orderBindings.map((binding) => binding.orderId) },
      },
      select: {
        orderId: true,
        preflightFinding: { select: { severity: true } },
      },
    });
  const quotes = await transaction.quote.findMany({
    where: { id: { in: quoteIds } },
    include: {
      priceBinding: { include: { priceSnapshot: true } },
      quoteRequest: { select: { attribution: true } },
      individualOrderOrigin: {
        include: { order: { select: { confirmedAt: true } } },
      },
    },
  });
  const orderMap = new Map(
    orderBindings.map((binding) => [binding.id, binding]),
  );
  const riskByOrder = new Map<string, readonly string[]>();
  for (const risk of riskDecisions) {
    riskByOrder.set(risk.orderId, [
      ...(riskByOrder.get(risk.orderId) ?? []),
      risk.preflightFinding.severity,
    ]);
  }
  const quoteMap = new Map(quotes.map((quote) => [quote.id, quote]));
  return bound.map((event): BindingFact => {
    if (event.orderId) {
      const binding = orderMap.get(
        jsonString(event.payload, "bindingId") ?? "",
      );
      return {
        kind: "automatic",
        channel:
          event.quoteSessionId === null
            ? "unknown"
            : (sessionChannels.get(event.quoteSessionId) ?? "unknown"),
        accepted: Boolean(binding?.checkoutAcceptanceOrder?.confirmedAt),
        grossMinor:
          binding?.priceSnapshot.currency === currency
            ? binding.priceSnapshot.contractTotalMinor
            : null,
        preflight: automaticPreflight(riskByOrder.get(binding?.orderId ?? "")),
      };
    }
    const quote = quoteMap.get(jsonString(event.payload, "quoteId") ?? "");
    return {
      kind: "individual",
      channel: attributionChannel(quote?.quoteRequest.attribution),
      accepted: Boolean(quote?.individualOrderOrigin?.order.confirmedAt),
      grossMinor:
        quote?.priceBinding?.priceSnapshot.currency === currency
          ? quote.priceBinding.priceSnapshot.contractTotalMinor
          : null,
      preflight: "unknown",
    };
  });
}

function automaticPreflight(
  severities: readonly string[] | undefined,
): BindingFact["preflight"] {
  if (severities === undefined) return "clean";
  return severities.some((severity) => severity === "BLOCKING")
    ? "unknown"
    : "warning";
}

export function quoteMetrics(
  bound: readonly BindingFact[],
  currency: string,
  channel: Channel | undefined,
): Record<string, unknown> {
  const scoped = bound.filter((binding) =>
    matchesChannel(binding.channel, channel),
  );
  const automatic = scoped.filter((binding) => binding.kind === "automatic");
  const individual = scoped.filter((binding) => binding.kind === "individual");
  const accepted = scoped.filter((binding) => binding.accepted);
  return {
    definition:
      "Immutable binding offers issued in [from,to) form the cohort. Expired offers remain in the denominator; deposits do not create another order.",
    offersIssued: scoped.length,
    acceptedBindings: accepted.length,
    conversion: ratio(accepted.length, scoped.length),
    automatic: bindingBreakdown(automatic, currency),
    individual: bindingBreakdown(individual, currency),
    acceptedGrossBands: priceBands(
      accepted
        .map((binding) => binding.grossMinor)
        .filter((value): value is bigint => value !== null),
    ),
  };
}

function bindingBreakdown(
  bindings: readonly BindingFact[],
  currency: string,
): Record<string, unknown> {
  return {
    offersIssued: bindings.length,
    acceptedBindings: bindings.filter((binding) => binding.accepted).length,
    conversion: ratio(
      bindings.filter((binding) => binding.accepted).length,
      bindings.length,
    ),
    acceptedGross: money(
      sum(
        bindings
          .filter((binding) => binding.accepted)
          .map((binding) => binding.grossMinor)
          .filter((value): value is bigint => value !== null),
      ),
      currency,
    ),
    preflight: {
      clean: bindings.filter((binding) => binding.preflight === "clean").length,
      warning: bindings.filter((binding) => binding.preflight === "warning")
        .length,
      unknown: bindings.filter((binding) => binding.preflight === "unknown")
        .length,
    },
    preflightCohorts: {
      clean: preflightCohort(bindings, "clean", currency),
      warning: preflightCohort(bindings, "warning", currency),
      unknown: preflightCohort(bindings, "unknown", currency),
    },
  };
}

function preflightCohort(
  bindings: readonly BindingFact[],
  preflight: BindingFact["preflight"],
  currency: string,
): Record<string, unknown> {
  const cohort = bindings.filter((binding) => binding.preflight === preflight);
  const accepted = cohort.filter((binding) => binding.accepted);
  return {
    offersIssued: cohort.length,
    acceptedBindings: accepted.length,
    conversion: ratio(accepted.length, cohort.length),
    acceptedGross: money(
      sum(
        accepted
          .map((binding) => binding.grossMinor)
          .filter((value): value is bigint => value !== null),
      ),
      currency,
    ),
  };
}

type SpendFact = Readonly<{
  channel: string;
  periodStart: Date;
  periodEnd: Date;
  amountMinor: bigint;
  currency: string;
  successor: Readonly<{ id: string }> | null;
}>;

export function acquisitionMetrics(
  orders: readonly ReportOrder[],
  firstOrder: readonly ReportOrder[],
  firstOrderIds: ReadonlySet<string>,
  spend: readonly SpendFact[],
  query: MetricsQuery,
): Record<string, unknown> {
  const scoped = spend.filter(
    (item) =>
      item.successor === null &&
      item.currency === query.currency &&
      matchesChannel(item.channel.toLowerCase() as Channel, query.channel),
  );
  const whole = scoped.filter(
    (item) => item.periodStart >= query.from && item.periodEnd <= query.to,
  );
  const partial = scoped.filter(
    (item) => item.periodStart < query.from || item.periodEnd > query.to,
  );
  const firstByCustomer = new Set(
    firstOrder
      .map((order) => order.customerId)
      .filter((id): id is string => id !== null),
  );
  const repeat = orders.filter(
    (order) => order.customerId && !firstOrderIds.has(order.id),
  );
  return {
    definition:
      "Acquisition spend is included only when wholly within the interval; repeat status uses a customer’s earlier confirmed order ordered by (confirmedAt,id).",
    acquisitionSpend: money(
      sum(whole.map((item) => item.amountMinor)),
      query.currency,
    ),
    partialPeriodSpendExcluded: partial.length,
    cac: ratioMoney(
      sum(whole.map((item) => item.amountMinor)),
      firstByCustomer.size,
      query.currency,
    ),
    firstOrderCustomers: firstByCustomer.size,
    unknownCustomerOrAttribution: orders.filter(
      (order) => !order.customerId || orderChannel(order) === "unknown",
    ).length,
    repeatOrders: repeat.length,
    repeatRate: ratio(repeat.length, orders.length),
  };
}

function sourceCoverage(
  orders: readonly ReportOrder[],
  currency: string,
): Record<string, unknown> {
  const selected = orders.filter((order) => selectedCurrency(order, currency));
  return {
    businessEvents: {
      retainedClientObservations: true,
      historicalBackfill: "not_performed",
    },
    directRelationalFacts: true,
    selectedCurrencyOrders: selected.length,
    excludedCurrencyOrders: orders.length - selected.length,
  };
}

function boundedCount(value: bigint | undefined): number {
  if (value === undefined || value < 0n) return 0;
  return Number(
    value > BigInt(Number.MAX_SAFE_INTEGER)
      ? BigInt(Number.MAX_SAFE_INTEGER)
      : value,
  );
}

export function completenessFor(
  coverage: Record<string, unknown>,
  channel: Channel | undefined,
  spend: readonly SpendFact[] = [],
  query?: MetricsQuery,
): MetricsCompleteness {
  const flags = ["event_history_not_backfilled"];
  const currency = coverage.excludedCurrencyOrders;
  if (typeof currency === "number" && currency > 0)
    flags.push("mixed_currency_excluded");
  if (channel) flags.push("channel_attribution_unknown_excluded");
  if (
    query &&
    spend.some(
      (item) =>
        item.successor === null &&
        item.currency === query.currency &&
        matchesChannel(item.channel.toLowerCase() as Channel, query.channel) &&
        (item.periodStart < query.from || item.periodEnd > query.to),
    )
  ) {
    flags.push("partial_period_acquisition_spend_excluded");
  }
  return {
    status: flags.length === 1 ? "unknown" : "warning",
    flags,
  };
}

function count(
  events: readonly Readonly<{ eventType: string }>[],
  eventType: string,
): number {
  return events.filter((event) => event.eventType === eventType).length;
}

function distinctEventSessions(
  events: readonly Readonly<{
    eventType: string;
    quoteSessionId: string | null;
  }>[],
  eventType: string,
): number {
  return new Set(
    events
      .filter((event) => event.eventType === eventType)
      .map((event) => event.quoteSessionId)
      .filter((id): id is string => id !== null),
  ).size;
}

function acceptedGrossMinor(order: ReportOrder): bigint {
  return order.acceptedPriceBinding?.priceSnapshot.contractTotalMinor ?? 0n;
}

function hasAcceptedExpress(order: ReportOrder): boolean {
  return Boolean(
    order.acceptedPriceBinding?.priceSnapshot.components.some(
      (component) => component.kind === "EXPRESS",
    ),
  );
}

function paymentsFor(
  order: ReportOrder,
): readonly ReportOrder["priceBindings"][number]["payments"][number][] {
  return order.priceBindings.flatMap((binding) => binding.payments);
}

function capturedMinor(order: ReportOrder, currency: string): bigint {
  return sum(
    paymentsFor(order)
      .filter(
        (payment) =>
          payment.currency === currency &&
          payment.capturedAmountMinor !== null &&
          [
            "CAPTURED",
            "REFUND_PENDING",
            "PARTIALLY_REFUNDED",
            "REFUNDED",
          ].includes(payment.status),
      )
      .map((payment) => payment.capturedAmountMinor ?? 0n),
  );
}

function refundedMinor(order: ReportOrder, currency: string): bigint {
  return sum(
    paymentsFor(order)
      .filter((payment) => payment.currency === currency)
      .flatMap((payment) => payment.refunds)
      .filter((refund) => refund.status === "SUCCEEDED")
      .map((refund) => refund.amountMinor),
  );
}

function activeContract(
  order: ReportOrder,
  currency: string,
): {
  gross: bigint;
  net: bigint;
  vat: bigint;
} {
  const contract = order.activeContractPrice?.contractPriceRevision;
  if (!contract || contract.currency !== currency)
    return { gross: 0n, net: 0n, vat: 0n };
  return {
    gross: contract.contractTotalMinor,
    net: contract.netAmountMinor,
    vat: contract.vatAmountMinor,
  };
}

function sumsContract(
  contracts: readonly Readonly<{ gross: bigint; net: bigint; vat: bigint }>[],
  currency: string,
): Record<string, MetricMoney> {
  return {
    gross: money(sum(contracts.map((contract) => contract.gross)), currency),
    net: money(sum(contracts.map((contract) => contract.net)), currency),
    vat: money(sum(contracts.map((contract) => contract.vat)), currency),
  };
}

function handlingMinor(order: ReportOrder, currency: string): bigint {
  return sum(
    order.handlingAllocations
      .filter(
        (allocation) =>
          allocation.currency === currency &&
          allocation.session.lifecycle === "COMPLETED" &&
          allocation.session.voidedAt === null,
      )
      .map((allocation) => allocation.allocatedCostMinor),
  );
}

function costBreakdown(
  orders: readonly ReportOrder[],
  currency: string,
): Record<string, MetricMoney> {
  const categories = [
    "MATERIAL",
    "VARIABLE_MACHINE",
    "CARRIER",
    "PACKAGING",
    "PAYMENT_FEE",
  ];
  return Object.fromEntries(
    categories.map((category) => [
      category.toLowerCase(),
      money(
        sum(
          orders.flatMap((order) =>
            order.actualCosts
              .filter(
                (cost) =>
                  cost.successor === null &&
                  cost.currency === currency &&
                  cost.category === category,
              )
              .map((cost) => cost.amountMinor),
          ),
        ),
        currency,
      ),
    ]),
  );
}

export function finalContributionMargin(
  order: ReportOrder,
  currency: string,
): bigint | null {
  const unresolvedRefund = paymentsFor(order)
    .flatMap((payment) => payment.refunds)
    .some((refund) => ["PENDING", "SUSPENDED"].includes(refund.status));
  const terminal = isFinalMarginTerminal(order.status);
  const revenue = finalMarginRevenue(order, currency);
  if (
    !terminal ||
    unresolvedRefund ||
    revenue === null ||
    !hasExplicitMarginCoverage(order, currency)
  ) {
    return null;
  }
  const costs = sum(
    order.actualCosts
      .filter((cost) => cost.successor === null && cost.currency === currency)
      .map((cost) => cost.amountMinor),
  );
  return revenue - costs - handlingMinor(order, currency);
}

function finalMarginRevenue(
  order: ReportOrder,
  currency: string,
): bigint | null {
  const netCash =
    capturedMinor(order, currency) - refundedMinor(order, currency);
  if (order.status === "REFUNDED") {
    return netCash === 0n ? 0n : null;
  }
  const contract = order.activeContractPrice?.contractPriceRevision;
  if (!contract || contract.currency !== currency) return null;
  if (order.status === "CANCELLED_SETTLED") {
    const settlement = order.settlements.find(
      (candidate) =>
        candidate.kind === "BALANCE_SETTLEMENT" &&
        candidate.currency === currency,
    );
    if (
      !settlement ||
      settlement.contractTotalMinor !== contract.contractTotalMinor ||
      settlement.capturedTotalMinor - settlement.refundAmountMinor !==
        settlement.retainedAmountMinor ||
      netCash !== settlement.retainedAmountMinor
    ) {
      return null;
    }
    if (
      (contract.taxRegime === "NON_VAT_PAYER" &&
        contract.vatRateBasisPoints !== 0) ||
      (contract.taxRegime === "VAT_PAYER" && contract.vatRateBasisPoints === 0)
    ) {
      return null;
    }
    return netFromGross(
      settlement.retainedAmountMinor,
      contract.vatRateBasisPoints,
    );
  }
  return netCash === contract.contractTotalMinor
    ? contract.netAmountMinor
    : null;
}

function netFromGross(grossMinor: bigint, vatRateBasisPoints: number): bigint {
  const denominator = 10_000n + BigInt(vatRateBasisPoints);
  const vatMinor =
    (grossMinor * BigInt(vatRateBasisPoints) + denominator / 2n) / denominator;
  return grossMinor - vatMinor;
}

export function isFinalMarginTerminal(status: string): boolean {
  return [
    "COMPLETED",
    "PARTIALLY_FULFILLED",
    "REFUNDED",
    "CANCELLED_SETTLED",
  ].includes(status);
}

function hasExplicitMarginCoverage(
  order: ReportOrder,
  currency: string,
): boolean {
  const requiredCostCategories = new Set([
    "MATERIAL",
    "VARIABLE_MACHINE",
    "CARRIER",
    "PACKAGING",
    "PAYMENT_FEE",
  ]);
  for (const cost of order.actualCosts) {
    if (cost.successor === null && cost.currency === currency) {
      requiredCostCategories.delete(cost.category);
    }
  }
  const completedAllocations = order.handlingAllocations.filter(
    (allocation) =>
      allocation.currency === currency &&
      allocation.session.lifecycle === "COMPLETED" &&
      allocation.session.voidedAt === null,
  );
  return requiredCostCategories.size === 0 && completedAllocations.length > 0;
}

function countOrigins(orders: readonly ReportOrder[]): Record<string, number> {
  return {
    automatic: orders.filter((order) => order.automaticOrigin !== null).length,
    individual: orders.filter((order) => order.individualOrigin !== null)
      .length,
    unknown: orders.filter(
      (order) =>
        order.automaticOrigin === null && order.individualOrigin === null,
    ).length,
  };
}

function priceBands(values: readonly bigint[]): Record<PriceBand, number> {
  const bands: Record<PriceBand, number> = {
    under_25000: 0,
    "25000_to_49999": 0,
    "50000_to_99999": 0,
    "100000_to_199999": 0,
    "200000_or_more": 0,
  };
  for (const value of values) {
    if (value < 25_000n) bands.under_25000 += 1;
    else if (value < 50_000n) bands["25000_to_49999"] += 1;
    else if (value < 100_000n) bands["50000_to_99999"] += 1;
    else if (value < 200_000n) bands["100000_to_199999"] += 1;
    else bands["200000_or_more"] += 1;
  }
  return bands;
}

function monthlyTurnover(
  orders: readonly ReportOrder[],
  currency: string,
): readonly Record<string, unknown>[] {
  const groups = new Map<
    string,
    { gross: bigint; captured: bigint; refunds: bigint }
  >();
  for (const order of orders) {
    const confirmedAt = requiredConfirmedAt(order);
    const month = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Prague",
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(confirmedAt)
      .reduce<Record<string, string>>((result, part) => {
        if (part.type !== "literal") result[part.type] = part.value;
        return result;
      }, {});
    const key = `${month.year}-${month.month}`;
    const current = groups.get(key) ?? { gross: 0n, captured: 0n, refunds: 0n };
    current.gross += acceptedGrossMinor(order);
    current.captured += capturedMinor(order, currency);
    current.refunds += refundedMinor(order, currency);
    groups.set(key, current);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, value]) => ({
      month,
      confirmedOrderValue: money(value.gross, currency),
      capturedCash: money(value.captured, currency),
      succeededRefunds: money(value.refunds, currency),
      netReceipts: money(value.captured - value.refunds, currency),
    }));
}

function orderDetail(
  order: ReportOrder,
  currency: string,
): Record<string, unknown> {
  const active = activeContract(order, currency);
  const captured = capturedMinor(order, currency);
  const refunded = refundedMinor(order, currency);
  const margin = finalContributionMargin(order, currency);
  return {
    id: order.id,
    publicReference: order.publicReference,
    confirmedAt: requiredConfirmedAt(order).toISOString(),
    status: order.status,
    origin:
      order.automaticOrigin !== null
        ? "automatic"
        : order.individualOrigin !== null
          ? "individual"
          : "unknown",
    acceptedGross: money(acceptedGrossMinor(order), currency),
    activeContract: sumsContract([active], currency),
    capturedCash: money(captured, currency),
    succeededRefunds: money(refunded, currency),
    outstandingGross: money(outstandingGross(order, currency), currency),
    handlingCost: money(handlingMinor(order, currency), currency),
    actualCosts: costBreakdown([order], currency),
    explicitMarginCoverage: hasExplicitMarginCoverage(order, currency),
    finalContributionMargin: margin === null ? null : money(margin, currency),
  };
}

export function outstandingGross(order: ReportOrder, currency: string): bigint {
  if (["REFUNDED", "CANCELLED"].includes(order.status)) return 0n;
  if (order.status === "CANCELLED_SETTLED") {
    return (
      order.settlements.find(
        (settlement) =>
          settlement.kind === "BALANCE_SETTLEMENT" &&
          settlement.currency === currency,
      )?.amountDueMinor ?? 0n
    );
  }
  const active = activeContract(order, currency);
  return (
    active.gross -
    capturedMinor(order, currency) +
    refundedMinor(order, currency)
  );
}

function money(amountMinor: bigint, currency: string): MetricMoney {
  return { amountMinor: amountMinor.toString(), currency };
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function ratio(numerator: number, denominator: number): MetricRatio {
  return {
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
  };
}

function ratioMoney(
  total: bigint,
  denominator: number,
  currency: string,
): Record<string, unknown> {
  return {
    numerator: money(total, currency),
    denominator,
    value:
      denominator === 0 ? null : money(total / BigInt(denominator), currency),
  };
}

function jsonString(
  value: Prisma.JsonValue,
  field: string,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value[field];
  return typeof candidate === "string" ? candidate : undefined;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseCursor(value: string, filterHash: string): Cursor {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 3
    ) {
      throw new Error("invalid");
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.confirmedAt !== "string" ||
      typeof candidate.id !== "string" ||
      typeof candidate.filterHash !== "string" ||
      !UUID_PATTERN.test(candidate.id) ||
      !INSTANT_PATTERN.test(candidate.confirmedAt) ||
      candidate.filterHash !== filterHash
    ) {
      throw new Error("invalid");
    }
    return {
      confirmedAt: candidate.confirmedAt,
      id: candidate.id,
      filterHash: candidate.filterHash,
    };
  } catch {
    throw new BadRequestException("metrics orders cursor is invalid");
  }
}

function requiredConfirmedAt(order: ReportOrder): Date {
  if (!order.confirmedAt)
    throw new Error("Metric order is missing confirmedAt");
  return order.confirmedAt;
}
