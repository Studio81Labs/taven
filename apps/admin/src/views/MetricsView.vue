<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import { computed, onMounted, ref, watch } from "vue";
import { apiClient } from "../api";
import { formatCzkMinor, formatPragueInstant } from "../format";
import {
  currentPragueMonth,
  money,
  moneyRatio,
  pragueMidnight,
  ratio,
} from "../metrics-format";
import {
  commandHeaders,
  CommandJournal,
  errorMessage,
  isoFromZonedInput,
  requireData,
} from "../operator-requests";
import { hasPermission, session } from "../session";

type S = components["schemas"];
type Channel = "direct" | "organic" | "paid" | "referral" | "unknown" | "";
const canWrite = computed(() => hasPermission("financial:exception"));
const nodeId = computed(() => session.value?.operator.nodeIds[0] ?? "");
const month = ref(currentPragueMonth());
const fromDate = ref(`${month.value}-01`);
const currentYear = Number(month.value.slice(0, 4));
const currentMonth = Number(month.value.slice(5, 7));
const toDate = ref(
  new Date(Date.UTC(currentYear, currentMonth, 1)).toISOString().slice(0, 10),
);
const channel = ref<Channel>("");
const report = ref<S["MetricsReportDto"] | null>(null);
const orders = ref<S["MetricsOrderDetailDto"][]>([]);
const orderCursor = ref<string | null>(null);
const appliedQuery = ref<ReturnType<typeof filters> | null>(null);
let reportReadGeneration = 0;
const warnings = ref<S["OperatorWarningsReportDto"] | null>(null);
const spend = ref<S["AcquisitionSpendEvidenceDto"][]>([]);
const spendCursor = ref<string | null>(null);
const actualCosts = ref<S["ActualCostEvidenceDto"][]>([]);
const actualCursor = ref<string | null>(null);
const orderId = ref("");
const costOrderId = ref("");
let costReadGeneration = 0;
const error = ref("");
const success = ref("");
const loading = ref(false);
const busy = ref(false);
const entry = ref<"cost" | "spend" | "">("");
const amountMinor = ref("");
const category = ref<S["RecordActualCostDto"]["category"]>("MATERIAL");
const evidenceChannel = ref<S["RecordAcquisitionSpendDto"]["channel"]>("PAID");
const source = ref<S["RecordActualCostDto"]["source"]>("MANUAL");
const sourceEntityType = ref("MANUAL");
const sourceKey = ref("");
const sourceEntityId = ref("");
const occurredAt = ref(new Date().toISOString());
const periodStart = ref(new Date().toISOString());
const periodEnd = ref(new Date(Date.now() + 86_400_000).toISOString());
const supersedesId = ref("");
const reason = ref("");
const journal = new CommandJournal();
watch(
  orderId,
  () => {
    costReadGeneration += 1;
    actualCosts.value = [];
    actualCursor.value = null;
    costOrderId.value = "";
    if (entry.value === "cost") supersedesId.value = "";
  },
  { flush: "sync" },
);
const priceBands: readonly [keyof S["PriceBandConversionBandsDto"], string][] =
  [
    ["under_25000", "Pod 250 Kč"],
    ["25000_to_49999", "250–499 Kč"],
    ["50000_to_99999", "500–999 Kč"],
    ["100000_to_199999", "1 000–1 999 Kč"],
    ["200000_or_more", "2 000 Kč a více"],
  ];

function oneMonth(): void {
  const [year, monthNumber] = month.value.split("-").map(Number);
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) return;
  fromDate.value = `${year}-${String(monthNumber).padStart(2, "0")}-01`;
  toDate.value = new Date(Date.UTC(year, monthNumber, 1))
    .toISOString()
    .slice(0, 10);
}

function filters(): {
  from: string;
  to: string;
  currency: "CZK";
  nodeId: string;
  channel?: Exclude<Channel, "">;
} {
  const from = pragueMidnight(fromDate.value);
  const to = pragueMidnight(toDate.value);
  if (from >= to) throw new Error("Konec období musí být později než začátek.");
  return {
    from,
    to,
    currency: "CZK",
    nodeId: nodeId.value,
    ...(channel.value ? { channel: channel.value } : {}),
  };
}

async function refresh(): Promise<void> {
  if (!nodeId.value) return;
  const generation = ++reportReadGeneration;
  loading.value = true;
  error.value = "";
  try {
    const query = filters();
    const [metricsResponse, orderResponse, warningsResponse, spendResponse] =
      await Promise.all([
        apiClient.GET("/admin/metrics", { params: { query } }),
        apiClient.GET("/admin/metrics/orders", {
          params: { query: { ...query, limit: 50 } },
        }),
        apiClient.GET("/admin/warnings", { params: { query: { limit: 100 } } }),
        apiClient.GET("/admin/acquisition-spend", {
          params: { query: { limit: 100 } },
        }),
      ]);
    const nextReport = requireData(metricsResponse);
    const page = requireData(orderResponse);
    const nextWarnings = requireData(warningsResponse);
    const spendPage = requireData(spendResponse);
    if (generation !== reportReadGeneration) return;
    report.value = nextReport;
    orders.value = page.items;
    orderCursor.value = page.nextCursor ?? null;
    appliedQuery.value = query;
    warnings.value = nextWarnings;
    spend.value = spendPage.items;
    spendCursor.value = spendPage.nextCursor ?? null;
    if (orderId.value) await loadCosts();
  } catch (cause) {
    if (generation === reportReadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === reportReadGeneration) loading.value = false;
  }
}

async function moreOrders(): Promise<void> {
  if (!orderCursor.value || !appliedQuery.value || loading.value) return;
  const generation = reportReadGeneration;
  const cursor = orderCursor.value;
  const query = appliedQuery.value;
  try {
    const page = requireData(
      await apiClient.GET("/admin/metrics/orders", {
        params: {
          query: { ...query, cursor, limit: 50 },
        },
      }),
    );
    if (generation !== reportReadGeneration) return;
    orders.value = [...orders.value, ...page.items];
    orderCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    if (generation === reportReadGeneration) error.value = errorMessage(cause);
  }
}

async function loadCosts(): Promise<void> {
  if (!orderId.value) return;
  const id = orderId.value;
  const generation = ++costReadGeneration;
  actualCosts.value = [];
  actualCursor.value = null;
  costOrderId.value = "";
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/actual-costs", {
        params: { path: { orderId: id }, query: { limit: 100 } },
      }),
    );
    if (generation !== costReadGeneration || id !== orderId.value) return;
    actualCosts.value = page.items;
    actualCursor.value = page.nextCursor ?? null;
    costOrderId.value = id;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function moreCosts(): Promise<void> {
  if (
    !actualCursor.value ||
    !orderId.value ||
    costOrderId.value !== orderId.value
  )
    return;
  const id = orderId.value;
  try {
    const page = requireData(
      await apiClient.GET("/admin/orders/{orderId}/actual-costs", {
        params: {
          path: { orderId: id },
          query: { limit: 100, cursor: actualCursor.value },
        },
      }),
    );
    if (id !== orderId.value) return;
    actualCosts.value = [...actualCosts.value, ...page.items];
    actualCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function moreSpend(): Promise<void> {
  if (!spendCursor.value) return;
  try {
    const page = requireData(
      await apiClient.GET("/admin/acquisition-spend", {
        params: { query: { limit: 100, cursor: spendCursor.value } },
      }),
    );
    spend.value = [...spend.value, ...page.items];
    spendCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function recordEvidence(): Promise<void> {
  if (!canWrite.value || busy.value) return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    if (entry.value === "cost") {
      if (!orderId.value) throw new Error("Vyberte objednávku.");
      const id = orderId.value;
      const body: S["RecordActualCostDto"] = {
        amountMinor: amountMinor.value,
        category: category.value,
        currency: "CZK",
        occurredAt: isoFromZonedInput(occurredAt.value),
        source: source.value,
        sourceEntityType: sourceEntityType.value.trim(),
        sourceKey: sourceKey.value.trim(),
        ...(sourceEntityId.value.trim()
          ? { sourceEntityId: sourceEntityId.value.trim() }
          : {}),
        ...(supersedesId.value ? { supersedesId: supersedesId.value } : {}),
        ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
      };
      await journal.submit(
        `order:${id}:actual-cost`,
        body,
        async (frozen, key) =>
          requireData(
            await apiClient.POST("/admin/orders/{orderId}/actual-costs", {
              params: {
                path: { orderId: id },
                header: commandHeaders(key),
              },
              body: frozen,
            }),
          ),
      );
      await loadCosts();
    } else if (entry.value === "spend") {
      const body: S["RecordAcquisitionSpendDto"] = {
        amountMinor: amountMinor.value,
        channel: evidenceChannel.value,
        currency: "CZK",
        periodStart: isoFromZonedInput(periodStart.value),
        periodEnd: isoFromZonedInput(periodEnd.value),
        sourceEntityType: sourceEntityType.value.trim(),
        sourceKey: sourceKey.value.trim(),
        ...(supersedesId.value ? { supersedesId: supersedesId.value } : {}),
        ...(reason.value.trim() ? { reason: reason.value.trim() } : {}),
      };
      await journal.submit("acquisition-spend", body, async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/acquisition-spend", {
            params: { header: commandHeaders(key) },
            body: frozen,
          }),
        ),
      );
    } else return;
    success.value =
      "Důkaz byl zapsán jako nová verze. Oprava původní záznam nemaže.";
    entry.value = "";
    await refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}

function editEvidence(kind: "cost" | "spend", id = ""): void {
  entry.value = kind;
  supersedesId.value = id;
  reason.value = "";
}

onMounted(() => void refresh());
</script>

<template>
  <section class="operator-page">
    <p class="eyebrow">V0 měření</p>
    <h1>Měření a upozornění</h1>
    <p>
      Komerční hodnoty jsou za platformu, provozní za vybraný uzel. Interval je
      od včetně do bez konce v pražském čase. Impressions a clicks nejsou
      sbírány.
    </p>
    <form class="operator-inline" @submit.prevent="refresh">
      <label>Začátek <input v-model="fromDate" type="date" required /></label>
      <label
        >Konec (bez tohoto dne) <input v-model="toDate" type="date" required
      /></label>
      <label
        >Kanál
        <select v-model="channel">
          <option value="">Všechny</option>
          <option value="direct">direct</option>
          <option value="organic">organic</option>
          <option value="paid">paid</option>
          <option value="referral">referral</option>
          <option value="unknown">unknown</option>
        </select></label
      >
      <button type="submit" :disabled="loading">Načíst report</button>
    </form>
    <div class="operator-inline">
      <label>Měsíční shakedown <input v-model="month" type="month" /></label
      ><button
        type="button"
        :disabled="loading"
        @click="
          oneMonth();
          refresh();
        "
      >
        Použít měsíc</button
      ><span
        >Referenční marketingový výdaj 5 000 Kč je plánovací srovnání, ne
        naměřený spend.</span
      >
    </div>
    <p v-if="loading" role="status">Načítám měření…</p>
    <p v-if="error" role="alert" class="form-error">
      {{ error }}
    </p>
    <p v-if="success" role="status" class="form-success">
      {{ success }}
    </p>

    <template v-if="report">
      <p>
        Vygenerováno {{ formatPragueInstant(report.generatedAt) }} ·
        {{ report.metricDefinition }} · úplnost
        {{ report.completeness.status }} ·
        {{ report.completeness.flags.join(", ") || "bez označených mezer" }}
      </p>
      <p>
        Zdrojové pokrytí: vybrané CZK objednávky
        {{ report.sourceCoverage.selectedCurrencyOrders }}, vyloučené jiné měny
        {{ report.sourceCoverage.excludedCurrencyOrders }}; historický backfill
        {{ report.sourceCoverage.businessEvents.historicalBackfill }}.
      </p>
      <section class="operator-card">
        <h2>Funnel a objednávky · v0-1</h2>
        <p>Definice: {{ report.commercial.funnel.definition }}</p>
        <dl class="metric-grid">
          <div>
            <dt>Uploady</dt>
            <dd>{{ report.commercial.funnel.uploads }}</dd>
          </div>
          <div>
            <dt>Zobrazení automatické ceny</dt>
            <dd>
              {{ report.commercial.funnel.automaticBindingPriceQuoteViews }}
            </dd>
          </div>
          <div>
            <dt>Začátky checkoutu</dt>
            <dd>{{ report.commercial.funnel.checkoutStarts }}</dd>
          </div>
          <div>
            <dt>Potvrzené objednávky</dt>
            <dd>{{ report.commercial.funnel.confirmedOrders }}</dd>
          </div>
          <div>
            <dt>Impressions / clicks</dt>
            <dd>nesbíráno / nesbíráno</dd>
          </div>
          <div>
            <dt>Quote → paid</dt>
            <dd>{{ ratio(report.commercial.quoteToPaid.conversion) }}</dd>
          </div>
          <div>
            <dt>Automatizace</dt>
            <dd>{{ ratio(report.commercial.automationShare.value) }}</dd>
          </div>
          <div>
            <dt>Express share</dt>
            <dd>{{ ratio(report.commercial.orders.express) }}</dd>
          </div>
        </dl>
        <p>
          v0-1 preflight: klasifikace podle aktuálních rozhodnutí objednávky.
          Automatické nabídky: čisté
          {{ report.commercial.quoteToPaid.automatic.preflight.clean }},
          varování
          {{ report.commercial.quoteToPaid.automatic.preflight.warning }},
          neznámé
          {{ report.commercial.quoteToPaid.automatic.preflight.unknown }}.
        </p>
      </section>

      <section class="operator-card">
        <h2>Konverze podle ceny při vydání · v0-2</h2>
        <p>
          {{ report.commercial.quoteToPaid.priceBandConversion.definition }}.
          Preflight je neměnné vyhodnocení při vzniku cenové vazby. Starší
          automatické vazby bez podporovaného souhrnu a individuální nabídky
          jsou neznámé; zůstávají ve jmenovateli i ve známém cenovém pásmu.
        </p>
        <p>
          Celkem
          {{
            ratio(
              report.commercial.quoteToPaid.priceBandConversion.total
                .conversion,
            )
          }}
          · bez známé ceny
          {{
            report.commercial.quoteToPaid.priceBandConversion.total
              .unavailableGross
          }}
        </p>
        <table class="operator-table">
          <caption>
            Automatické vazby podle preflight
          </caption>
          <thead>
            <tr>
              <th>Pásmo</th>
              <th>Čisté</th>
              <th>Varování</th>
              <th>Neznámé</th>
              <th>Všechny</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[key, label] in priceBands" :key="key">
              <th>{{ label }}</th>
              <td>
                {{
                  ratio(
                    report.commercial.quoteToPaid.priceBandConversion.automatic
                      .preflight.clean.bands[key].conversion,
                  )
                }}
              </td>
              <td>
                {{
                  ratio(
                    report.commercial.quoteToPaid.priceBandConversion.automatic
                      .preflight.warning.bands[key].conversion,
                  )
                }}
              </td>
              <td>
                {{
                  ratio(
                    report.commercial.quoteToPaid.priceBandConversion.automatic
                      .preflight.unknown.bands[key].conversion,
                  )
                }}
              </td>
              <td>
                {{
                  ratio(
                    report.commercial.quoteToPaid.priceBandConversion.automatic
                      .all.bands[key].conversion,
                  )
                }}
              </td>
            </tr>
          </tbody>
        </table>
        <p>
          Neznámé automatické vazby:
          {{
            ratio(
              report.commercial.quoteToPaid.priceBandConversion.automatic
                .preflight.unknown.conversion,
            )
          }}; jejich cena nedostupná:
          {{
            report.commercial.quoteToPaid.priceBandConversion.automatic
              .preflight.unknown.unavailableGross
          }}.
        </p>
        <p>
          Individuální nabídky:
          {{
            ratio(
              report.commercial.quoteToPaid.priceBandConversion.individual.all
                .conversion,
            )
          }}. Preflight u nich není vyhodnocen; neznámé
          {{
            report.commercial.quoteToPaid.priceBandConversion.individual
              .preflight.unknown.issued
          }}.
        </p>
        <table class="operator-table">
          <caption>
            Individuální nabídky podle ceny při vydání
          </caption>
          <thead>
            <tr>
              <th>Pásmo</th>
              <th>Vydané / potvrzené</th>
              <th>Konverze</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="[key, label] in priceBands" :key="key">
              <th>{{ label }}</th>
              <td>
                {{
                  report.commercial.quoteToPaid.priceBandConversion.individual
                    .all.bands[key].issued
                }}
                /
                {{
                  report.commercial.quoteToPaid.priceBandConversion.individual
                    .all.bands[key].confirmedPaid
                }}
              </td>
              <td>
                {{
                  ratio(
                    report.commercial.quoteToPaid.priceBandConversion.individual
                      .all.bands[key].conversion,
                  )
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="operator-card">
        <h2>Marže, akvizice a provoz</h2>
        <p>
          CM používá doložené skutečné náklady a časové záznamy práce včetně
          rozdělených cest. Mezery ve stavových časových značkách se nepočítají
          jako práce. Prozatímní objednávky nejsou vydávány za konečnou CM.
        </p>
        <dl class="metric-grid">
          <div>
            <dt>Konečná CM s úplnými podklady</dt>
            <dd>
              {{
                money(
                  report.commercial.handlingAndContributionMargin
                    .finalContributionMargin.value,
                )
              }}
            </dd>
          </div>
          <div>
            <dt>Úplné / neúplné náklady</dt>
            <dd>
              {{
                report.commercial.handlingAndContributionMargin
                  .finalContributionMargin.explicitCoverage.completeOrders
              }}
              /
              {{
                report.commercial.handlingAndContributionMargin
                  .finalContributionMargin.explicitCoverage.incompleteOrders
              }}
            </dd>
          </div>
          <div>
            <dt>Práce a sdílené cesty</dt>
            <dd>
              {{
                money(
                  report.commercial.handlingAndContributionMargin.handlingCost,
                )
              }}
            </dd>
          </div>
          <div>
            <dt>Materiál</dt>
            <dd>
              {{
                money(
                  report.commercial.handlingAndContributionMargin.actualCosts
                    .material,
                )
              }}
            </dd>
          </div>
          <div>
            <dt>Dopravce</dt>
            <dd>
              {{
                money(
                  report.commercial.handlingAndContributionMargin.actualCosts
                    .carrier,
                )
              }}
            </dd>
          </div>
          <div>
            <dt>Balení</dt>
            <dd>
              {{
                money(
                  report.commercial.handlingAndContributionMargin.actualCosts
                    .packaging,
                )
              }}
            </dd>
          </div>
          <div>
            <dt>Platby</dt>
            <dd>
              {{
                money(
                  report.commercial.handlingAndContributionMargin.actualCosts
                    .payment_fee,
                )
              }}
            </dd>
          </div>
          <div>
            <dt>Stroj</dt>
            <dd>
              {{
                money(
                  report.commercial.handlingAndContributionMargin.actualCosts
                    .variable_machine,
                )
              }}
            </dd>
          </div>
          <div>
            <dt>Spend</dt>
            <dd>
              {{
                money(report.commercial.acquisitionAndRepeat.acquisitionSpend)
              }}
            </dd>
          </div>
          <div>
            <dt>CAC (odděleně od CM)</dt>
            <dd>
              {{ moneyRatio(report.commercial.acquisitionAndRepeat.cac) }}
            </dd>
          </div>
          <div>
            <dt>Opakované nákupy</dt>
            <dd>
              {{ ratio(report.commercial.acquisitionAndRepeat.repeatRate) }}
            </dd>
          </div>
          <div>
            <dt>FPY</dt>
            <dd>{{ ratio(report.operational.firstPassYield.value) }}</dd>
          </div>
          <div>
            <dt>Fronta (hodiny)</dt>
            <dd>
              {{
                (
                  Number(report.operational.queue.scheduledRemainingSeconds) /
                  3600
                ).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })
              }}
            </dd>
          </div>
        </dl>
        <h3>Popisný měsíční obrat</h3>
        <ul class="operator-list">
          <li
            v-for="item in report.operational.monthlyTurnover"
            :key="item.month"
          >
            {{ item.month }} · potvrzená hodnota
            {{ money(item.confirmedOrderValue) }} · přijaté platby
            {{ money(item.capturedCash) }} · čisté příjmy
            {{ money(item.netReceipts) }}
          </li>
        </ul>
        <p>Tyto hodnoty nejsou právním závěrem o DPH.</p>
      </section>
    </template>

    <section class="operator-card">
      <h2>Faktická upozornění</h2>
      <p v-if="warnings">
        Pokrytí: emailové pokusy {{ warnings.coverage.emailDeliveryAttempts }},
        historie konfliktů rezervací
        {{ warnings.coverage.reservationConflictHistory }}, šarže bez příjmu
        {{ warnings.coverage.inventoryLotsWithoutReceipt }}, srovnání
        materiálové sazby {{ warnings.coverage.selectedMaterialRate
        }}<span v-if="warnings.truncated"> · seznam je omezený</span>.
      </p>
      <ul class="operator-list">
        <li v-for="item in warnings?.items ?? []" :key="item.id">
          <strong>{{ item.code }}</strong> · {{ item.scope }} ·
          {{ item.status }} · zjištěno {{ formatPragueInstant(item.observedAt)
          }}<span v-if="item.dueAt">
            · termín {{ formatPragueInstant(item.dueAt) }}</span
          ><span v-if="item.evidence.amountMinor">
            · {{ formatCzkMinor(item.evidence.amountMinor) }}</span
          >
          <span
            v-if="
              item.evidence.purchaseRateNumerator &&
              item.evidence.purchaseRateDenominator
            "
          >
            · nákupní sazba {{ item.evidence.purchaseRateNumerator }}/{{
              item.evidence.purchaseRateDenominator
            }}
            haléřů/mg</span
          >
          <span
            v-if="
              item.evidence.selectedRateNumerator &&
              item.evidence.selectedRateDenominator
            "
          >
            · vybraná cenová sazba {{ item.evidence.selectedRateNumerator }}/{{
              item.evidence.selectedRateDenominator
            }}
            haléřů/mg</span
          >
          <span
            v-if="
              item.evidence.rateDifferenceNumerator &&
              item.evidence.rateDifferenceDenominator
            "
          >
            · rozdíl {{ item.evidence.rateDifferenceNumerator }}/{{
              item.evidence.rateDifferenceDenominator
            }}
            haléřů/mg</span
          >
          <span v-if="item.evidence.remainingMilligrams">
            · zbývá {{ item.evidence.remainingMilligrams }} mg</span
          >
          <span v-if="item.evidence.reservedMilligrams">
            · rezervováno {{ item.evidence.reservedMilligrams }} mg</span
          >
          · zdroj {{ item.sourceType }} {{ item.sourceId }}
        </li>
      </ul>
      <p v-if="warnings && !warnings.items.length">
        Žádné aktuálně nalezené položky v dostupném pokrytí.
      </p>
    </section>

    <section class="operator-card">
      <h2>Objednávky v reportu</h2>
      <ul class="operator-list">
        <li v-for="item in orders" :key="item.id">
          <button
            class="text-action"
            type="button"
            @click="
              orderId = item.id;
              loadCosts();
            "
          >
            {{ item.publicReference }}
          </button>
          · {{ item.origin }} · {{ item.status }} ·
          {{ money(item.activeContract.gross) }} · CM
          {{
            item.explicitMarginCoverage
              ? money(item.finalContributionMargin)
              : "neúplné podklady"
          }}
        </li>
      </ul>
      <button
        v-if="orderCursor"
        type="button"
        :disabled="loading"
        @click="moreOrders"
      >
        Další objednávky
      </button>
    </section>

    <section class="operator-card">
      <h2>Skutečné náklady objednávky</h2>
      <form class="operator-inline" @submit.prevent="loadCosts">
        <label>ID objednávky <input v-model="orderId" required /></label
        ><button type="submit">Načíst</button>
      </form>
      <ul class="operator-list">
        <li v-for="item in actualCosts" :key="item.id">
          {{ item.category }} · {{ formatCzkMinor(item.amountMinor) }} ·
          {{ formatPragueInstant(item.occurredAt) }} ·
          {{ item.isCurrent ? "platné" : "nahrazené" }} · {{ item.source }}
          <button
            v-if="canWrite && item.isCurrent"
            type="button"
            @click="editEvidence('cost', item.id)"
          >
            Opravit
          </button>
        </li>
      </ul>
      <button v-if="actualCursor" type="button" @click="moreCosts">
        Další náklady
      </button>
      <button v-if="canWrite" type="button" @click="editEvidence('cost')">
        Zapsat skutečný náklad
      </button>
    </section>

    <section class="operator-card">
      <h2>Akviziční výdaj · platforma</h2>
      <ul class="operator-list">
        <li v-for="item in spend" :key="item.id">
          {{ item.channel }} · {{ formatCzkMinor(item.amountMinor) }} ·
          {{ formatPragueInstant(item.periodStart) }} –
          {{ formatPragueInstant(item.periodEnd) }} ·
          {{ item.isCurrent ? "platné" : "nahrazené" }}
          <button
            v-if="canWrite && item.isCurrent"
            type="button"
            @click="editEvidence('spend', item.id)"
          >
            Opravit
          </button>
        </li>
      </ul>
      <button v-if="spendCursor" type="button" @click="moreSpend">
        Další výdaje
      </button>
      <button v-if="canWrite" type="button" @click="editEvidence('spend')">
        Zapsat akviziční výdaj
      </button>
    </section>

    <section v-if="canWrite && entry" class="operator-card">
      <h2>
        {{ entry === "cost" ? "Skutečný náklad" : "Akviziční výdaj"
        }}{{ supersedesId ? " · oprava" : "" }}
      </h2>
      <form class="operator-form" @submit.prevent="recordEvidence">
        <p v-if="supersedesId">Nahrazovaný doklad {{ supersedesId }}</p>
        <label
          >Částka v haléřích
          <input v-model="amountMinor" inputmode="numeric" required
        /></label>
        <template v-if="entry === 'cost'">
          <label>ID objednávky <input v-model="orderId" required /></label
          ><label
            >Kategorie
            <select v-model="category">
              <option>MATERIAL</option>
              <option>VARIABLE_MACHINE</option>
              <option>CARRIER</option>
              <option>PACKAGING</option>
              <option>PAYMENT_FEE</option>
            </select></label
          ><label
            >Zdroj
            <select v-model="source">
              <option>MANUAL</option>
              <option>MEASURED</option>
            </select></label
          ><label
            >Vznik nákladu (ISO s posunem)
            <input v-model="occurredAt" required /></label
          ><label>ID zdrojové entity <input v-model="sourceEntityId" /></label>
        </template>
        <template v-else>
          <label
            >Kanál
            <select v-model="evidenceChannel">
              <option>DIRECT</option>
              <option>ORGANIC</option>
              <option>PAID</option>
              <option>REFERRAL</option>
              <option>UNKNOWN</option>
            </select></label
          ><label
            >Začátek období (ISO s posunem)
            <input v-model="periodStart" required /></label
          ><label
            >Konec období (ISO s posunem) <input v-model="periodEnd" required
          /></label>
        </template>
        <label
          >Typ zdrojové entity
          <input v-model="sourceEntityType" required /></label
        ><label
          >Jedinečný klíč zdroje <input v-model="sourceKey" required /></label
        ><label
          >Důvod {{ supersedesId || source === "MANUAL" ? "(povinný)" : "" }}
          <input
            v-model="reason"
            :required="
              !!supersedesId || (entry === 'cost' && source === 'MANUAL')
            "
        /></label>
        <button type="submit" :disabled="busy">Zapsat doklad</button
        ><button type="button" @click="entry = ''">Zavřít</button>
      </form>
    </section>
  </section>
</template>
