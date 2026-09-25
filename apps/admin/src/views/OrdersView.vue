<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../api";
import { formatCzkMinor, formatPragueInstant } from "../format";
import {
  commandHeaders,
  CommandJournal,
  errorMessage,
  isoFromZonedInput,
  OperatorRequestError,
  requireData,
} from "../operator-requests";
import { hasPermission, session } from "../session";

type S = components["schemas"];
type Action = S["OperatorActionDto"];
type Refund = S["OperatorRefundPageItemDto"];
type HistoryKind =
  | "jobs"
  | "shipments"
  | "slots"
  | "replacementRequests"
  | "claims"
  | "priceAdjustments";
type HistoryItem = S["OperatorFulfilmentHistoryPageDto"]["items"][number];
type ChildKind = "resolutions" | "refunds" | "reshipmentAuthorizations";
type ChildItem = S["OperatorClaimChildHistoryPageDto"]["items"][number];

const route = useRoute();
const router = useRouter();
const journal = new CommandJournal();
const canOperate = computed(() => hasPermission("operations:write"));
const canSeeCosts = computed(() => hasPermission("financial:exception"));
const isAdmin = computed(() => session.value?.operator.role === "ADMIN");
const selectedOrderId = computed(() =>
  typeof route.query.order === "string" ? route.query.order : "",
);
const selectedJobId = computed(() =>
  typeof route.query.job === "string" ? route.query.job : "",
);
const orders = ref<S["OperatorOrderListItemDto"][]>([]);
const jobs = ref<S["OperatorJobListItemDto"][]>([]);
const orderCursor = ref<string | null>(null);
const jobCursor = ref<string | null>(null);
const orderStatus = ref("");
const jobStatus = ref("");
const order = ref<S["OperatorOrderDetailDto"] | null>(null);
const job = ref<S["OperatorJobDetailDto"] | null>(null);
const artifactLink = ref<{
  kind: string;
  url: string;
  expiresAt: string;
} | null>(null);
const refunds = ref<Refund[]>([]);
const refundCursor = ref<string | null>(null);
const timeline = ref<S["OperatorOrderTimelineEventDto"][]>([]);
const timelineCursor = ref<string | null>(null);
const payments = ref<S["OperatorPaymentDto"][]>([]);
const paymentCursor = ref<string | null>(null);
const settlements = ref<S["OperatorSettlementDto"][]>([]);
const settlementCursor = ref<string | null>(null);
const history = ref<Partial<Record<HistoryKind, HistoryItem[]>>>({});
const historyCursors = ref<Partial<Record<HistoryKind, string | null>>>({});
const childHistory = ref<Record<string, ChildItem[]>>({});
const childCursors = ref<Record<string, string | null>>({});
const handling = ref<S["HandlingSessionReadDto"][]>([]);
const openHandling = ref<S["HandlingSessionReadDto"][]>([]);
const openHandlingCursor = ref<string | null>(null);
const handlingCursor = ref<string | null>(null);
const allocationPages = ref<Record<string, S["HandlingAllocationReadDto"][]>>(
  {},
);
const allocationCursors = ref<Record<string, string | null>>({});
const actualCosts = ref<S["ActualCostEvidenceDto"][]>([]);
const costCursor = ref<string | null>(null);
const readCount = ref(0);
const loading = computed(() => readCount.value > 0);
function startRead(): void {
  readCount.value += 1;
}
function endRead(): void {
  readCount.value = Math.max(0, readCount.value - 1);
}
const busy = ref(false);
const error = ref("");
const success = ref("");
const refreshRequired = ref(false);
const activeAction = ref<Action | null>(null);
const actionError = ref("");
const reason = ref("");
const stage = ref<
  | "PREPARATION"
  | "GCODE"
  | "MACHINE"
  | "PRINTING"
  | "POST_PRINT"
  | "POST_QC"
  | "PACKING"
>("PRINTING");
const recovery = ref<"REPLACE" | "REFUND">("REPLACE");
const amount = ref("");
const material = ref("");
const shipmentId = ref("");
const carrier = ref("");
const carrierLabelId = ref("");
const providerShipmentId = ref("");
const trackingCode = ref("");
const providerEventId = ref("");
const providerTransactionId = ref("");
const occurredAt = ref("");
const evidenceKind = ref<"PROVIDER_PORTAL" | "PROVIDER_SUPPORT">(
  "PROVIDER_PORTAL",
);
const evidenceReference = ref("");
const outcome = ref<"SUCCEEDED" | "FAILED">("FAILED");
const shipmentEventKind = ref<
  "TRANSIT_SCAN" | "DELIVERY_SCAN" | "LOST" | "RETURNED" | "RECOVERED"
>("DELIVERY_SCAN");
const finalOutcomeConfirmed = ref(false);
const providerRefundReference = ref("");
const checkoutMethod = ref<"CARD" | "BANK_TRANSFER">("CARD");
const candidateId = ref("");
const selectedSlots = ref<string[]>([]);
const claimOrigin = ref<"SHIPMENT_INCIDENT" | "POST_DELIVERY_QUALITY">(
  "SHIPMENT_INCIDENT",
);
const selectedIncidentShipment = ref("");
const adjustmentReason = ref<
  | "EXPRESS_BREACH"
  | "PRODUCTION_FAILURE"
  | "SHIPMENT_INCIDENT"
  | "POST_DELIVERY_ISSUE"
>("PRODUCTION_FAILURE");
const selectedPayment = ref("");
const printingConsumptions = ref<Record<string, string>>({});
const slotCredits = ref<Record<string, string>>({});
const confirmed = ref(false);
const pendingRetry = ref<(() => Promise<void>) | null>(null);
const pendingTarget = ref("");
const handlingComponent = ref<
  | "HANDLING_ORDER_FIX"
  | "HANDLING_PLATE"
  | "HANDLING_PIECE"
  | "HANDLING_PACK"
  | "SHIPPING_TRIP"
  | "POSTPROCESSING_ITEM"
>("HANDLING_ORDER_FIX");
const handlingStartedAt = ref("");
const handlingEndedAt = ref("");
const handlingDuration = ref("");
const handlingMode = ref<"start" | "stop" | "manual" | "void" | "">("");
const handlingSessionId = ref("");
const handlingAllocations = ref<S["HandlingAllocationInputDto"][]>([]);
let detailEpoch = 0;
let listEpoch = 0;

const actions = computed(() => [
  ...(order.value?.actions ?? []),
  ...(job.value?.actions ?? []).filter(
    (candidate) =>
      !(order.value?.actions ?? []).some(
        (existing) =>
          existing.action === candidate.action &&
          existing.targetId === candidate.targetId,
      ),
  ),
]);
function withHistory<T extends { id: string }>(
  initial: T[] | undefined,
  continuation: HistoryItem[] | undefined,
): T[] {
  const seen = new Set<string>();
  return [
    ...(initial ?? []),
    ...((continuation ?? []) as unknown as T[]),
  ].filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}
const allJobs = computed(() =>
  withHistory(order.value?.fulfilment.jobs, history.value.jobs),
);
const allShipments = computed(() =>
  withHistory(order.value?.fulfilment.shipments, history.value.shipments),
);
const allSlots = computed(() =>
  withHistory(order.value?.fulfilment.slots, history.value.slots),
);
const allClaims = computed(() =>
  withHistory(order.value?.fulfilment.claims, history.value.claims),
);
const allReplacementRequests = computed(() =>
  withHistory(
    order.value?.fulfilment.replacementRequests,
    history.value.replacementRequests,
  ),
);
const currentRefund = computed(() =>
  refunds.value.find((item) => item.id === activeAction.value?.targetId),
);
const currentJob = computed(() =>
  allJobs.value.find((item) => item.id === activeAction.value?.targetId),
);
const inputBlockers = new Set([
  "JOB_DETAIL_REQUIRED",
  "ACTUAL_MATERIAL_REQUIRED",
  "QC_EVIDENCE_REQUIRED",
  "MATCHING_SHIPMENT_REQUIRED",
  "FAILURE_DETAILS_REQUIRED",
  "CARRIER_REFERENCE_REQUIRED",
  "PROVIDER_VOID_EVIDENCE_REQUIRED",
  "PROVIDER_ACCEPTANCE_EVIDENCE_REQUIRED",
  "PROVIDER_EVENT_REQUIRED",
  "REPLACED_SHIPMENT_ID_REQUIRED",
  "PRINTING_CONSUMPTION_REQUIRED",
  "CHECKOUT_METHOD_REQUIRED",
  "CLAIM_DETAILS_REQUIRED",
  "ADJUSTMENT_DETAILS_REQUIRED",
  "EXPIRY_REASON_REQUIRED",
  "REFUND_REASON_REQUIRED",
  "REFUND_ALLOCATION_REQUIRED",
  "REJECTION_REASON_REQUIRED",
  "WITHDRAWAL_REASON_REQUIRED",
]);
function actionCanOpen(action: Action): boolean {
  if (action.action === "PREPARE_REPLACEMENT") return false;
  return (
    action.enabled ||
    action.blockingCodes.every((code) => inputBlockers.has(code))
  );
}
const selectedActionEnabled = computed(() => {
  const action = activeAction.value;
  if (!action || busy.value || refreshRequired.value) return false;
  return actionCanOpen(action);
});

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    ACCEPT_JOB: "Přijmout úlohu",
    START_PRINTING: "Zahájit tisk",
    FINISH_PRINTING: "Dokončit tisk",
    SUBMIT_QC: "Předat ke kontrole",
    APPROVE_QC: "Schválit kontrolu",
    PACK_JOB: "Zabalit úlohu",
    FAIL_JOB: "Zaznamenat selhání",
    PREPARE_REPLACEMENT: "Připravit náhradu",
    CREATE_SHIPMENT: "Vytvořit zásilku",
    CREATE_LABEL: "Zapsat štítek",
    CONFIRM_LABEL_VOID: "Potvrdit zneplatnění štítku",
    HANDOFF_SHIPMENT: "Předat dopravci",
    RECORD_DELIVERY_EVENT: "Zapsat událost dopravce",
    CANCEL_ORDER: "Zrušit objednávku",
    CREATE_BALANCE_PAYMENT: "Vytvořit doplatek",
    COMPLETE_ORDER: "Uzavřít objednávku",
    CREATE_CLAIM: "Otevřít reklamaci",
    CREATE_PRICE_ADJUSTMENT: "Zapsat úpravu ceny",
    EXPIRE_REPLACEMENT: "Uzavřít prošlou náhradu",
    REFUND_ADJUSTMENT: "Vrátit úpravu ceny",
    REFUND_CLAIM: "Vrátit reklamaci",
    REJECT_CLAIM: "Zamítnout reklamaci",
    WITHDRAW_CLAIM: "Stáhnout reklamaci",
    RECORD_REFUND_PROVIDER_RESULT: "Zapsat konečný výsledek poskytovatele",
    RETRY_REFUND: "Jednou zopakovat selhané vrácení",
  };
  return labels[action] ?? action;
}

function lineageSummary(item: HistoryItem | ChildItem): string {
  const fact = item as Record<string, unknown>;
  const parts = [
    fact.id,
    fact.status,
    fact.reason,
    fact.shipmentPlanId,
    fact.fulfilmentSlotId,
  ].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return parts.join(" · ");
}

async function loadLists(): Promise<void> {
  const epoch = ++listEpoch;
  startRead();
  error.value = "";
  try {
    const [orderResult, jobResult] = await Promise.all([
      apiClient.GET("/admin/orders", {
        params: {
          query: {
            limit: 50,
            ...(orderStatus.value ? { status: orderStatus.value } : {}),
          },
        },
      }),
      apiClient.GET("/admin/jobs", {
        params: {
          query: {
            limit: 50,
            ...(jobStatus.value ? { status: jobStatus.value } : {}),
          },
        },
      }),
    ]);
    const orderPage = requireData(orderResult);
    const jobPage = requireData(jobResult);
    if (epoch !== listEpoch || session.phase !== "authenticated") return;
    orders.value = orderPage.items;
    jobs.value = jobPage.items;
    orderCursor.value = orderPage.nextCursor ?? null;
    jobCursor.value = jobPage.nextCursor ?? null;
  } catch (cause) {
    if (epoch === listEpoch) error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreList(kind: "orders" | "jobs"): Promise<void> {
  const cursor = kind === "orders" ? orderCursor.value : jobCursor.value;
  if (!cursor || loading.value) return;
  startRead();
  try {
    if (kind === "orders") {
      const page = requireData(
        await apiClient.GET("/admin/orders", {
          params: {
            query: {
              limit: 50,
              cursor,
              ...(orderStatus.value ? { status: orderStatus.value } : {}),
            },
          },
        }),
      );
      if (session.phase !== "authenticated") return;
      orders.value.push(...page.items);
      orderCursor.value = page.nextCursor ?? null;
    } else {
      const page = requireData(
        await apiClient.GET("/admin/jobs", {
          params: {
            query: {
              limit: 50,
              cursor,
              ...(jobStatus.value ? { status: jobStatus.value } : {}),
            },
          },
        }),
      );
      if (session.phase !== "authenticated") return;
      jobs.value.push(...page.items);
      jobCursor.value = page.nextCursor ?? null;
    }
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function loadDetail(): Promise<void> {
  const id = selectedOrderId.value;
  const jobId = selectedJobId.value;
  const epoch = ++detailEpoch;
  order.value = null;
  job.value = null;
  artifactLink.value = null;
  refunds.value = [];
  timeline.value = [];
  payments.value = [];
  settlements.value = [];
  handling.value = [];
  openHandling.value = [];
  allocationPages.value = {};
  allocationCursors.value = {};
  actualCosts.value = [];
  history.value = {};
  historyCursors.value = {};
  childHistory.value = {};
  childCursors.value = {};
  activeAction.value = null;
  if (!id) return;
  startRead();
  error.value = "";
  try {
    const [
      orderResult,
      refundResult,
      handlingResult,
      openHandlingResult,
      costsResult,
    ] = await Promise.all([
      apiClient.GET("/admin/orders/{orderId}", {
        params: { path: { orderId: id } },
      }),
      apiClient.GET("/admin/orders/{orderId}/refunds", {
        params: { path: { orderId: id }, query: { limit: 50 } },
      }),
      apiClient.GET("/admin/handling-sessions", {
        params: { query: { orderId: id, limit: 50 } },
      }),
      apiClient.GET("/admin/handling-sessions", {
        params: { query: { lifecycle: "OPEN", limit: 50 } },
      }),
      canSeeCosts.value
        ? apiClient.GET("/admin/orders/{orderId}/actual-costs", {
            params: { path: { orderId: id }, query: { limit: 50 } },
          })
        : Promise.resolve(null),
    ]);
    const detail = requireData(orderResult);
    const refundPage = requireData(refundResult);
    const handlingPage = requireData(handlingResult);
    const openPage = requireData(openHandlingResult);
    const costPage = costsResult ? requireData(costsResult) : null;
    const jobDetail = jobId
      ? requireData(
          await apiClient.GET("/admin/jobs/{jobId}", {
            params: { path: { jobId } },
          }),
        )
      : null;
    if (
      epoch !== detailEpoch ||
      selectedOrderId.value !== id ||
      session.phase !== "authenticated"
    )
      return;
    if (jobDetail && jobDetail.orderId !== id)
      throw new Error("Úloha nepatří k vybrané objednávce.");
    order.value = detail;
    job.value = jobDetail;
    refunds.value = refundPage.items;
    refundCursor.value = refundPage.nextCursor ?? null;
    timeline.value = detail.timeline;
    timelineCursor.value = detail.timelineNextCursor ?? null;
    payments.value = detail.financial.payments;
    paymentCursor.value = detail.financial.paymentsNextCursor ?? null;
    settlements.value = detail.financial.settlements;
    settlementCursor.value = detail.financial.settlementsNextCursor ?? null;
    handling.value = handlingPage.items;
    openHandling.value = openPage.items;
    openHandlingCursor.value = openPage.nextCursor ?? null;
    handlingCursor.value = handlingPage.nextCursor ?? null;
    actualCosts.value = costPage?.items ?? [];
    costCursor.value = costPage?.nextCursor ?? null;
    historyCursors.value = Object.fromEntries(
      Object.entries(detail.fulfilmentNextCursors).map(([kind, cursor]) => [
        kind,
        cursor ?? null,
      ]),
    );
    refreshRequired.value = false;
  } catch (cause) {
    if (epoch === detailEpoch) error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreRefunds(): Promise<void> {
  if (!order.value || !refundCursor.value || loading.value) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/refunds", {
        params: {
          path: { orderId: id },
          query: { limit: 50, cursor: refundCursor.value },
        },
      }),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    refunds.value.push(...page.items);
    refundCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreTimeline(): Promise<void> {
  if (!order.value || !timelineCursor.value || loading.value) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/timeline", {
        params: {
          path: { orderId: id },
          query: { limit: 50, cursor: timelineCursor.value },
        },
      }),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    timeline.value.push(...page.items);
    timelineCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function morePayments(): Promise<void> {
  if (!order.value || !paymentCursor.value || loading.value) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/payments", {
        params: {
          path: { orderId: id },
          query: { limit: 50, cursor: paymentCursor.value },
        },
      }),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    payments.value.push(...page.items);
    paymentCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreSettlements(): Promise<void> {
  if (!order.value || !settlementCursor.value || loading.value) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/settlements", {
        params: {
          path: { orderId: id },
          query: { limit: 50, cursor: settlementCursor.value },
        },
      }),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    settlements.value.push(...page.items);
    settlementCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreHandling(): Promise<void> {
  if (!order.value || !handlingCursor.value || loading.value) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/handling-sessions", {
        params: {
          query: { orderId: id, limit: 50, cursor: handlingCursor.value },
        },
      }),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    handling.value.push(...page.items);
    handlingCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreOpenHandling(): Promise<void> {
  if (!openHandlingCursor.value || loading.value) return;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/handling-sessions", {
        params: {
          query: {
            lifecycle: "OPEN",
            limit: 50,
            cursor: openHandlingCursor.value,
          },
        },
      }),
    );
    if (session.phase !== "authenticated" || !order.value) return;
    openHandling.value.push(...page.items);
    openHandlingCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

function nextAllocationCursor(
  item: S["HandlingSessionReadDto"],
): string | null {
  if (item.id in allocationCursors.value)
    return allocationCursors.value[item.id] ?? null;
  return item.allocationsNextCursor ?? null;
}

async function moreAllocations(
  item: S["HandlingSessionReadDto"],
): Promise<void> {
  const cursor = nextAllocationCursor(item);
  if (!cursor || loading.value) return;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/handling-sessions/{sessionId}/allocations", {
        params: { path: { sessionId: item.id }, query: { limit: 50, cursor } },
      }),
    );
    if (session.phase !== "authenticated" || !order.value) return;
    allocationPages.value[item.id] = [
      ...(allocationPages.value[item.id] ?? []),
      ...page.items,
    ];
    allocationCursors.value[item.id] = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreCosts(): Promise<void> {
  if (!order.value || !costCursor.value || loading.value) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/actual-costs", {
        params: {
          path: { orderId: id },
          query: { limit: 50, cursor: costCursor.value },
        },
      }),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    actualCosts.value.push(...page.items);
    costCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreHistory(kind: HistoryKind): Promise<void> {
  if (!order.value || !historyCursors.value[kind] || loading.value) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/fulfilment-history/{kind}", {
        params: {
          path: { orderId: id, kind },
          query: { limit: 50, cursor: historyCursors.value[kind]! },
        },
      }),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    history.value[kind] = [...(history.value[kind] ?? []), ...page.items];
    historyCursors.value[kind] = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

async function moreChildHistory(
  claimId: string,
  kind: ChildKind,
): Promise<void> {
  if (!order.value || loading.value) return;
  const key = `${claimId}:${kind}`;
  const cursor = childNextCursor(claimId, kind);
  if (!cursor) return;
  const id = order.value.id;
  startRead();
  try {
    const page = requireData(
      await apiClient.GET(
        "/admin/orders/{orderId}/fulfilment-history/claims/{claimId}/{kind}",
        {
          params: {
            path: { orderId: id, claimId, kind },
            query: { limit: 50, cursor },
          },
        },
      ),
    );
    if (selectedOrderId.value !== id || session.phase !== "authenticated")
      return;
    childHistory.value[key] = [
      ...(childHistory.value[key] ?? []),
      ...page.items,
    ];
    childCursors.value[key] = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    endRead();
  }
}

function childNextCursor(claimId: string, kind: ChildKind): string | null {
  const key = `${claimId}:${kind}`;
  if (key in childCursors.value) return childCursors.value[key] ?? null;
  return (
    allClaims.value.find((claim) => claim.id === claimId)?.historyNextCursors?.[
      kind
    ] ?? null
  );
}

function chooseOrder(id: string, jobId = ""): void {
  void router.push({
    path: "/objednavky",
    query: { order: id, ...(jobId ? { job: jobId } : {}) },
  });
}

function openAction(action: Action): void {
  if (pendingRetry.value) return;
  handlingMode.value = "";
  activeAction.value = action;
  actionError.value = "";
  reason.value = "";
  amount.value = "";
  material.value = "";
  shipmentId.value = "";
  candidateId.value = "";
  selectedSlots.value = [];
  finalOutcomeConfirmed.value = false;
  confirmed.value = false;
  printingConsumptions.value = {};
  slotCredits.value = {};
  selectedPayment.value =
    order.value?.financial.payments.find(
      (payment) => payment.status === "CAPTURED",
    )?.id ?? "";
  const shipment = allShipments.value.find(
    (item) =>
      item.shipmentPlanId === currentJob.value?.shipmentPlanId &&
      ["PLANNED", "LABEL_CREATED"].includes(item.status),
  );
  if (shipment) shipmentId.value = shipment.id;
}

async function download(
  kind: "SOURCE_MODEL" | "PREVIEW" | "PRODUCTION",
): Promise<void> {
  if (!job.value || !session.value) return;
  try {
    const result = requireData(
      await apiClient.POST("/admin/jobs/{jobId}/artifacts/{kind}/download", {
        params: {
          path: { jobId: job.value.id, kind },
          header: { "x-csrf-token": session.value.csrfToken },
        },
      }),
    );
    const url = new URL(result.downloadUrl);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("Neplatný odkaz na soubor.");
    artifactLink.value = {
      kind,
      url: url.toString(),
      expiresAt: result.expiresAt,
    };
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`Vyplňte ${label}.`);
  return trimmed;
}

function nonnegativeInteger(value: string, label: string): string {
  const trimmed = required(value, label);
  if (!/^\d+$/.test(trimmed))
    throw new Error(`${label}: zadejte celé nezáporné číslo.`);
  return trimmed;
}

function positiveInteger(value: string, label: string): string {
  const number = nonnegativeInteger(value, label);
  if (BigInt(number) === 0n)
    throw new Error(`${label}: hodnota musí být kladná.`);
  return number;
}

function consumedPrinting(): {
  jobId: string;
  actualMaterialMilligrams: string;
}[] {
  return allJobs.value
    .filter((item) => item.status === "PRINTING")
    .map((item) => ({
      jobId: item.id,
      actualMaterialMilligrams: nonnegativeInteger(
        printingConsumptions.value[item.id] ?? "",
        `skutečnou spotřebu úlohy ${item.id}`,
      ),
    }));
}

function providerEvidence(): S["ShipmentProviderEvidenceDto"] {
  return {
    occurredAt: isoFromZonedInput(
      required(occurredAt.value, "čas události s časovým pásmem"),
    ),
    providerEventId: required(providerEventId.value, "ID události dopravce"),
    providerTransactionId: required(
      providerTransactionId.value,
      "ID transakce dopravce",
    ),
    reason: required(reason.value, "důvod"),
  };
}

type ApiResponse = { data?: unknown; error?: unknown; response: Response };
async function submitBody<B>(
  action: Action,
  body: B,
  call: (body: B, key: string) => Promise<ApiResponse>,
): Promise<void> {
  const perform = async () => {
    await journal.submit(
      `${action.action}:${action.targetId}`,
      body,
      async (frozen, key) => requireData(await call(frozen as B, key)),
    );
  };
  try {
    await perform();
    pendingRetry.value = null;
    pendingTarget.value = "";
    await loadDetail();
    await loadLists();
    handlingMode.value = "";
    if (order.value) {
      success.value = `${actionLabel(action.action)}: výsledek potvrzen. Aktuální stav byl načten.`;
    } else {
      refreshRequired.value = true;
      success.value = `${actionLabel(action.action)}: zápis byl potvrzen, ale aktuální stav se nepodařilo načíst.`;
    }
  } catch (cause) {
    actionError.value = errorMessage(cause);
    if (cause instanceof OperatorRequestError && cause.refreshRequired) {
      pendingRetry.value = null;
      pendingTarget.value = "";
      await loadDetail();
      error.value = actionError.value;
    } else if (
      !(cause instanceof OperatorRequestError) ||
      cause.status === 503
    ) {
      pendingRetry.value = perform;
      pendingTarget.value = order.value?.id ?? "";
      actionError.value +=
        " Výsledek není jistý. Opakujte pouze totožný požadavek nebo obnovte serverový stav.";
    }
  } finally {
    busy.value = false;
  }
}

async function retryPending(): Promise<void> {
  const retry = pendingRetry.value;
  if (!retry || busy.value || selectedOrderId.value !== pendingTarget.value)
    return;
  busy.value = true;
  try {
    await retry();
    pendingRetry.value = null;
    pendingTarget.value = "";
    await loadDetail();
    await loadLists();
    handlingMode.value = "";
    if (order.value)
      success.value =
        "Výsledek původního požadavku byl potvrzen a stav obnoven.";
    else {
      refreshRequired.value = true;
      success.value =
        "Výsledek původního požadavku byl potvrzen, ale aktuální stav se nepodařilo načíst.";
    }
  } catch (cause) {
    actionError.value = errorMessage(cause);
    if (cause instanceof OperatorRequestError && cause.refreshRequired) {
      pendingRetry.value = null;
      pendingTarget.value = "";
      await loadDetail();
      error.value = actionError.value;
    }
  } finally {
    busy.value = false;
  }
}

async function submitAction(): Promise<void> {
  const action = activeAction.value;
  const detail = order.value;
  const id = detail?.id;
  if (
    !action ||
    !detail ||
    !id ||
    !selectedActionEnabled.value ||
    busy.value ||
    pendingRetry.value
  )
    return;
  actionError.value = "";
  try {
    if (action.requiresReason) required(reason.value, "důvod");
    if (action.requiresConfirmation && !confirmed.value)
      throw new Error("Potvrďte význam této změny.");
    busy.value = true;
    const targetId = action.targetId;
    switch (action.action) {
      case "ACCEPT_JOB":
        await submitBody(action, null, (_, key) =>
          apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/accept",
            {
              params: {
                path: { orderId: id, jobId: targetId },
                header: commandHeaders(key),
              },
            },
          ),
        );
        return;
      case "START_PRINTING":
        if (
          job.value?.id !== targetId ||
          !job.value.estimate.mountReadyForPrinting
        )
          throw new Error(
            "Načtěte detail úlohy a ověřte namontovaný materiál.",
          );
        await submitBody(action, null, (_, key) =>
          apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/printing",
            {
              params: {
                path: { orderId: id, jobId: targetId },
                header: commandHeaders(key),
              },
            },
          ),
        );
        return;
      case "FINISH_PRINTING":
        await submitBody(
          action,
          {
            actualMaterialMilligrams: nonnegativeInteger(
              material.value,
              "skutečnou spotřebu v mg",
            ),
          },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/printed",
              {
                params: {
                  path: { orderId: id, jobId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "SUBMIT_QC":
        await submitBody(
          action,
          {
            omissionReason: required(
              reason.value,
              "důvod vynechání fotografie",
            ),
          },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/qc-submission",
              {
                params: {
                  path: { orderId: id, jobId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "APPROVE_QC":
        await submitBody(action, null, (_, key) =>
          apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/qc-approval",
            {
              params: {
                path: { orderId: id, jobId: targetId },
                header: commandHeaders(key),
              },
            },
          ),
        );
        return;
      case "PACK_JOB":
        await submitBody(
          action,
          { shipmentId: required(shipmentId.value, "odpovídající zásilku") },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/packing",
              {
                params: {
                  path: { orderId: id, jobId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "FAIL_JOB":
        await submitBody(
          action,
          {
            stage: stage.value,
            recovery: recovery.value,
            reason: required(reason.value, "důvod"),
            ...(material.value
              ? {
                  actualMaterialMilligrams: nonnegativeInteger(
                    material.value,
                    "skutečnou spotřebu",
                  ),
                }
              : {}),
            printingConsumptions: consumedPrinting().filter(
              (entry) => entry.jobId !== targetId,
            ),
          },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/failure",
              {
                params: {
                  path: { orderId: id, jobId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "PREPARE_REPLACEMENT":
        throw new Error(
          "Příprava čerstvého kandidáta na náhradu čeká na architektonické rozhodnutí #259.",
        );
      case "CREATE_SHIPMENT":
        await submitBody(
          action,
          {
            shipmentPlanId: targetId,
            ...(shipmentId.value
              ? { replacesShipmentId: shipmentId.value }
              : {}),
          },
          (body, key) =>
            apiClient.POST("/admin/orders/{orderId}/fulfilment/shipments", {
              params: { path: { orderId: id }, header: commandHeaders(key) },
              body,
            }),
        );
        return;
      case "CREATE_LABEL":
        await submitBody(
          action,
          {
            carrier: required(carrier.value, "dopravce"),
            carrierLabelId: required(carrierLabelId.value, "ID štítku"),
            providerShipmentId: required(
              providerShipmentId.value,
              "ID zásilky u dopravce",
            ),
            reason: required(reason.value, "důvod"),
            ...(trackingCode.value
              ? { trackingCode: trackingCode.value.trim() }
              : {}),
          },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/label",
              {
                params: {
                  path: { orderId: id, shipmentId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "CONFIRM_LABEL_VOID":
        await submitBody(action, providerEvidence(), (body, key) =>
          apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/label-void",
            {
              params: {
                path: { orderId: id, shipmentId: targetId },
                header: commandHeaders(key),
              },
              body,
            },
          ),
        );
        return;
      case "HANDOFF_SHIPMENT":
        await submitBody(action, providerEvidence(), (body, key) =>
          apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/handoff",
            {
              params: {
                path: { orderId: id, shipmentId: targetId },
                header: commandHeaders(key),
              },
              body,
            },
          ),
        );
        return;
      case "RECORD_DELIVERY_EVENT":
        await submitBody(
          action,
          { ...providerEvidence(), kind: shipmentEventKind.value },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/shipments/{shipmentId}/events",
              {
                params: {
                  path: { orderId: id, shipmentId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "CANCEL_ORDER":
        await submitBody(
          action,
          {
            reason: required(reason.value, "důvod"),
            printingConsumptions: consumedPrinting(),
          },
          (body, key) =>
            apiClient.POST("/admin/orders/{orderId}/fulfilment/cancel", {
              params: { path: { orderId: id }, header: commandHeaders(key) },
              body,
            }),
        );
        return;
      case "CREATE_BALANCE_PAYMENT":
        await submitBody(
          action,
          { method: checkoutMethod.value },
          (body, key) =>
            apiClient.POST("/admin/orders/{orderId}/balance-payment", {
              params: { path: { orderId: id }, header: commandHeaders(key) },
              body,
            }),
        );
        return;
      case "COMPLETE_ORDER":
        await submitBody(action, null, (_, key) =>
          apiClient.POST("/admin/orders/{orderId}/fulfilment/complete", {
            params: { path: { orderId: id }, header: commandHeaders(key) },
          }),
        );
        return;
      case "CREATE_CLAIM":
        if (selectedSlots.value.length === 0)
          throw new Error("Vyberte alespoň jeden dotčený slot.");
        await submitBody(
          action,
          {
            fulfilmentSlotIds: selectedSlots.value,
            origin: claimOrigin.value,
            reason: required(reason.value, "důvod"),
            ...(selectedIncidentShipment.value
              ? { incidentShipmentId: selectedIncidentShipment.value }
              : {}),
          },
          (body, key) =>
            apiClient.POST("/admin/orders/{orderId}/fulfilment/claims", {
              params: { path: { orderId: id }, header: commandHeaders(key) },
              body,
            }),
        );
        return;
      case "CREATE_PRICE_ADJUSTMENT": {
        const credits = Object.entries(slotCredits.value)
          .filter(([, value]) => value.trim())
          .map(([fulfilmentSlotId, value]) => ({
            fulfilmentSlotId,
            amountMinor: positiveInteger(
              value,
              `částku slotu ${fulfilmentSlotId}`,
            ),
          }));
        const body: S["CreatePriceAdjustmentDto"] = {
          reason: adjustmentReason.value,
          rationale: required(reason.value, "zdůvodnění"),
          amountMinor: positiveInteger(amount.value, "částku v haléřích"),
          allocation: credits.length ? { slotCredits: credits } : {},
          ...(selectedPayment.value
            ? { paymentId: selectedPayment.value }
            : {}),
        };
        if (
          adjustmentReason.value !== "EXPRESS_BREACH" &&
          credits.reduce(
            (total, credit) => total + BigInt(credit.amountMinor),
            0n,
          ) !== BigInt(body.amountMinor)
        ) {
          throw new Error(
            "Součet kreditů slotů musí odpovídat celé částce úpravy.",
          );
        }
        await submitBody(action, body, (draft, key) =>
          apiClient.POST("/admin/orders/{orderId}/fulfilment/adjustments", {
            params: { path: { orderId: id }, header: commandHeaders(key) },
            body: draft,
          }),
        );
        return;
      }
      case "EXPIRE_REPLACEMENT": {
        const sourceJobId = allReplacementRequests.value.find(
          (request) => request.id === targetId,
        )?.sourceJobId;
        if (!sourceJobId)
          throw new Error("Původní úloha náhrady není v načteném detailu.");
        await submitBody(
          action,
          {
            reason: required(reason.value, "důvod"),
            printingConsumptions: consumedPrinting(),
          },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/replacement-expiry",
              {
                params: {
                  path: {
                    orderId: id,
                    jobId: sourceJobId,
                  },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      }
      case "REFUND_ADJUSTMENT":
        await submitBody(
          action,
          { reason: required(reason.value, "důvod") },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/adjustments/{adjustmentId}/refund",
              {
                params: {
                  path: { orderId: id, adjustmentId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "REFUND_CLAIM":
        await submitBody(
          action,
          { reason: required(reason.value, "důvod") },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/claims/{claimId}/refund",
              {
                params: {
                  path: { orderId: id, claimId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "REJECT_CLAIM":
        await submitBody(
          action,
          { reason: required(reason.value, "důvod") },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/claims/{claimId}/rejection",
              {
                params: {
                  path: { orderId: id, claimId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "WITHDRAW_CLAIM":
        await submitBody(
          action,
          { reason: required(reason.value, "důvod") },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/claims/{claimId}/withdrawal",
              {
                params: {
                  path: { orderId: id, claimId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      case "RECORD_REFUND_PROVIDER_RESULT": {
        const refund = currentRefund.value;
        if (!refund || !refund.providerIntentId)
          throw new Error(
            "Chybí přesná identita původní platby. Načtěte vrácení a ověřte podklady.",
          );
        if (!finalOutcomeConfirmed.value)
          throw new Error(
            "Potvrďte konečný výsledek přímo z portálu nebo podpory poskytovatele.",
          );
        if (!["PENDING", "FAILED", "SUSPENDED"].includes(refund.status))
          throw new Error("Stav vrácení se změnil. Načtěte aktuální údaje.");
        const body: S["RefundProviderResultDto"] = {
          amountMinor: refund.amountMinor,
          currency: refund.currency,
          evidenceKind: evidenceKind.value,
          evidenceReference: required(
            evidenceReference.value,
            "odkaz na důkaz",
          ),
          expectedProviderResultEventId: refund.providerResultEventId ?? null,
          expectedStatus:
            refund.status as S["RefundProviderResultDto"]["expectedStatus"],
          finalOutcomeConfirmed: true,
          occurredAt: isoFromZonedInput(
            required(occurredAt.value, "čas výsledku s pásmem"),
          ),
          outcome: outcome.value,
          providerIntentId: refund.providerIntentId,
          ...(providerRefundReference.value
            ? { providerRefundReference: providerRefundReference.value.trim() }
            : {}),
          reason: required(reason.value, "důvod"),
          requestReference: refund.requestReference,
        };
        await submitBody(action, body, (draft, key) =>
          apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/refunds/{refundId}/provider-results",
            {
              params: {
                path: { orderId: id, refundId: targetId },
                header: commandHeaders(key),
              },
              body: draft,
            },
          ),
        );
        return;
      }
      case "RETRY_REFUND": {
        const failureId = currentRefund.value?.providerResultEventId;
        if (!failureId)
          throw new Error("Chybí vybraný konečný záznam o selhání.");
        if (currentRefund.value?.selectedResultKind !== "REFUND_FAILED")
          throw new Error("Vybraný konečný výsledek není selhání vrácení.");
        await submitBody(
          action,
          {
            expectedFailureProviderEventId: failureId,
            reason: required(reason.value, "důvod"),
          },
          (body, key) =>
            apiClient.POST(
              "/admin/orders/{orderId}/fulfilment/refunds/{refundId}/retry",
              {
                params: {
                  path: { orderId: id, refundId: targetId },
                  header: commandHeaders(key),
                },
                body,
              },
            ),
        );
        return;
      }
      default:
        throw new Error("Pro tento krok není připravené bezpečné rozhraní.");
    }
  } catch (cause) {
    actionError.value = errorMessage(cause);
    busy.value = false;
  }
}

function openHandlingForm(
  mode: "start" | "stop" | "manual" | "void",
  sessionId = "",
): void {
  if (pendingRetry.value) return;
  activeAction.value = null;
  handlingMode.value = mode;
  handlingSessionId.value = sessionId;
  const selectedSession = [...openHandling.value, ...handling.value].find(
    (item) => item.id === sessionId,
  );
  if (selectedSession && isHandlingComponent(selectedSession.component)) {
    handlingComponent.value = selectedSession.component;
  }
  reason.value = "";
  actionError.value = "";
  confirmed.value = false;
  handlingAllocations.value = selectedOrderId.value
    ? [{ orderId: selectedOrderId.value, servedUnitCount: "1" }]
    : [];
}

function isHandlingComponent(
  value: string,
): value is S["StartHandlingSessionDto"]["component"] {
  return [
    "HANDLING_ORDER_FIX",
    "HANDLING_PLATE",
    "HANDLING_PIECE",
    "HANDLING_PACK",
    "SHIPPING_TRIP",
    "POSTPROCESSING_ITEM",
  ].includes(value);
}

async function submitHandling(): Promise<void> {
  if (!canOperate.value || !order.value || busy.value || pendingRetry.value)
    return;
  actionError.value = "";
  const mode = handlingMode.value;
  const action: Action = {
    action: `HANDLING_${mode.toUpperCase()}`,
    targetType: "HANDLING_SESSION",
    targetId: handlingSessionId.value || order.value.id,
    enabled: true,
    blockingCodes: [],
    requiresConfirmation: false,
    requiresReason: false,
  };
  try {
    busy.value = true;
    if (mode === "start") {
      await submitBody(
        action,
        { component: handlingComponent.value },
        (body, key) =>
          apiClient.POST("/admin/handling-sessions/start", {
            params: { header: commandHeaders(key) },
            body,
          }),
      );
    } else if (mode === "stop" || mode === "manual") {
      if (!handlingAllocations.value.length)
        throw new Error("Zadejte alespoň jedno přiřazení práce.");
      const allocations = handlingAllocations.value.map((allocation) => ({
        orderId: required(allocation.orderId, "objednávku"),
        servedUnitCount: positiveInteger(
          allocation.servedUnitCount,
          "počet obsloužených jednotek",
        ),
        ...(allocation.jobId ? { jobId: allocation.jobId } : {}),
        ...(allocation.shipmentId ? { shipmentId: allocation.shipmentId } : {}),
        ...(allocation.orderItemId
          ? { orderItemId: allocation.orderItemId }
          : {}),
        ...(allocation.orderPhaseId
          ? { orderPhaseId: allocation.orderPhaseId }
          : {}),
      }));
      if (mode === "stop") {
        const sessionId = required(handlingSessionId.value, "běžící relaci");
        await submitBody(action, { allocations }, (body, key) =>
          apiClient.POST("/admin/handling-sessions/{sessionId}/stop", {
            params: { path: { sessionId }, header: commandHeaders(key) },
            body,
          }),
        );
      } else {
        const body: S["RecordManualHandlingSessionDto"] = {
          component: handlingComponent.value,
          startedAt: isoFromZonedInput(
            required(handlingStartedAt.value, "začátek včetně pásma"),
          ),
          endedAt: isoFromZonedInput(
            required(handlingEndedAt.value, "konec včetně pásma"),
          ),
          durationMilliseconds: nonnegativeInteger(
            handlingDuration.value,
            "trvání v ms",
          ),
          reason: required(reason.value, "důvod ručního záznamu"),
          allocations,
        };
        await submitBody(action, body, (draft, key) =>
          apiClient.POST("/admin/handling-sessions/manual", {
            params: { header: commandHeaders(key) },
            body: draft,
          }),
        );
      }
    } else if (mode === "void") {
      const sessionId = required(handlingSessionId.value, "relaci");
      if (!confirmed.value) throw new Error("Potvrďte zneplatnění záznamu.");
      await submitBody(
        action,
        { reason: required(reason.value, "důvod zneplatnění") },
        (body, key) =>
          apiClient.POST("/admin/handling-sessions/{sessionId}/void", {
            params: { path: { sessionId }, header: commandHeaders(key) },
            body,
          }),
      );
    } else {
      throw new Error("Vyberte operaci měření.");
    }
  } catch (cause) {
    actionError.value = errorMessage(cause);
    busy.value = false;
  }
}

watch([selectedOrderId, selectedJobId], () => void loadDetail());
function clearSensitiveView(): void {
  detailEpoch += 1;
  listEpoch += 1;
  readCount.value = 0;
  order.value = null;
  job.value = null;
  artifactLink.value = null;
  orders.value = [];
  jobs.value = [];
  refunds.value = [];
  payments.value = [];
  settlements.value = [];
  timeline.value = [];
  handling.value = [];
  openHandling.value = [];
  actualCosts.value = [];
  activeAction.value = null;
  handlingMode.value = "";
  pendingRetry.value = null;
  pendingTarget.value = "";
}
watch(
  () => session.phase,
  (phase) => {
    if (phase !== "authenticated") clearSensitiveView();
  },
);
onBeforeUnmount(clearSensitiveView);
onMounted(() => {
  void loadLists();
  void loadDetail();
});
</script>

<template>
  <section class="operator-page" aria-labelledby="orders-title">
    <p class="eyebrow">Interní provoz</p>
    <h1 id="orders-title">Objednávky a úlohy</h1>
    <p>
      Stav a povolené kroky se načítají ze serveru. Po změně vždy ověřte
      aktuální stav.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="success" role="status">{{ success }}</p>
    <p v-if="loading" role="status">Načítám aktuální údaje…</p>
    <p v-if="refreshRequired" role="alert">
      Aktuální stav je nutné znovu načíst před další změnou.
    </p>
    <div v-if="pendingRetry" class="operator-alert" role="alert">
      Výsledek předchozího zápisu není jistý. Zachoval se původní obsah i klíč
      požadavku pro bezpečné opakování.
      <button
        type="button"
        :disabled="busy || selectedOrderId !== pendingTarget"
        @click="retryPending"
      >
        Opakovat stejný požadavek
      </button>
      <button type="button" :disabled="loading" @click="loadDetail">
        Znovu načíst serverový stav
      </button>
      <span v-if="selectedOrderId !== pendingTarget">
        Vraťte se k objednávce {{ pendingTarget }}.</span
      >
    </div>
    <div class="operator-actions">
      <button type="button" :disabled="loading || busy" @click="loadLists">
        Obnovit seznamy
      </button>
      <button
        v-if="selectedOrderId"
        type="button"
        :disabled="loading || busy"
        @click="loadDetail"
      >
        Obnovit detail
      </button>
    </div>

    <section class="operator-card" aria-labelledby="order-list-title">
      <h2 id="order-list-title">Objednávky</h2>
      <div class="operator-inline">
        <label>Stav <input v-model.trim="orderStatus" type="text" /></label
        ><button type="button" :disabled="loading" @click="loadLists">
          Filtrovat
        </button>
      </div>
      <ul class="operator-list">
        <li v-for="item in orders" :key="item.id">
          <button type="button" @click="chooseOrder(item.id)">
            {{ item.publicReference }}
          </button>
          {{ item.status }} ·
          {{ formatPragueInstant(item.confirmedAt ?? item.createdAt) }}
        </li>
      </ul>
      <button
        v-if="orderCursor"
        type="button"
        :disabled="loading"
        @click="moreList('orders')"
      >
        Další objednávky
      </button>
    </section>

    <section class="operator-card" aria-labelledby="job-list-title">
      <h2 id="job-list-title">Úlohy</h2>
      <div class="operator-inline">
        <label>Stav <input v-model.trim="jobStatus" type="text" /></label
        ><button type="button" :disabled="loading" @click="loadLists">
          Filtrovat
        </button>
      </div>
      <ul class="operator-list">
        <li v-for="item in jobs" :key="item.id">
          <button type="button" @click="chooseOrder(item.orderId, item.id)">
            Úloha {{ item.id }}
          </button>
          {{ item.status }} · stroj {{ item.machineId }}
        </li>
      </ul>
      <button
        v-if="jobCursor"
        type="button"
        :disabled="loading"
        @click="moreList('jobs')"
      >
        Další úlohy
      </button>
    </section>

    <template v-if="order">
      <section class="operator-card" aria-labelledby="order-detail-title">
        <h2 id="order-detail-title">
          {{ order.publicReference }} · {{ order.status }}
        </h2>
        <p>
          ID: {{ order.id }} · potvrzeno
          {{ formatPragueInstant(order.confirmedAt) }}
        </p>
        <div
          v-if="
            order.blockingCodes.length || order.financial.blockingCodes.length
          "
          class="operator-alert"
          role="alert"
        >
          <strong>Nevyřešené překážky</strong>
          <ul>
            <li
              v-for="code in [
                ...new Set([
                  ...order.blockingCodes,
                  ...order.financial.blockingCodes,
                ]),
              ]"
              :key="code"
            >
              {{ code }}
            </li>
          </ul>
        </div>
        <p>
          Neuhrazená kompenzace:
          {{ formatCzkMinor(order.financial.outstandingCompensationMinor) }}.
          Stav platby sám o sobě nepotvrzuje úhradu zakázky ani dokončení
          náhrady.
        </p>
        <h3>Přijatá cena a podmínky</h3>
        <p v-if="order.acceptedPrice">
          Celkem {{ formatCzkMinor(order.acceptedPrice.contractTotalMinor) }} ·
          revize ceníku {{ order.acceptedPrice.priceListRevision }} · vazba
          {{ order.acceptedPrice.bindingId }}
        </p>
        <p v-else>Přijatá cena není k dispozici.</p>
        <p>
          Podmínky: {{ order.acceptedTermsRevision ?? "Není k dispozici" }} ·
          reklamační pravidla:
          {{ order.acceptedClaimPolicyRevision ?? "Není k dispozici" }}
        </p>
        <ul class="operator-list">
          <li v-for="item in order.legalAcceptances" :key="item.revisionId">
            {{ item.purpose }} · {{ item.revisionCode ?? item.revisionId }} ·
            {{ formatPragueInstant(item.acceptedAt) }}
          </li>
        </ul>
        <h3>Složky ceny a přiřazení</h3>
        <ul v-if="order.acceptedPrice" class="operator-list">
          <li
            v-for="component in order.acceptedPrice.components"
            :key="component.id"
          >
            {{ component.kind }} · {{ formatCzkMinor(component.amountMinor) }} ·
            {{ component.scope
            }}<span v-if="component.fulfilmentAllocations.length">
              · sloty:
              {{
                component.fulfilmentAllocations
                  .map(
                    (allocation) =>
                      `${allocation.fulfilmentSlotId}: ${formatCzkMinor(allocation.amountMinor)}`,
                  )
                  .join(", ")
              }}</span
            >
          </li>
        </ul>
        <h3>Položky a modely</h3>
        <ul class="operator-list">
          <li v-for="item in order.items" :key="item.id">
            {{ item.ordinal }}. {{ item.quantity }}× {{ item.material }}
            {{ item.color ?? "" }} · konfigurace
            {{ item.printConfigRevisionId }} · vrstva
            {{ item.printConfig.layerHeightMicrometers }} µm · výplň
            {{ item.printConfig.infillPercent }} % · podpěry
            {{ item.printConfig.supportsEnabled ? "ano" : "ne" }} · brim
            {{ item.printConfig.brimEnabled ? "ano" : "ne" }} · kvalita
            {{ item.printConfig.quality }} · rozměry
            {{ item.geometry.boundsXMicrometers }} ×
            {{ item.geometry.boundsYMicrometers }} ×
            {{ item.geometry.boundsZMicrometers }} µm<br />Zdroj
            {{ item.sourceModelFileId }} · geometrie {{ item.modelGeometryId }}
            <ul>
              <li
                v-for="finding in item.acceptedFindings"
                :key="finding.findingId"
              >
                {{ finding.severity }} {{ finding.code }}: {{ finding.message }}
              </li>
            </ul>
          </li>
        </ul>
        <h3>Plány zásilek a linie slotů</h3>
        <ul class="operator-list">
          <li v-for="plan in order.shipmentPlans" :key="plan.id">
            Plán {{ plan.ordinal }} · {{ plan.category }} · {{ plan.id }} ·
            sloty
            {{ plan.slots.map((slot) => slot.fulfilmentSlotId).join(", ") }}
          </li>
        </ul>
        <ul class="operator-list">
          <li
            v-for="lineage in order.slotLineage"
            :key="lineage.fulfilmentSlotId"
          >
            Slot {{ lineage.fulfilmentSlotId }} · aktuální úloha
            {{ lineage.currentJobId ?? "žádná" }} · linie
            {{ lineage.jobIds.join(" → ") }}
          </li>
        </ul>
      </section>

      <section class="operator-card" aria-labelledby="fulfilment-title">
        <h2 id="fulfilment-title">Výroba, zásilky a nápravy</h2>
        <p>
          Fáze {{ order.fulfilment.phase.status }} ·
          {{ order.fulfilment.phase.id }}
        </p>
        <h3>Úlohy</h3>
        <ul class="operator-list">
          <li v-for="item in allJobs" :key="item.id">
            <button type="button" @click="chooseOrder(order.id, item.id)">
              {{ item.id }}
            </button>
            · {{ item.status }} · plán {{ item.shipmentPlanId }} · nahrazuje
            {{ item.replacesJobId ?? "—" }} · zásilka
            {{ item.shipmentAssignment?.shipmentId ?? "—" }}
          </li>
        </ul>
        <h3>Zásilky</h3>
        <ul class="operator-list">
          <li v-for="item in allShipments" :key="item.id">
            {{ item.id }} · {{ item.status }} · plán {{ item.shipmentPlanId }} ·
            nahrazuje {{ item.replacesShipmentId ?? "—" }} · úlohy
            {{
              item.jobAssignments
                .map((assignment) => assignment.jobId)
                .join(", ") || "žádné"
            }}
            · štítek {{ item.carrierLabelId ?? "—" }}
          </li>
        </ul>
        <h3>Reklamace a náhrady</h3>
        <ul class="operator-list">
          <li v-for="item in allClaims" :key="item.id">
            Reklamace {{ item.id }} · {{ item.status }} · {{ item.reason }} ·
            zásilka {{ item.incidentShipmentId ?? "—" }}
          </li>
          <li v-for="item in allReplacementRequests" :key="item.id">
            Náhrada {{ item.id }} · {{ item.status }} · původní úloha
            {{ item.sourceJobId }} · nová úloha
            {{ item.replacementJobId ?? "—" }}
          </li>
        </ul>
      </section>

      <section
        v-if="job"
        class="operator-card"
        aria-labelledby="job-detail-title"
      >
        <h2 id="job-detail-title">Úloha {{ job.id }} · {{ job.status }}</h2>
        <p>
          Plán {{ job.shipmentPlanOrdinal }} · stroj
          {{ job.estimate.machineId }} · sklad {{ job.estimate.inventoryId }} ·
          montáž {{ job.estimate.inventoryMountStatus }}
        </p>
        <p>
          Odhad {{ job.estimate.requiredMaterialMilligrams }} mg /
          {{ job.estimate.requiredMachineSeconds }} s · termín
          {{ job.deadline.date ?? "není slíben" }} ({{
            job.deadline.provenance ?? "bez podkladu"
          }})
        </p>
        <ul class="operator-list">
          <li v-for="slot in job.slots" :key="slot.fulfilmentSlotId">
            Slot {{ slot.fulfilmentSlotId }} · {{ slot.material }}
            {{ slot.color ?? "" }} · {{ slot.boundsXMicrometers }} ×
            {{ slot.boundsYMicrometers }} × {{ slot.boundsZMicrometers }} µm ·
            přijatá rizika
            {{
              slot.acceptedRisks.map((risk) => risk.code).join(", ") || "žádná"
            }}
          </li>
        </ul>
        <div class="operator-actions">
          <button
            v-for="kind in ['SOURCE_MODEL', 'PREVIEW', 'PRODUCTION'] as const"
            :key="kind"
            type="button"
            :disabled="
              !(kind === 'SOURCE_MODEL'
                ? job.artifacts.sourceModel.available
                : kind === 'PREVIEW'
                  ? job.artifacts.preview.available
                  : job.artifacts.production.available)
            "
            @click="download(kind)"
          >
            Stáhnout {{ kind }}
          </button>
        </div>
        <p v-if="artifactLink">
          <a :href="artifactLink.url" target="_blank" rel="noopener noreferrer"
            >Otevřít {{ artifactLink.kind }} soubor</a
          >
          · odkaz vyprší {{ formatPragueInstant(artifactLink.expiresAt) }}
        </p>
      </section>

      <section class="operator-card" aria-labelledby="financial-title">
        <h2 id="financial-title">Platby, vrácení a vyrovnání</h2>
        <ul class="operator-list">
          <li v-for="payment in payments" :key="payment.id">
            Platba {{ payment.id }} · {{ payment.role }} ·
            {{ payment.status }} ·
            {{ formatCzkMinor(payment.requestedAmountMinor) }} ·
            {{ payment.provider }} · zachyceno
            {{ formatPragueInstant(payment.capturedAt) }}
          </li>
        </ul>
        <button v-if="paymentCursor" type="button" @click="morePayments">
          Další platby
        </button>
        <ul class="operator-list">
          <li v-for="refund in refunds" :key="refund.id">
            <strong>Vrácení {{ refund.id }} · {{ refund.status }}</strong> ·
            {{ formatCzkMinor(refund.amountMinor) }} · dispatch
            {{ refund.dispatchStatus ?? "bez záznamu" }} · zdroj
            {{ refund.selectedResultSource ?? "bez konečného výsledku" }} ·
            konečný výsledek {{ refund.selectedResultKind ?? "neznámý" }} ·
            nahrazuje {{ refund.replacesRefundTransactionId ?? "—" }} ·
            následníci {{ refund.replacementRefundIds.join(", ") || "žádní"
            }}<span v-if="['FAILED', 'SUSPENDED'].includes(refund.status)">
              · <strong>Finanční incident vyžaduje ověření.</strong></span
            >
          </li>
        </ul>
        <button v-if="refundCursor" type="button" @click="moreRefunds">
          Další vrácení
        </button>
        <ul class="operator-list">
          <li v-for="settlement in settlements" :key="settlement.id">
            Vyrovnání {{ settlement.kind }} ·
            {{ formatCzkMinor(settlement.amountDueMinor) }} ·
            {{ formatPragueInstant(settlement.settledAt) }}
          </li>
        </ul>
        <button v-if="settlementCursor" type="button" @click="moreSettlements">
          Další vyrovnání
        </button>
      </section>

      <section class="operator-card" aria-labelledby="history-title">
        <h2 id="history-title">Historie a audit</h2>
        <ul class="operator-list">
          <li v-for="event in timeline" :key="event.id">
            {{ formatPragueInstant(event.occurredAt) }} ·
            {{ event.eventType }} · {{ event.actorKind }} ·
            {{ event.reason ?? "" }}
          </li>
        </ul>
        <button
          v-if="timelineCursor"
          type="button"
          :disabled="loading"
          @click="moreTimeline"
        >
          Starší záznamy
        </button>
        <h3>Úplná historie pokračování</h3>
        <div
          v-for="kind in [
            'jobs',
            'shipments',
            'slots',
            'replacementRequests',
            'claims',
            'priceAdjustments',
          ] as const"
          :key="kind"
        >
          <h4>{{ kind }}</h4>
          <ul class="operator-list">
            <li v-for="item in history[kind] ?? []" :key="item.id">
              {{ lineageSummary(item) }}
            </li>
          </ul>
          <button
            v-if="historyCursors[kind]"
            type="button"
            :disabled="loading"
            @click="moreHistory(kind)"
          >
            Další {{ kind }}
          </button>
        </div>
        <div v-for="claim in allClaims" :key="claim.id">
          <h4>Navazující historie reklamace {{ claim.id }}</h4>
          <div
            v-for="kind in [
              'resolutions',
              'refunds',
              'reshipmentAuthorizations',
            ] as const"
            :key="kind"
          >
            <ul class="operator-list">
              <li
                v-for="item in childHistory[`${claim.id}:${kind}`] ?? []"
                :key="item.id"
              >
                {{ lineageSummary(item) }}
              </li>
            </ul>
            <button
              v-if="childNextCursor(claim.id, kind)"
              type="button"
              :disabled="loading"
              @click="moreChildHistory(claim.id, kind)"
            >
              Další {{ kind }}
            </button>
          </div>
        </div>
      </section>
      <section class="operator-card" aria-labelledby="handling-title">
        <h2 id="handling-title">Měřená práce a skutečné náklady</h2>
        <h3>Běžící relace na uzlu</h3>
        <ul class="operator-list">
          <li v-for="item in openHandling" :key="item.id">
            {{ item.component }} · od
            {{ formatPragueInstant(item.startedAt) }} · {{ item.id }}
            <button
              v-if="
                canOperate &&
                item.operatorIdentityId === session.value?.operator.operatorId
              "
              type="button"
              @click="openHandlingForm('stop', item.id)"
            >
              Zastavit a přiřadit
            </button>
          </li>
        </ul>
        <button
          v-if="openHandlingCursor"
          type="button"
          :disabled="loading"
          @click="moreOpenHandling"
        >
          Další běžící relace
        </button>
        <h3>Relace přiřazené objednávce</h3>
        <ul class="operator-list">
          <li v-for="item in handling" :key="item.id">
            {{ item.component }} · {{ item.lifecycle }} ·
            {{ formatPragueInstant(item.startedAt) }} ·
            {{ item.durationMilliseconds ?? "běží" }} ms ·
            {{ formatCzkMinor(item.totalCostMinor) }} · {{ item.id
            }}<button
              v-if="isAdmin && item.lifecycle === 'COMPLETED'"
              type="button"
              @click="openHandlingForm('void', item.id)"
            >
              Zneplatnit
            </button>
            <ul>
              <li v-for="allocation in item.allocations" :key="allocation.id">
                {{ allocation.targetKey }} ·
                {{ allocation.servedUnitCount }} jednotek ·
                {{ formatCzkMinor(allocation.allocatedCostMinor) }}
              </li>
              <li
                v-for="allocation in allocationPages[item.id] ?? []"
                :key="allocation.id"
              >
                {{ allocation.targetKey }} ·
                {{ allocation.servedUnitCount }} jednotek ·
                {{ formatCzkMinor(allocation.allocatedCostMinor) }}
              </li>
            </ul>
            <button
              v-if="nextAllocationCursor(item)"
              type="button"
              :disabled="loading"
              @click="moreAllocations(item)"
            >
              Další přiřazení
            </button>
          </li>
        </ul>
        <button
          v-if="handlingCursor"
          type="button"
          :disabled="loading"
          @click="moreHandling"
        >
          Další záznamy práce
        </button>
        <div v-if="canOperate" class="operator-actions">
          <button type="button" @click="openHandlingForm('start')">
            Spustit měření</button
          ><button type="button" @click="openHandlingForm('manual')">
            Ruční záznam práce/cesty
          </button>
        </div>
        <form
          v-if="handlingMode && canOperate"
          class="operator-form"
          @submit.prevent="submitHandling"
        >
          <h3>
            {{
              handlingMode === "start"
                ? "Spustit měření"
                : handlingMode === "stop"
                  ? "Zastavit a přiřadit"
                  : handlingMode === "manual"
                    ? "Ruční záznam"
                    : "Zneplatnit záznam"
            }}
          </h3>
          <p v-if="actionError" role="alert">{{ actionError }}</p>
          <label v-if="handlingMode === 'start' || handlingMode === 'manual'"
            >Složka
            <select v-model="handlingComponent">
              <option
                v-for="value in [
                  'HANDLING_ORDER_FIX',
                  'HANDLING_PLATE',
                  'HANDLING_PIECE',
                  'HANDLING_PACK',
                  'SHIPPING_TRIP',
                  'POSTPROCESSING_ITEM',
                ]"
                :key="value"
              >
                {{ value }}
              </option>
            </select></label
          >
          <template v-if="handlingMode === 'manual'"
            ><label
              >Začátek s pásmem
              <input
                v-model.trim="handlingStartedAt"
                placeholder="2026-09-25T10:00:00+02:00"
                required /></label
            ><label
              >Konec s pásmem
              <input
                v-model.trim="handlingEndedAt"
                placeholder="2026-09-25T10:30:00+02:00"
                required /></label
            ><label
              >Trvání (ms)
              <input
                v-model.trim="handlingDuration"
                inputmode="numeric"
                required /></label
          ></template>
          <label v-if="handlingMode === 'manual' || handlingMode === 'void'"
            >Důvod <textarea v-model.trim="reason" rows="2" required />
          </label>
          <template v-if="handlingMode === 'stop' || handlingMode === 'manual'"
            ><fieldset>
              <legend>
                Přiřazení měřené práce; cesta může zahrnovat více objednávek
              </legend>
              <div
                v-for="(allocation, index) in handlingAllocations"
                :key="index"
                class="operator-form"
              >
                <label
                  >Objednávka
                  <select v-model="allocation.orderId" required>
                    <option
                      v-if="!orders.some((item) => item.id === selectedOrderId)"
                      :value="selectedOrderId"
                    >
                      {{ order.publicReference }}
                    </option>
                    <option
                      v-for="item in orders"
                      :key="item.id"
                      :value="item.id"
                    >
                      {{ item.publicReference }}
                    </option>
                  </select></label
                ><label
                  >Počet obsloužených jednotek
                  <input
                    v-model.trim="allocation.servedUnitCount"
                    inputmode="numeric"
                    required /></label
                ><label
                  >Úloha
                  <select v-model="allocation.jobId">
                    <option value="">Bez úlohy</option>
                    <option
                      v-for="item in allJobs"
                      :key="item.id"
                      :value="item.id"
                    >
                      {{ item.id }}
                    </option>
                  </select></label
                ><label
                  >Zásilka
                  <select v-model="allocation.shipmentId">
                    <option value="">Bez zásilky</option>
                    <option
                      v-for="item in allShipments"
                      :key="item.id"
                      :value="item.id"
                    >
                      {{ item.id }}
                    </option>
                  </select></label
                ><label
                  >Položka
                  <select v-model="allocation.orderItemId">
                    <option value="">Bez položky</option>
                    <option
                      v-for="item in order.items"
                      :key="item.id"
                      :value="item.id"
                    >
                      {{ item.ordinal }} · {{ item.id }}
                    </option>
                  </select></label
                ><label v-if="handlingComponent === 'POSTPROCESSING_ITEM'"
                  >Fáze
                  <input
                    v-model.trim="allocation.orderPhaseId"
                    :placeholder="order.fulfilment.phase.id"
                    required /></label
                ><button
                  type="button"
                  @click="handlingAllocations.splice(index, 1)"
                >
                  Odebrat
                </button>
              </div>
              <button
                type="button"
                @click="
                  handlingAllocations.push({
                    orderId: order.id,
                    servedUnitCount: '1',
                  })
                "
              >
                Přidat objednávku
              </button>
            </fieldset></template
          >
          <label v-if="handlingMode === 'void'"
            ><input v-model="confirmed" type="checkbox" required /> Potvrzuji
            zneplatnění zachovaného záznamu.</label
          >
          <div class="operator-actions">
            <button type="submit" :disabled="busy || !!pendingRetry">
              Potvrdit</button
            ><button type="button" :disabled="busy" @click="handlingMode = ''">
              Zavřít
            </button>
          </div>
        </form>
        <h3>Skutečné náklady</h3>
        <p v-if="!canSeeCosts">
          Zobrazení nákladů vyžaduje finanční oprávnění.
        </p>
        <ul v-else class="operator-list">
          <li v-for="item in actualCosts" :key="item.id">
            {{ item.category }} · {{ formatCzkMinor(item.amountMinor) }} ·
            {{ item.id }} · {{ item.isCurrent ? "platný záznam" : "nahrazeno" }}
          </li>
        </ul>
        <button
          v-if="costCursor"
          type="button"
          :disabled="loading"
          @click="moreCosts"
        >
          Další náklady
        </button>
      </section>

      <section class="operator-card" aria-labelledby="actions-title">
        <h2 id="actions-title">Další kroky</h2>
        <ul class="operator-list">
          <li
            v-for="action in actions"
            :key="`${action.action}:${action.targetId}`"
          >
            <button
              type="button"
              :disabled="
                busy ||
                !!pendingRetry ||
                refreshRequired ||
                !actionCanOpen(action)
              "
              @click="openAction(action)"
            >
              {{ actionLabel(action.action) }}
            </button>
            <small
              >{{ action.targetType }} {{ action.targetId }}
              <span v-if="action.blockingCodes.length"
                >· překážky: {{ action.blockingCodes.join(", ") }}</span
              ></small
            >
            <span v-if="action.action === 'PREPARE_REPLACEMENT'">
              · čeká na #259</span
            >
          </li>
        </ul>
      </section>

      <section
        v-if="activeAction"
        class="operator-card"
        aria-labelledby="command-title"
      >
        <h2 id="command-title">{{ actionLabel(activeAction.action) }}</h2>
        <p>
          Cíl {{ activeAction.targetType }} {{ activeAction.targetId }}. Před
          potvrzením zkontrolujte aktuální stav a podklady.
        </p>
        <p v-if="actionError" role="alert">{{ actionError }}</p>
        <div v-if="pendingRetry" class="operator-actions">
          <button type="button" :disabled="busy" @click="retryPending">
            Opakovat přesně původní požadavek</button
          ><button type="button" :disabled="busy" @click="loadDetail">
            Obnovit stav bez opakování
          </button>
        </div>
        <form v-else class="operator-form" @submit.prevent="submitAction">
          <label
            v-if="
              activeAction.requiresReason ||
              [
                'SUBMIT_QC',
                'CREATE_LABEL',
                'CONFIRM_LABEL_VOID',
                'HANDOFF_SHIPMENT',
                'RECORD_DELIVERY_EVENT',
                'REFUND_ADJUSTMENT',
                'REFUND_CLAIM',
                'REJECT_CLAIM',
                'WITHDRAW_CLAIM',
                'CREATE_CLAIM',
                'CREATE_PRICE_ADJUSTMENT',
              ].includes(activeAction.action)
            "
            >Důvod <textarea v-model.trim="reason" rows="3" required />
          </label>
          <template
            v-if="
              activeAction.action === 'FINISH_PRINTING' ||
              activeAction.action === 'FAIL_JOB'
            "
            ><label
              >Skutečná spotřeba materiálu (mg)
              <input
                v-model.trim="material"
                inputmode="numeric"
                :required="activeAction.action === 'FINISH_PRINTING'" /></label
          ></template>
          <template v-if="activeAction.action === 'FAIL_JOB'"
            ><label
              >Fáze
              <select v-model="stage">
                <option
                  v-for="value in [
                    'PREPARATION',
                    'GCODE',
                    'MACHINE',
                    'PRINTING',
                    'POST_PRINT',
                    'POST_QC',
                    'PACKING',
                  ]"
                  :key="value"
                >
                  {{ value }}
                </option>
              </select></label
            ><label
              >Náprava
              <select v-model="recovery">
                <option value="REPLACE">Náhrada</option>
                <option value="REFUND">Vrácení</option>
              </select></label
            ></template
          >
          <template
            v-if="
              ['CANCEL_ORDER', 'FAIL_JOB', 'EXPIRE_REPLACEMENT'].includes(
                activeAction.action,
              )
            "
            ><label
              v-for="item in allJobs.filter(
                (candidate) => candidate.status === 'PRINTING',
              )"
              :key="item.id"
              >Skutečná spotřeba běžící úlohy {{ item.id }} (mg)
              <input
                v-model.trim="printingConsumptions[item.id]"
                inputmode="numeric"
                required /></label
          ></template>
          <label v-if="activeAction.action === 'PACK_JOB'"
            >Zásilka stejného plánu
            <select v-model="shipmentId" required>
              <option value="">Vyberte</option>
              <option
                v-for="item in allShipments.filter(
                  (candidate) =>
                    candidate.shipmentPlanId === currentJob?.shipmentPlanId &&
                    ['PLANNED', 'LABEL_CREATED'].includes(candidate.status),
                )"
                :key="item.id"
                :value="item.id"
              >
                {{ item.id }} · {{ item.status }}
              </option>
            </select></label
          >
          <label
            v-if="
              activeAction.action === 'CREATE_SHIPMENT' &&
              allShipments.some(
                (item) => item.shipmentPlanId === activeAction?.targetId,
              )
            "
            >Nahrazovaná zásilka
            <select v-model="shipmentId" required>
              <option value="">Vyberte</option>
              <option
                v-for="item in allShipments.filter(
                  (candidate) =>
                    candidate.shipmentPlanId === activeAction?.targetId,
                )"
                :key="item.id"
                :value="item.id"
              >
                {{ item.id }} · {{ item.status }}
              </option>
            </select></label
          >
          <template v-if="activeAction.action === 'CREATE_LABEL'"
            ><label>Dopravce <input v-model.trim="carrier" required /></label
            ><label
              >ID štítku <input v-model.trim="carrierLabelId" required /></label
            ><label
              >ID zásilky u dopravce
              <input v-model.trim="providerShipmentId" required /></label
            ><label>Tracking kód <input v-model.trim="trackingCode" /></label
          ></template>
          <template
            v-if="
              [
                'CONFIRM_LABEL_VOID',
                'HANDOFF_SHIPMENT',
                'RECORD_DELIVERY_EVENT',
              ].includes(activeAction.action)
            "
            ><label
              >Čas události včetně pásma
              <input
                v-model.trim="occurredAt"
                placeholder="2026-09-25T10:00:00+02:00"
                required /></label
            ><label
              >ID události dopravce
              <input v-model.trim="providerEventId" required /></label
            ><label
              >ID transakce dopravce
              <input v-model.trim="providerTransactionId" required /></label
          ></template>
          <label v-if="activeAction.action === 'RECORD_DELIVERY_EVENT'"
            >Událost
            <select v-model="shipmentEventKind">
              <option
                v-for="value in [
                  'TRANSIT_SCAN',
                  'DELIVERY_SCAN',
                  'LOST',
                  'RETURNED',
                  'RECOVERED',
                ]"
                :key="value"
              >
                {{ value }}
              </option>
            </select></label
          >
          <label v-if="activeAction.action === 'CREATE_BALANCE_PAYMENT'"
            >Metoda
            <select v-model="checkoutMethod">
              <option value="CARD">Karta</option>
              <option value="BANK_TRANSFER">Převod</option>
            </select></label
          >
          <template v-if="activeAction.action === 'CREATE_CLAIM'"
            ><label
              >Původ
              <select v-model="claimOrigin">
                <option value="SHIPMENT_INCIDENT">Událost zásilky</option>
                <option value="POST_DELIVERY_QUALITY">
                  Kvalita po doručení
                </option>
              </select></label
            ><label
              >Dotčená zásilka
              <select v-model="selectedIncidentShipment">
                <option value="">Bez zásilky</option>
                <option
                  v-for="item in allShipments"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.id }}
                </option>
              </select></label
            >
            <fieldset>
              <legend>Dotčené sloty</legend>
              <label v-for="item in allSlots" :key="item.id"
                ><input
                  v-model="selectedSlots"
                  type="checkbox"
                  :value="item.id"
                />
                {{ item.id }}</label
              >
            </fieldset></template
          >
          <template v-if="activeAction.action === 'CREATE_PRICE_ADJUSTMENT'"
            ><label
              >Důvod úpravy
              <select v-model="adjustmentReason">
                <option
                  v-for="value in [
                    'EXPRESS_BREACH',
                    'PRODUCTION_FAILURE',
                    'SHIPMENT_INCIDENT',
                    'POST_DELIVERY_ISSUE',
                  ]"
                  :key="value"
                >
                  {{ value }}
                </option>
              </select></label
            ><label
              >Částka (haléře)
              <input
                v-model.trim="amount"
                inputmode="numeric"
                required /></label
            ><label
              >Platba
              <select v-model="selectedPayment">
                <option value="">Podle závazku</option>
                <option
                  v-for="item in payments"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.id }} · {{ item.status }}
                </option>
              </select></label
            >
            <fieldset>
              <legend>
                Přiřazení kreditu ke slotům (mimo expresní úpravu povinné)
              </legend>
              <label v-for="item in allSlots" :key="item.id"
                >{{ item.id }}
                <input v-model.trim="slotCredits[item.id]" inputmode="numeric"
              /></label></fieldset
          ></template>
          <template
            v-if="
              activeAction.action === 'RECORD_REFUND_PROVIDER_RESULT' &&
              currentRefund
            "
            ><p>
              Ověřované vrácení {{ currentRefund.id }} ·
              {{ formatCzkMinor(currentRefund.amountMinor) }} ·
              {{ currentRefund.currency }} · {{ currentRefund.status }}.
              Požadavek {{ currentRefund.requestReference }} · původní platební
              lokátor
              {{ currentRefund.providerIntentId ?? "není k dispozici" }}.
            </p>
            <p>
              Ověřte účet a prostředí poskytovatele. Chybějící záznam v portálu,
              timeout ani neúspěšný outbox nejsou důkaz selhání.
            </p>
            <label
              >Zdroj konečného výsledku
              <select v-model="evidenceKind">
                <option value="PROVIDER_PORTAL">Portál poskytovatele</option>
                <option value="PROVIDER_SUPPORT">Podpora poskytovatele</option>
              </select></label
            ><label
              >Číslo případu nebo reference důkazu (bez URL či tajných údajů)
              <input v-model.trim="evidenceReference" required /></label
            ><label
              >Výsledek
              <select v-model="outcome">
                <option value="FAILED">Selhalo</option>
                <option value="SUCCEEDED">Uspělo</option>
              </select></label
            ><label
              >Čas výsledku včetně pásma
              <input
                v-model.trim="occurredAt"
                placeholder="2026-09-25T10:00:00+02:00"
                required /></label
            ><label
              >Referenční ID vrácení u poskytovatele
              <input v-model.trim="providerRefundReference" /></label
            ><label
              ><input
                v-model="finalOutcomeConfirmed"
                type="checkbox"
                required
              />
              Ověřil(a) jsem konečný výsledek u poskytovatele; jde o moje
              potvrzení, ne ověření API.</label
            ></template
          >
          <p v-if="activeAction.action === 'RETRY_REFUND' && currentRefund">
            Selhání
            {{ currentRefund.providerResultEventId ?? "bez potvrzení" }} · počet
            náhrad {{ currentRefund.replacementRefundIds.length }}. Nový pokus
            může převést peníze právě jednou.
          </p>
          <label v-if="activeAction.requiresConfirmation"
            ><input v-model="confirmed" type="checkbox" required /> Potvrzuji
            dopad této výjimečné změny po kontrole aktuálního stavu.</label
          >
          <div class="operator-actions">
            <button type="submit" :disabled="!selectedActionEnabled || busy">
              {{ busy ? "Odesílám…" : "Potvrdit krok" }}</button
            ><button
              type="button"
              :disabled="busy"
              @click="activeAction = null"
            >
              Zrušit formulář
            </button>
          </div>
        </form>
      </section>
    </template>
  </section>
</template>
