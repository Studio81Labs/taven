import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

const CHANNELS = ["direct", "organic", "paid", "referral", "unknown"];

// These internal structural types keep report calculations framework-neutral.
// The concrete DTO classes below remain the OpenAPI contract.
export type MetricMoney = Readonly<{
  amountMinor: string;
  currency: string;
}>;

export type MetricRatio = Readonly<{
  numerator: number;
  denominator: number;
  value: number | null;
}>;

export type MetricsInterval = Readonly<{
  from: string;
  to: string;
  currency: string;
  channel?: (typeof CHANNELS)[number];
  nodeId: string;
}>;

export type MetricsCompleteness = Readonly<{
  status: "complete" | "warning" | "unknown";
  flags: string[];
}>;

export class MetricMoneyDto {
  @ApiProperty({
    type: String,
    example: "12500",
    description: "Signed decimal minor units.",
  })
  amountMinor!: string;

  @ApiProperty({ enum: ["CZK"] })
  currency!: "CZK";
}

export class MetricRatioDto {
  @ApiProperty({ type: Number, minimum: 0 })
  numerator!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  denominator!: number;

  @ApiProperty({ nullable: true, type: Number })
  value!: number | null;
}

export class MetricMoneyRatioDto {
  @ApiProperty({ type: MetricMoneyDto })
  numerator!: MetricMoneyDto;

  @ApiProperty({ type: Number, minimum: 0 })
  denominator!: number;

  @ApiProperty({ type: MetricMoneyDto, nullable: true })
  value!: MetricMoneyDto | null;
}

export class MetricsIntervalDto {
  @ApiProperty({ type: String, format: "date-time" })
  from!: string;

  @ApiProperty({ type: String, format: "date-time" })
  to!: string;

  @ApiProperty({ enum: ["CZK"] })
  currency!: "CZK";

  @ApiPropertyOptional({ enum: CHANNELS })
  channel?: (typeof CHANNELS)[number];

  @ApiProperty({ type: String, format: "uuid" })
  nodeId!: string;
}

export class BusinessEventCoverageDto {
  @ApiProperty({ type: Boolean })
  retainedClientObservations!: boolean;

  @ApiProperty({ enum: ["not_performed"] })
  historicalBackfill!: "not_performed";
}

export class MetricsSourceCoverageDto {
  @ApiProperty({ type: BusinessEventCoverageDto })
  businessEvents!: BusinessEventCoverageDto;

  @ApiProperty({ type: Boolean })
  directRelationalFacts!: boolean;

  @ApiProperty({ type: Number, minimum: 0 })
  selectedCurrencyOrders!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  excludedCurrencyOrders!: number;
}

export class MetricsCompletenessDto {
  @ApiProperty({ enum: ["complete", "warning", "unknown"] })
  status!: "complete" | "warning" | "unknown";

  @ApiProperty({ type: [String] })
  flags!: string[];
}

export class PriceBandsDto {
  @ApiProperty({ type: Number, minimum: 0 })
  under_25000!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  "25000_to_49999"!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  "50000_to_99999"!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  "100000_to_199999"!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  "200000_or_more"!: number;
}

export class FunnelMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  uploads!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  automaticBindingPriceQuoteViews!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  checkoutStarts!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  confirmedOrders!: number;

  @ApiProperty({ enum: ["not_collected"] })
  impressions!: "not_collected";

  @ApiProperty({ enum: ["not_collected"] })
  clicks!: "not_collected";
}

export class PreflightCoverageDto {
  @ApiProperty({ type: Number, minimum: 0 })
  clean!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  warning!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  unknown!: number;
}

export class BindingBreakdownDto {
  @ApiProperty({ type: Number, minimum: 0 })
  offersIssued!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  acceptedBindings!: number;

  @ApiProperty({ type: MetricRatioDto })
  conversion!: MetricRatioDto;

  @ApiProperty({ type: MetricMoneyDto })
  acceptedGross!: MetricMoneyDto;

  @ApiProperty({ type: PreflightCoverageDto })
  preflight!: PreflightCoverageDto;
}

export class QuoteToPaidMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  offersIssued!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  acceptedBindings!: number;

  @ApiProperty({ type: MetricRatioDto })
  conversion!: MetricRatioDto;

  @ApiProperty({ type: BindingBreakdownDto })
  automatic!: BindingBreakdownDto;

  @ApiProperty({ type: BindingBreakdownDto })
  individual!: BindingBreakdownDto;

  @ApiProperty({ type: PriceBandsDto })
  acceptedGrossBands!: PriceBandsDto;
}

export class OriginCountsDto {
  @ApiProperty({ type: Number, minimum: 0 })
  automatic!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  individual!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  unknown!: number;
}

export class ContractAmountsDto {
  @ApiProperty({ type: MetricMoneyDto })
  gross!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  net!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  vat!: MetricMoneyDto;
}

export class ExpressShareDto extends MetricRatioDto {}

export class OrderMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  confirmedOrders!: number;

  @ApiProperty({ type: MetricMoneyDto })
  acceptedGross!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyRatioDto })
  averageOrderValue!: MetricMoneyRatioDto;

  @ApiProperty({ type: PriceBandsDto })
  acceptedGrossBands!: PriceBandsDto;

  @ApiProperty({ type: OriginCountsDto })
  origins!: OriginCountsDto;

  @ApiProperty({ type: ExpressShareDto })
  express!: ExpressShareDto;

  @ApiProperty({ type: MetricMoneyDto })
  capturedCash!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  succeededRefunds!: MetricMoneyDto;

  @ApiProperty({ type: ContractAmountsDto })
  activeContract!: ContractAmountsDto;
}

export class TurnoverMetricsDto {
  @ApiProperty({ enum: ["PLATFORM"], required: false })
  scope?: "PLATFORM";

  @ApiPropertyOptional({ type: String })
  definition?: string;

  @ApiProperty({ type: MetricMoneyDto })
  confirmedOrderValue!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  capturedCash!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  succeededRefunds!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  netReceipts!: MetricMoneyDto;
}

export class AutomationMetricsDto {
  @ApiProperty({ enum: ["PLATFORM"] })
  scope!: "PLATFORM";

  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  successfulAutomaticUses!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  confirmedModelFiles!: number;

  @ApiProperty({ type: MetricRatioDto })
  value!: MetricRatioDto;

  @ApiProperty({ type: Number, minimum: 0 })
  unresolvedOrPending!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  blockedOrHandoff!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  evidenceUnavailable!: number;
}

export class ActualCostBreakdownDto {
  @ApiProperty({ type: MetricMoneyDto })
  material!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  variable_machine!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  carrier!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  packaging!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  payment_fee!: MetricMoneyDto;
}

export class MarginCoverageDto {
  @ApiProperty({ type: Number, minimum: 0 })
  completeOrders!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  incompleteOrders!: number;
}

export class ContributionMarginMetricsDto {
  @ApiProperty({ type: Number, minimum: 0 })
  knownOrders!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  provisionalOrders!: number;

  @ApiProperty({ type: MetricMoneyDto, nullable: true })
  value!: MetricMoneyDto | null;

  @ApiProperty({ type: MarginCoverageDto })
  explicitCoverage!: MarginCoverageDto;
}

export class HandlingAndMarginMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: MetricMoneyDto })
  handlingCost!: MetricMoneyDto;

  @ApiProperty({ type: ActualCostBreakdownDto })
  actualCosts!: ActualCostBreakdownDto;

  @ApiProperty({ type: ContributionMarginMetricsDto })
  finalContributionMargin!: ContributionMarginMetricsDto;
}

export class RefundMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: MetricMoneyDto })
  capturedCash!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  succeededRefunds!: MetricMoneyDto;

  @ApiProperty({ type: Number, minimum: 0 })
  pendingOrSuspendedRefunds!: number;

  @ApiProperty({ type: ContractAmountsDto })
  activeContract!: ContractAmountsDto;
}

export class AcquisitionMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: MetricMoneyDto })
  acquisitionSpend!: MetricMoneyDto;

  @ApiProperty({ type: Number, minimum: 0 })
  partialPeriodSpendExcluded!: number;

  @ApiProperty({ type: MetricMoneyRatioDto })
  cac!: MetricMoneyRatioDto;

  @ApiProperty({ type: Number, minimum: 0 })
  firstOrderCustomers!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  unknownCustomerOrAttribution!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  repeatOrders!: number;

  @ApiProperty({ type: MetricRatioDto })
  repeatRate!: MetricRatioDto;
}

export class AssistedSlaMetricsDto {
  @ApiProperty({ enum: ["PLATFORM"] })
  scope!: "PLATFORM";

  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  requests!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  responded!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  pendingOverdue!: number;

  @ApiProperty({ type: MetricRatioDto })
  responseRate!: MetricRatioDto;
}

export class CommercialMetricsDto {
  @ApiProperty({ enum: ["PLATFORM"] })
  scope!: "PLATFORM";

  @ApiProperty({ type: FunnelMetricsDto })
  funnel!: FunnelMetricsDto;

  @ApiProperty({ type: QuoteToPaidMetricsDto })
  quoteToPaid!: QuoteToPaidMetricsDto;

  @ApiProperty({ type: OrderMetricsDto })
  orders!: OrderMetricsDto;

  @ApiProperty({ type: TurnoverMetricsDto })
  commercialTurnover!: TurnoverMetricsDto;

  @ApiProperty({ type: AutomationMetricsDto })
  automationShare!: AutomationMetricsDto;

  @ApiProperty({ type: HandlingAndMarginMetricsDto })
  handlingAndContributionMargin!: HandlingAndMarginMetricsDto;

  @ApiProperty({ type: RefundMetricsDto })
  refundsAndAdjustments!: RefundMetricsDto;

  @ApiProperty({ type: AcquisitionMetricsDto })
  acquisitionAndRepeat!: AcquisitionMetricsDto;

  @ApiProperty({ type: AssistedSlaMetricsDto })
  assistedSla!: AssistedSlaMetricsDto;
}

export class FirstPassYieldMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  firstQcPasses!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  originalTerminalFailures!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  pending!: number;

  @ApiProperty({ type: Number, minimum: 0 })
  cancelledBeforeProduction!: number;

  @ApiProperty({ type: MetricRatioDto })
  value!: MetricRatioDto;
}

export class QueueMetricsDto {
  @ApiProperty({ type: String })
  definition!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  machineCount!: number;

  @ApiProperty({ type: String, description: "Signed decimal seconds." })
  scheduledRemainingSeconds!: string;

  @ApiProperty({ type: Number, minimum: 0 })
  reservations!: number;
}

export class MonthlyTurnoverMetricsDto extends TurnoverMetricsDto {
  @ApiProperty({ type: String, pattern: "^\\d{4}-\\d{2}$" })
  month!: string;
}

export class OperationalMetricsDto {
  @ApiProperty({ enum: ["OPERATIONAL_NODE"] })
  scope!: "OPERATIONAL_NODE";

  @ApiProperty({ type: String, format: "uuid" })
  nodeId!: string;

  @ApiProperty({ type: FirstPassYieldMetricsDto })
  firstPassYield!: FirstPassYieldMetricsDto;

  @ApiProperty({ type: QueueMetricsDto })
  queue!: QueueMetricsDto;

  @ApiProperty({ type: [MonthlyTurnoverMetricsDto] })
  monthlyTurnover!: MonthlyTurnoverMetricsDto[];
}

export class MetricsReportDto {
  @ApiProperty({ type: String, enum: ["v0-1"] })
  metricDefinition!: "v0-1";

  @ApiProperty({ type: String, format: "date-time" })
  generatedAt!: string;

  @ApiProperty({ type: MetricsIntervalDto })
  interval!: MetricsIntervalDto;

  @ApiProperty({ type: MetricsSourceCoverageDto })
  sourceCoverage!: MetricsSourceCoverageDto;

  @ApiProperty({ type: MetricsCompletenessDto })
  completeness!: MetricsCompletenessDto;

  @ApiProperty({ type: CommercialMetricsDto })
  commercial!: CommercialMetricsDto;

  @ApiProperty({ type: OperationalMetricsDto })
  operational!: OperationalMetricsDto;
}

export class MetricsOrderDetailDto {
  @ApiProperty({ type: String, format: "uuid" })
  id!: string;

  @ApiProperty({ type: String })
  publicReference!: string;

  @ApiProperty({ type: String, format: "date-time" })
  confirmedAt!: string;

  @ApiProperty({ type: String })
  status!: string;

  @ApiProperty({ enum: ["automatic", "individual", "unknown"] })
  origin!: "automatic" | "individual" | "unknown";

  @ApiProperty({ type: MetricMoneyDto })
  acceptedGross!: MetricMoneyDto;

  @ApiProperty({ type: ContractAmountsDto })
  activeContract!: ContractAmountsDto;

  @ApiProperty({ type: MetricMoneyDto })
  capturedCash!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  succeededRefunds!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  outstandingGross!: MetricMoneyDto;

  @ApiProperty({ type: MetricMoneyDto })
  handlingCost!: MetricMoneyDto;

  @ApiProperty({ type: ActualCostBreakdownDto })
  actualCosts!: ActualCostBreakdownDto;

  @ApiProperty({ type: MetricMoneyDto, nullable: true })
  finalContributionMargin!: MetricMoneyDto | null;

  @ApiProperty({ type: Boolean })
  explicitMarginCoverage!: boolean;
}

export class MetricsOrderPageDto {
  @ApiProperty({ type: String, enum: ["v0-1"] })
  metricDefinition!: "v0-1";

  @ApiProperty({ type: String, format: "date-time" })
  generatedAt!: string;

  @ApiProperty({ type: MetricsIntervalDto })
  interval!: MetricsIntervalDto;

  @ApiProperty({ type: MetricsSourceCoverageDto })
  sourceCoverage!: MetricsSourceCoverageDto;

  @ApiProperty({ type: MetricsCompletenessDto })
  completeness!: MetricsCompletenessDto;

  @ApiProperty({ type: String, enum: ["OPERATIONAL_NODE"] })
  scope!: "OPERATIONAL_NODE";

  @ApiProperty({ type: String, format: "uuid" })
  nodeId!: string;

  @ApiProperty({ type: [MetricsOrderDetailDto] })
  items!: MetricsOrderDetailDto[];

  @ApiPropertyOptional({ type: String, minLength: 1 })
  nextCursor?: string;
}
