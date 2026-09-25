<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { apiClient } from "../api";
import { formatPragueInstant } from "../format";
import {
  commandHeaders,
  CommandJournal,
  errorMessage,
  OperatorRequestError,
  requireData,
} from "../operator-requests";
import { hasPermission, session } from "../session";

type S = components["schemas"];
type Detail = S["RecoveryCandidatePreparationDetailDto"];
type Choice = S["RecoveryCandidateChoiceDto"];
type Kind = Detail["kind"];
type Scope = Readonly<{
  kind: Kind;
  targetId: string;
  expectedId: string;
  label: string;
}>;

const props = defineProps<{
  orderId: string;
  jobs: S["FulfilmentJobDto"][];
  claims: S["FulfilmentClaimDto"][];
  shipments: S["FulfilmentShipmentDto"][];
  replacementRequests: S["FulfilmentReplacementRequestDto"][];
  actions: S["OperatorActionDto"][];
  blocked: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const journal = new CommandJournal();
const selected = ref<Scope | null>(null);
const history = ref<Detail[]>([]);
const historyCursor = ref<string | null>(null);
const detail = ref<Detail | null>(null);
const choices = ref<Record<string, Choice[]>>({});
const choiceCursors = ref<Record<string, string | null>>({});
const chosen = ref<Record<string, string>>({});
const prepareReason = ref("");
const commitReason = ref("");
const confirmed = ref(false);
const busy = ref(false);
const reading = ref(false);
const error = ref("");
const success = ref("");
const pendingRetry = ref<(() => Promise<void>) | null>(null);
let epoch = 0;
const minimumCandidateWindowMs = 15 * 60_000;

const jobOffers = computed(() =>
  props.actions
    .filter((action) => action.action === "PREPARE_REPLACEMENT")
    .map((action) => {
      const job = props.jobs.find((item) => item.id === action.targetId);
      const request =
        props.replacementRequests.find(
          (item) =>
            item.sourceJobId === action.targetId && item.status === "OPEN",
        ) ?? job?.replacementRequestSource;
      return { job, request };
    })
    .filter(
      (
        entry,
      ): entry is {
        job: S["FulfilmentJobDto"];
        request: S["FulfilmentReplacementRequestDto"];
      } => !!entry.job && !!entry.request && entry.request.status === "OPEN",
    ),
);
const claimOffers = computed(() => {
  if (!hasPermission("financial:exception")) return [];
  return props.claims.flatMap((claim) => {
    if (
      claim.origin !== "SHIPMENT_INCIDENT" ||
      !["OPEN", "ACTIVE"].includes(claim.status)
    )
      return [];
    return props.shipments
      .filter(
        (shipment) =>
          shipment.status === "LOST" &&
          (shipment.id === claim.incidentShipmentId ||
            shipment.reprintClaimId === claim.id ||
            claim.reshipmentAuthorizations.some(
              (authorization) =>
                authorization.reshipmentShipmentId === shipment.id,
            )) &&
          !props.shipments.some(
            (successor) => successor.replacesShipmentId === shipment.id,
          ),
      )
      .map((shipment) => ({ claim, shipment }));
  });
});
const canPrepare = computed(() => {
  const scope = selected.value;
  if (!scope || props.blocked || busy.value || !!pendingRetry.value)
    return false;
  if (scope.kind === "JOB_REPLACEMENT")
    return hasPermission("operations:write");
  return hasPermission("financial:exception");
});
function canCommitNow(): boolean {
  const current = detail.value;
  if (
    !canPrepare.value ||
    !current ||
    current.status !== "CANDIDATES_AVAILABLE" ||
    !confirmed.value ||
    !commitReason.value.trim() ||
    current.sourceJobIds.length === 0 ||
    current.sourceJobIds.length !== current.sources.length
  )
    return false;
  return current.sourceJobIds.every((sourceJobId) => {
    const selectedId = chosen.value[sourceJobId];
    const choice = choices.value[sourceJobId]?.find(
      (item) => item.candidateResourceEstimateId === selectedId,
    );
    return (
      !!choice &&
      choice.sourceJobId === sourceJobId &&
      choice.selectable &&
      new Date(choice.expiresAt).getTime() >
        Date.now() + minimumCandidateWindowMs
    );
  });
}
const canCommit = computed(canCommitNow);

function clear(): void {
  epoch += 1;
  selected.value = null;
  history.value = [];
  historyCursor.value = null;
  detail.value = null;
  choices.value = {};
  choiceCursors.value = {};
  chosen.value = {};
  prepareReason.value = "";
  commitReason.value = "";
  confirmed.value = false;
  pendingRetry.value = null;
  error.value = "";
  success.value = "";
}
watch(() => props.orderId, clear);
watch(
  () => session.phase,
  (phase) => {
    if (phase !== "authenticated") clear();
  },
);
onBeforeUnmount(clear);

async function fetchHistory(scope: Scope, cursor?: string) {
  const params = { query: { limit: 20, ...(cursor ? { cursor } : {}) } };
  if (scope.kind === "JOB_REPLACEMENT")
    return requireData(
      await apiClient.GET(
        "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/replacement-preparations",
        {
          params: {
            ...params,
            path: { orderId: props.orderId, jobId: scope.targetId },
          },
        },
      ),
    );
  return requireData(
    await apiClient.GET(
      "/admin/orders/{orderId}/fulfilment/claims/{claimId}/reprint-preparations",
      {
        params: {
          ...params,
          path: { orderId: props.orderId, claimId: scope.targetId },
        },
      },
    ),
  );
}
async function loadHistory(append = false): Promise<void> {
  const scope = selected.value;
  if (!scope || reading.value) return;
  const activeEpoch = epoch;
  reading.value = true;
  error.value = "";
  try {
    const page = await fetchHistory(
      scope,
      append ? (historyCursor.value ?? undefined) : undefined,
    );
    if (activeEpoch !== epoch) return;
    history.value = append ? [...history.value, ...page.items] : page.items;
    historyCursor.value = page.nextCursor ?? null;
  } catch (cause) {
    if (activeEpoch === epoch) error.value = errorMessage(cause);
  } finally {
    reading.value = false;
  }
}
async function loadPreparation(preparationId: string): Promise<void> {
  const scope = selected.value;
  if (!scope || reading.value) return;
  const activeEpoch = epoch;
  reading.value = true;
  error.value = "";
  try {
    const result =
      scope.kind === "JOB_REPLACEMENT"
        ? requireData(
            await apiClient.GET(
              "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/replacement-preparations/{preparationId}",
              {
                params: {
                  path: {
                    orderId: props.orderId,
                    jobId: scope.targetId,
                    preparationId,
                  },
                },
              },
            ),
          )
        : requireData(
            await apiClient.GET(
              "/admin/orders/{orderId}/fulfilment/claims/{claimId}/reprint-preparations/{preparationId}",
              {
                params: {
                  path: {
                    orderId: props.orderId,
                    claimId: scope.targetId,
                    preparationId,
                  },
                },
              },
            ),
          );
    if (activeEpoch !== epoch) return;
    detail.value = result;
    choices.value = {};
    choiceCursors.value = {};
    chosen.value = {};
    confirmed.value = false;
  } catch (cause) {
    if (activeEpoch === epoch) error.value = errorMessage(cause);
  } finally {
    reading.value = false;
  }
}
async function loadChoices(sourceJobId: string, more = false): Promise<void> {
  const scope = selected.value;
  const current = detail.value;
  if (!scope || !current || reading.value) return;
  const activeEpoch = epoch;
  reading.value = true;
  error.value = "";
  try {
    const query = {
      limit: 50,
      sourceJobId,
      ...(more && choiceCursors.value[sourceJobId]
        ? { cursor: choiceCursors.value[sourceJobId]! }
        : {}),
    };
    const page =
      scope.kind === "JOB_REPLACEMENT"
        ? requireData(
            await apiClient.GET(
              "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/replacement-preparations/{preparationId}/candidates",
              {
                params: {
                  path: {
                    orderId: props.orderId,
                    jobId: scope.targetId,
                    preparationId: current.preparationId,
                  },
                  query,
                },
              },
            ),
          )
        : requireData(
            await apiClient.GET(
              "/admin/orders/{orderId}/fulfilment/claims/{claimId}/reprint-preparations/{preparationId}/candidates",
              {
                params: {
                  path: {
                    orderId: props.orderId,
                    claimId: scope.targetId,
                    preparationId: current.preparationId,
                  },
                  query,
                },
              },
            ),
          );
    if (
      activeEpoch !== epoch ||
      detail.value?.preparationId !== current.preparationId
    )
      return;
    choices.value[sourceJobId] = more
      ? [...(choices.value[sourceJobId] ?? []), ...page.items]
      : page.items;
    choiceCursors.value[sourceJobId] = page.nextCursor ?? null;
    if (!more) delete chosen.value[sourceJobId];
  } catch (cause) {
    if (activeEpoch === epoch) error.value = errorMessage(cause);
  } finally {
    reading.value = false;
  }
}
async function open(scope: Scope): Promise<void> {
  if (props.blocked || busy.value || reading.value || !!pendingRetry.value)
    return;
  clear();
  selected.value = scope;
  await loadHistory();
  if (history.value[0]) await loadPreparation(history.value[0].preparationId);
}

async function runCommand<Result>(
  identity: string,
  body: object,
  send: (body: object, key: string) => Promise<Result>,
  onSuccess: (result: Result) => Promise<void>,
  refreshOrder = false,
): Promise<void> {
  if (!canPrepare.value) return;
  const activeEpoch = epoch;
  const perform = async () => {
    const result = await journal.submit(identity, body, send);
    if (activeEpoch === epoch) {
      pendingRetry.value = null;
      try {
        await onSuccess(result);
      } catch (cause) {
        error.value = `Zápis byl přijat, ale načtení stavu selhalo: ${errorMessage(cause)}`;
      }
      if (refreshOrder) emit("changed");
    }
  };
  busy.value = true;
  error.value = "";
  try {
    await perform();
  } catch (cause) {
    if (activeEpoch !== epoch) return;
    error.value = errorMessage(cause);
    if (cause instanceof OperatorRequestError && cause.refreshRequired) {
      const feedback = error.value;
      pendingRetry.value = null;
      if (detail.value) await loadPreparation(detail.value.preparationId);
      await loadHistory();
      error.value = feedback;
    } else if (
      !(cause instanceof OperatorRequestError) ||
      cause.status === 503
    ) {
      pendingRetry.value = perform;
      error.value +=
        " Výsledek není jistý. Opakujte pouze původní požadavek se stejným klíčem.";
    }
  } finally {
    busy.value = false;
  }
}
async function retry(): Promise<void> {
  const pending = pendingRetry.value;
  if (!pending || busy.value || props.blocked) return;
  busy.value = true;
  try {
    await pending();
  } catch (cause) {
    error.value = errorMessage(cause);
    if (cause instanceof OperatorRequestError && cause.refreshRequired) {
      const feedback = error.value;
      pendingRetry.value = null;
      if (detail.value) await loadPreparation(detail.value.preparationId);
      await loadHistory();
      error.value = feedback;
    }
  } finally {
    busy.value = false;
  }
}
async function prepare(): Promise<void> {
  const scope = selected.value;
  if (!scope || !canPrepare.value) return;
  const reason = prepareReason.value.trim();
  if (!reason) {
    error.value = "Vyplňte důvod přípravy.";
    return;
  }
  if (
    detail.value?.status === "PREPARING" &&
    detail.value.nextRefreshAt &&
    new Date(detail.value.nextRefreshAt).getTime() > Date.now()
  ) {
    error.value = "Příprava ještě probíhá. Obnovte průběh po uvedeném čase.";
    return;
  }
  if (scope.kind === "JOB_REPLACEMENT") {
    const body: S["PrepareJobReplacementDto"] = {
      expectedReplacementRequestId: scope.expectedId,
      reason,
    };
    await runCommand(
      `recovery-prepare:${props.orderId}:${scope.kind}:${scope.targetId}`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/replacement-preparations",
            {
              params: {
                path: { orderId: props.orderId, jobId: scope.targetId },
                header: commandHeaders(key),
              },
              body: frozen as S["PrepareJobReplacementDto"],
            },
          ),
        ),
      async (accepted) => {
        success.value = `Příprava ${accepted.preparationId} přijata. Kandidáti se počítají asynchronně.`;
        await loadHistory();
        await loadPreparation(accepted.preparationId);
      },
    );
  } else {
    const body: S["PrepareClaimReprintDto"] = {
      expectedPredecessorShipmentId: scope.expectedId,
      reason,
    };
    await runCommand(
      `recovery-prepare:${props.orderId}:${scope.kind}:${scope.targetId}`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/claims/{claimId}/reprint-preparations",
            {
              params: {
                path: { orderId: props.orderId, claimId: scope.targetId },
                header: commandHeaders(key),
              },
              body: frozen as S["PrepareClaimReprintDto"],
            },
          ),
        ),
      async (accepted) => {
        success.value = `Příprava ${accepted.preparationId} přijata. Kandidáti se počítají asynchronně.`;
        await loadHistory();
        await loadPreparation(accepted.preparationId);
      },
    );
  }
}
async function commit(): Promise<void> {
  const scope = selected.value;
  const current = detail.value;
  if (!scope || !current || !canCommitNow()) {
    error.value =
      "Volby už nemusí být čerstvé. Obnovte způsobilost a vyberte kandidáty znovu.";
    return;
  }
  const reason = commitReason.value.trim();
  if (scope.kind === "JOB_REPLACEMENT") {
    const candidateResourceEstimateId = chosen.value[current.sourceJobIds[0]!];
    if (!candidateResourceEstimateId) return;
    const body: S["CreateReplacementDto"] = {
      reason,
      candidateResourceEstimateId,
    };
    await runCommand(
      `recovery-commit:${props.orderId}:${scope.kind}:${scope.targetId}`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/jobs/{jobId}/replacement",
            {
              params: {
                path: { orderId: props.orderId, jobId: scope.targetId },
                header: commandHeaders(key),
              },
              body: frozen as S["CreateReplacementDto"],
            },
          ),
        ),
      async () => {
        success.value =
          "Náhrada potvrzena. Aktuální stav znovu načtěte před dalším krokem.";
        await loadHistory();
        await loadPreparation(current.preparationId);
      },
      true,
    );
  } else {
    const body: S["CreateClaimReprintDto"] = {
      reason,
      replacements: current.sourceJobIds.map((sourceJobId) => ({
        sourceJobId,
        candidateResourceEstimateId: chosen.value[sourceJobId]!,
      })),
    };
    await runCommand(
      `recovery-commit:${props.orderId}:${scope.kind}:${scope.targetId}`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST(
            "/admin/orders/{orderId}/fulfilment/claims/{claimId}/reprint",
            {
              params: {
                path: { orderId: props.orderId, claimId: scope.targetId },
                header: commandHeaders(key),
              },
              body: frozen as S["CreateClaimReprintDto"],
            },
          ),
        ),
      async () => {
        success.value =
          "Celá zásilka znovu zadána. Aktuální stav znovu načtěte před dalším krokem.";
        await loadHistory();
        await loadPreparation(current.preparationId);
      },
      true,
    );
  }
}
</script>

<template>
  <section class="operator-card" aria-labelledby="recovery-title">
    <h2 id="recovery-title">Náhradní tisk a opakovaná zásilka</h2>
    <p>
      Příprava pouze navrhuje zdroje. Rezervace a vytvoření úloh proběhne až po
      samostatném potvrzení.
    </p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="success" role="status">{{ success }}</p>
    <p v-if="pendingRetry" role="alert">
      Výsledek zápisu není jistý. Obsah a klíč původního požadavku zůstaly
      zachovány.
      <button type="button" :disabled="busy || blocked" @click="retry">
        Opakovat stejný požadavek
      </button>
    </p>
    <div class="operator-actions">
      <button
        v-for="entry in jobOffers"
        :key="`job:${entry.job.id}`"
        type="button"
        :disabled="blocked || busy || reading || !!pendingRetry"
        @click="
          open({
            kind: 'JOB_REPLACEMENT',
            targetId: entry.job.id,
            expectedId: entry.request.id,
            label: `Úloha ${entry.job.id}`,
          })
        "
      >
        Připravit náhradu úlohy {{ entry.job.id }}
      </button>
      <button
        v-for="entry in claimOffers"
        :key="`claim:${entry.claim.id}:${entry.shipment.id}`"
        type="button"
        :disabled="blocked || busy || reading || !!pendingRetry"
        @click="
          open({
            kind: 'LOST_CLAIM_REPRINT',
            targetId: entry.claim.id,
            expectedId: entry.shipment.id,
            label: `Reklamace ${entry.claim.id} · ztracená zásilka ${entry.shipment.id}`,
          })
        "
      >
        Připravit opakovanou zásilku pro reklamaci {{ entry.claim.id }} ·
        {{ entry.shipment.id }}
      </button>
    </div>
    <p v-if="!jobOffers.length && !claimOffers.length">
      Pro načtené úlohy a reklamace není dostupná příprava. U starších případů
      načtěte úplnou historii.
    </p>
    <div v-if="selected">
      <h3>{{ selected.label }}</h3>
      <p>
        Očekávaný současný
        {{
          selected.kind === "JOB_REPLACEMENT"
            ? "požadavek náhrady"
            : "ztracený předchůdce"
        }}: {{ selected.expectedId }}.
      </p>
      <div class="operator-actions">
        <button
          type="button"
          :disabled="reading || busy"
          @click="loadHistory()"
        >
          Obnovit historii
        </button>
        <button
          v-if="historyCursor"
          type="button"
          :disabled="reading || busy"
          @click="loadHistory(true)"
        >
          Starší přípravy
        </button>
      </div>
      <ul class="operator-list">
        <li v-for="item in history" :key="item.preparationId">
          Generace {{ item.generation }} · {{ item.status }} ·
          {{ formatPragueInstant(item.requestedAt) }} · čeká
          {{ item.pendingCount }} · selhalo {{ item.failedCount }}
          <button
            type="button"
            :disabled="reading || busy"
            @click="loadPreparation(item.preparationId)"
          >
            Detail
          </button>
        </li>
      </ul>
      <form class="operator-form" @submit.prevent="prepare">
        <label
          >Důvod přípravy
          <textarea
            v-model.trim="prepareReason"
            rows="2"
            required
            :disabled="!canPrepare"
          />
        </label>
        <button type="submit" :disabled="!canPrepare || !prepareReason.trim()">
          {{ busy ? "Odesílám…" : "Připravit čerstvé kandidáty" }}
        </button>
      </form>
      <div v-if="detail">
        <h4>Příprava {{ detail.generation }} · {{ detail.status }}</h4>
        <p>
          Zdrojových úloh {{ detail.sourceJobIds.length }} · odesláno
          {{ detail.dispatchCount }} · čeká {{ detail.pendingCount }} · selhalo
          {{ detail.failedCount }}.
        </p>
        <p v-if="detail.nextRefreshAt">
          Nová generace nejdříve
          {{ formatPragueInstant(detail.nextRefreshAt) }}.
        </p>
        <p v-if="detail.blockingCodes.length" role="alert">
          Překážky: {{ detail.blockingCodes.join(", ") }}.
        </p>
        <button
          type="button"
          :disabled="reading || busy"
          @click="loadPreparation(detail.preparationId)"
        >
          Obnovit průběh a způsobilost
        </button>
        <div v-for="source in detail.sources" :key="source.sourceJobId">
          <h5>
            Úloha {{ source.sourceJobId }} · množství {{ source.quantity }}
          </h5>
          <p>
            Sloty {{ source.fulfilmentSlotIds.join(", ") }} · volitelné
            {{ source.selectableCount }} · čeká {{ source.pendingCount }} ·
            selhalo {{ source.failedCount }}.
          </p>
          <p v-if="source.blockingCodes.length" role="alert">
            Překážky: {{ source.blockingCodes.join(", ") }}.
          </p>
          <button
            type="button"
            :disabled="reading || busy"
            @click="loadChoices(source.sourceJobId)"
          >
            Načíst aktuální volby
          </button>
          <fieldset v-if="choices[source.sourceJobId]">
            <legend>Volba zdrojů pro úlohu {{ source.sourceJobId }}</legend>
            <label
              v-for="choice in choices[source.sourceJobId]"
              :key="choice.candidateResourceEstimateId"
            >
              <input
                v-model="chosen[source.sourceJobId]"
                type="radio"
                :name="`recovery:${source.sourceJobId}`"
                :value="choice.candidateResourceEstimateId"
                :disabled="
                  !choice.selectable ||
                  new Date(choice.expiresAt).getTime() <=
                    Date.now() + minimumCandidateWindowMs ||
                  detail.status !== 'CANDIDATES_AVAILABLE' ||
                  busy ||
                  !!pendingRetry
                "
              />
              Stroj {{ choice.machineId }} · profil
              {{ choice.machineProfileId }} · kalibrace
              {{ choice.machineCalibrationId }} · sklad
              {{ choice.inventoryId }} · konfigurace
              {{ choice.printConfigRevisionId }} · {{ choice.material }}
              {{ choice.color ?? "" }} · {{ choice.quantity }} ks ·
              {{ choice.partsPerPlate }} ks/deska. Potřeba
              {{ choice.requiredMaterialMilligrams }} mg,
              {{ choice.requiredMachineSeconds }} s. Vypočteno
              {{ formatPragueInstant(choice.calculatedAt) }}; rozhodnutí do
              {{ formatPragueInstant(choice.expiresAt) }}. Tisk
              {{
                choice.intervals
                  .map(
                    (interval) =>
                      `${formatPragueInstant(interval.startsAt)}–${formatPragueInstant(interval.endsAt)}`,
                  )
                  .join(", ")
              }}.
              {{
                choice.selectable
                  ? "Lze zvolit nyní; není rezervováno."
                  : `Nelze zvolit: ${choice.blockingCodes.join(", ")}`
              }}
            </label>
          </fieldset>
          <button
            v-if="choiceCursors[source.sourceJobId]"
            type="button"
            :disabled="reading || busy"
            @click="loadChoices(source.sourceJobId, true)"
          >
            Další volby
          </button>
        </div>
        <form
          v-if="detail.status === 'CANDIDATES_AVAILABLE'"
          class="operator-form"
          @submit.prevent="commit"
        >
          <label
            >Důvod potvrzení
            <textarea
              v-model.trim="commitReason"
              rows="2"
              required
              :disabled="busy || !!pendingRetry"
            />
          </label>
          <label
            ><input
              v-model="confirmed"
              type="checkbox"
              required
              :disabled="busy || !!pendingRetry"
            />
            Potvrzuji aktuální kandidáty pro všechny zdrojové úlohy; příprava
            sama nic nerezervovala.</label
          >
          <button type="submit" :disabled="!canCommit">
            {{
              busy
                ? "Potvrzuji…"
                : selected.kind === "JOB_REPLACEMENT"
                  ? "Vytvořit náhradní úlohu"
                  : "Vytvořit celou opakovanou zásilku"
            }}
          </button>
        </form>
      </div>
    </div>
  </section>
</template>
