<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import { computed, onMounted, ref } from "vue";
import { apiClient } from "../api";
import { formatPragueInstant } from "../format";
import {
  commandHeaders,
  CommandJournal,
  errorMessage,
  isoFromZonedInput,
  OperatorRequestError,
  parseJsonObject,
  requireData,
} from "../operator-requests";
import { hasPermission, session } from "../session";

type S = components["schemas"];
const nodeId = computed(() => session.value?.operator.nodeIds[0] ?? "");
const canWrite = computed(() => hasPermission("catalog:write"));
const machines = ref<S["MachineReadDto"][]>([]);
const inventories = ref<S["InventoryReadDto"][]>([]);
const calibrations = ref<S["MachineCalibrationReadDto"][]>([]);
const capabilities = ref<S["MachineCapabilityReadDto"][]>([]);
const machineCursor = ref<string | null>(null);
const inventoryCursor = ref<string | null>(null);
const calibrationCursor = ref<string | null>(null);
const capabilityCursor = ref<string | null>(null);
const inventory = ref<S["InventoryDetailDto"] | null>(null);
const currentReceipt = computed(() => {
  const receipts = inventory.value?.receipts ?? [];
  const superseded = new Set(receipts.map((item) => item.supersedesReceiptId));
  const leaves = receipts.filter((item) => !superseded.has(item.id));
  return leaves.length === 1 ? leaves[0] : null;
});
const availability = ref<S["MachineAvailabilityReadDto"] | null>(null);
const availabilityMachineId = ref("");
const formMachineId = ref("");
const from = ref(new Date().toISOString());
const to = ref(new Date(Date.now() + 30 * 86_400_000).toISOString());
const windows = ref<{ startsAt: string; endsAt: string }[]>([]);
const availabilityDirty = computed(() => {
  const saved = availability.value?.windows ?? [];
  return (
    windows.value.length !== saved.length ||
    windows.value.some(
      (window, index) =>
        window.startsAt !== saved[index]?.startsAt ||
        window.endsAt !== saved[index]?.endsAt,
    )
  );
});
const error = ref("");
const success = ref("");
const busy = ref(false);
const loading = ref(false);
const inventoryRefreshRequired = ref(false);
const reason = ref("");
const form = ref<
  "machine" | "calibration" | "receipt" | "legacy-receipt" | "correction" | ""
>("");
const machineCode = ref("");
const machineName = ref("");
const machineCapabilityId = ref("");
const installedNozzle = ref(400);
const flowRatio = ref(1_000_000);
const xyCompensation = ref(0);
const elephantFoot = ref(0);
const calibrationSettings = ref("{}");
const sku = ref("");
const vendor = ref("");
const lotCode = ref("");
const material = ref<"PLA" | "PETG">("PLA");
const color = ref("");
const purchasedAt = ref(new Date().toISOString());
const receivedMilligrams = ref("");
const priceNumerator = ref("");
const priceDenominator = ref("1000");
const supersedesReceiptId = ref("");
const adjustmentMilligrams = ref("");
const journal = new CommandJournal();
let inventoryReadGeneration = 0;
let availabilityReadGeneration = 0;

async function refresh(): Promise<void> {
  if (!nodeId.value) return;
  loading.value = true;
  error.value = "";
  try {
    const [machinePage, inventoryPage, calibrationPage, capabilityPage] =
      await Promise.all([
        apiClient.GET("/admin/nodes/{nodeId}/machines", {
          params: { path: { nodeId: nodeId.value }, query: { limit: 100 } },
        }),
        apiClient.GET("/admin/nodes/{nodeId}/inventories", {
          params: { path: { nodeId: nodeId.value }, query: { limit: 100 } },
        }),
        apiClient.GET("/admin/nodes/{nodeId}/calibrations", {
          params: { path: { nodeId: nodeId.value }, query: { limit: 100 } },
        }),
        apiClient.GET("/admin/catalog/machine-capabilities", {
          params: { query: { limit: 100 } },
        }),
      ]);
    const machineData = requireData(machinePage);
    const inventoryData = requireData(inventoryPage);
    const calibrationData = requireData(calibrationPage);
    const capabilityData = requireData(capabilityPage);
    machines.value = machineData.items;
    machineCursor.value = machineData.nextCursor ?? null;
    inventories.value = inventoryData.items;
    inventoryCursor.value = inventoryData.nextCursor ?? null;
    calibrations.value = calibrationData.items;
    calibrationCursor.value = calibrationData.nextCursor ?? null;
    capabilities.value = capabilityData.items;
    capabilityCursor.value = capabilityData.nextCursor ?? null;
    if (inventory.value) await inspectInventory(inventory.value.id);
    if (availabilityMachineId.value && !availabilityDirty.value)
      await inspectAvailability(true);
    if (!error.value) inventoryRefreshRequired.value = false;
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function more(
  kind: "machine" | "inventory" | "calibration" | "capability",
): Promise<void> {
  const cursors = {
    machine: machineCursor,
    inventory: inventoryCursor,
    calibration: calibrationCursor,
    capability: capabilityCursor,
  };
  const cursor = cursors[kind].value;
  if (!cursor || loading.value || busy.value) return;
  loading.value = true;
  try {
    if (kind === "machine") {
      const page = requireData(
        await apiClient.GET("/admin/nodes/{nodeId}/machines", {
          params: {
            path: { nodeId: nodeId.value },
            query: { limit: 100, cursor },
          },
        }),
      );
      machines.value = [...machines.value, ...page.items];
      machineCursor.value = page.nextCursor ?? null;
    } else if (kind === "inventory") {
      const page = requireData(
        await apiClient.GET("/admin/nodes/{nodeId}/inventories", {
          params: {
            path: { nodeId: nodeId.value },
            query: { limit: 100, cursor },
          },
        }),
      );
      inventories.value = [...inventories.value, ...page.items];
      inventoryCursor.value = page.nextCursor ?? null;
    } else if (kind === "calibration") {
      const page = requireData(
        await apiClient.GET("/admin/nodes/{nodeId}/calibrations", {
          params: {
            path: { nodeId: nodeId.value },
            query: { limit: 100, cursor },
          },
        }),
      );
      calibrations.value = [...calibrations.value, ...page.items];
      calibrationCursor.value = page.nextCursor ?? null;
    } else {
      const page = requireData(
        await apiClient.GET("/admin/catalog/machine-capabilities", {
          params: { query: { limit: 100, cursor } },
        }),
      );
      capabilities.value = [...capabilities.value, ...page.items];
      capabilityCursor.value = page.nextCursor ?? null;
    }
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function inspectInventory(id: string): Promise<void> {
  const generation = ++inventoryReadGeneration;
  inventory.value = null;
  try {
    const detail = requireData(
      await apiClient.GET("/admin/nodes/{nodeId}/inventories/{id}", {
        params: { path: { nodeId: nodeId.value, id } },
      }),
    );
    if (generation !== inventoryReadGeneration) return;
    inventory.value = detail;
    if (form.value !== "receipt" && form.value !== "correction") {
      vendor.value = detail.vendor;
      priceNumerator.value = detail.priceMinorUnitsNumerator;
      priceDenominator.value = detail.priceMinorUnitsDenominator;
      supersedesReceiptId.value = detail.receipts.at(-1)?.id ?? "";
    }
  } catch (cause) {
    if (generation === inventoryReadGeneration)
      error.value = errorMessage(cause);
  }
}

function selectInventory(id: string): void {
  form.value = "";
  void inspectInventory(id);
}

function openCorrection(): void {
  const receipt = currentReceipt.value;
  if (!receipt) return;
  form.value = "correction";
  supersedesReceiptId.value = receipt.id;
  vendor.value = receipt.vendor;
  purchasedAt.value = receipt.purchasedAt;
  receivedMilligrams.value = receipt.receivedMilligrams;
  priceNumerator.value = receipt.priceMinorUnitsNumerator;
  priceDenominator.value = receipt.priceMinorUnitsDenominator;
}

function openLegacyReceipt(): void {
  purchasedAt.value = "";
  receivedMilligrams.value = "";
  form.value = "legacy-receipt";
}

async function inspectAvailability(preserveDraft = false): Promise<void> {
  if (!availabilityMachineId.value) return;
  const machineId = availabilityMachineId.value;
  const generation = ++availabilityReadGeneration;
  try {
    const range = {
      from: isoFromZonedInput(from.value),
      to: isoFromZonedInput(to.value),
    };
    const detail = requireData(
      await apiClient.GET(
        "/admin/nodes/{nodeId}/machines/{machineId}/availability",
        {
          params: {
            path: { nodeId: nodeId.value, machineId },
            query: range,
          },
        },
      ),
    );
    if (
      generation !== availabilityReadGeneration ||
      machineId !== availabilityMachineId.value ||
      (preserveDraft && availabilityDirty.value)
    )
      return;
    availability.value = detail;
    windows.value = availability.value.windows.map((item) => ({
      startsAt: item.startsAt,
      endsAt: item.endsAt,
    }));
  } catch (cause) {
    if (
      generation === availabilityReadGeneration &&
      machineId === availabilityMachineId.value
    )
      error.value = errorMessage(cause);
  }
}

async function run<Body>(
  action: string,
  body: Body,
  write: (body: Readonly<Body>, key: string) => Promise<unknown>,
  message: string,
): Promise<void> {
  if (
    busy.value ||
    loading.value ||
    inventoryRefreshRequired.value ||
    !canWrite.value
  )
    return;
  busy.value = true;
  error.value = "";
  success.value = "";
  const hadInventoryDetail = inventory.value !== null;
  let writeConfirmed = false;
  try {
    await journal.submit(action, body, write);
    writeConfirmed = true;
    if (hadInventoryDetail) inventoryRefreshRequired.value = true;
    form.value = "";
    success.value = message;
    await refresh();
    if (error.value)
      error.value = `Zápis byl potvrzen, ale obnovení přehledu selhalo. ${error.value}`;
  } catch (cause) {
    error.value = writeConfirmed
      ? `Zápis byl potvrzen, ale obnovení přehledu selhalo. ${errorMessage(cause)}`
      : errorMessage(cause);
  } finally {
    busy.value = false;
  }
}

async function registerMachine(): Promise<void> {
  const body: S["RegisterMachineDto"] = {
    code: machineCode.value.trim(),
    displayName: machineName.value.trim(),
    machineCapabilityId: machineCapabilityId.value,
    installedNozzleMicrometers: installedNozzle.value,
  };
  await run(
    `machine:${nodeId.value}:register`,
    body,
    async (frozen, key) =>
      requireData(
        await apiClient.POST("/admin/nodes/{nodeId}/machines", {
          params: {
            path: { nodeId: nodeId.value },
            header: commandHeaders(key),
          },
          body: frozen,
        }),
      ),
    "Stroj byl zaregistrován.",
  );
}

async function createCalibration(): Promise<void> {
  try {
    const body: S["CreateMachineCalibrationDto"] = {
      machineId: formMachineId.value,
      flowRatioPartsPerMillion: flowRatio.value,
      xyCompensationMicrometers: xyCompensation.value,
      elephantFootCompensationMicrometers: elephantFoot.value,
      settings: parseJsonObject(calibrationSettings.value),
    };
    await run(
      `calibration:${nodeId.value}:create`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/nodes/{nodeId}/calibrations", {
            params: {
              path: { nodeId: nodeId.value },
              header: commandHeaders(key),
            },
            body: frozen,
          }),
        ),
      "Kalibrace byla vytvořena jako neměnná revize.",
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function calibrationAction(
  id: string,
  action: "activate" | "retire",
): Promise<void> {
  if (!reason.value.trim()) return;
  const body = { reason: reason.value.trim() };
  await run(
    `calibration:${id}:${action}`,
    body,
    async (frozen, key) => {
      const params = {
        path: { nodeId: nodeId.value, calibrationId: id },
        header: commandHeaders(key),
      };
      return requireData(
        action === "activate"
          ? await apiClient.POST(
              "/admin/nodes/{nodeId}/calibrations/{calibrationId}/activate",
              { params, body: frozen },
            )
          : await apiClient.POST(
              "/admin/nodes/{nodeId}/calibrations/{calibrationId}/retire",
              { params, body: frozen },
            ),
      );
    },
    "Stav kalibrace byl potvrzen. Historické úlohy se nemění.",
  );
}

async function machineStatus(
  id: string,
  status: S["MachineStatusDto"]["status"],
): Promise<void> {
  if (!reason.value.trim()) return;
  const body: S["MachineStatusDto"] = { status, reason: reason.value.trim() };
  await run(
    `machine:${id}:status`,
    body,
    async (frozen, key) =>
      requireData(
        await apiClient.POST(
          "/admin/nodes/{nodeId}/machines/{machineId}/status",
          {
            params: {
              path: { nodeId: nodeId.value, machineId: id },
              header: commandHeaders(key),
            },
            body: frozen,
          },
        ),
      ),
    "Stav stroje byl změněn pro budoucí přijetí práce.",
  );
}

async function receiveInventory(): Promise<void> {
  try {
    const body: S["ReceiveInventoryDto"] = {
      machineId: formMachineId.value,
      sku: sku.value.trim(),
      vendor: vendor.value.trim(),
      lotCode: lotCode.value.trim() || null,
      material: material.value,
      color: color.value.trim() || null,
      currency: "CZK",
      purchasedAt: isoFromZonedInput(purchasedAt.value),
      remainingMilligrams: receivedMilligrams.value,
      priceMinorUnitsNumerator: priceNumerator.value,
      priceMinorUnitsDenominator: priceDenominator.value,
    };
    await run(
      `inventory:${nodeId.value}:receive`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/nodes/{nodeId}/inventory-receipts", {
            params: {
              path: { nodeId: nodeId.value },
              header: commandHeaders(key),
            },
            body: frozen,
          }),
        ),
      "Nová šarže a neměnný příjem byly zapsány. Historické náklady zůstávají zachovány.",
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function legacyReceipt(): Promise<void> {
  if (!inventory.value || !reason.value.trim()) return;
  try {
    const body: S["RecordInitialInventoryReceiptDto"] = {
      currency: "CZK",
      vendor: vendor.value.trim(),
      receivedMilligrams: receivedMilligrams.value,
      purchasedAt: isoFromZonedInput(purchasedAt.value),
      priceMinorUnitsNumerator: priceNumerator.value,
      priceMinorUnitsDenominator: priceDenominator.value,
      reason: reason.value.trim(),
    };
    const id = inventory.value.id;
    await run(
      `inventory:${id}:initial-receipt`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST(
            "/admin/nodes/{nodeId}/inventories/{inventoryId}/initial-receipt",
            {
              params: {
                path: { nodeId: nodeId.value, inventoryId: id },
                header: commandHeaders(key),
              },
              body: frozen,
            },
          ),
        ),
      "Počáteční příjem byl zaznamenán. Dřívější neznámé náklady se nepřepisují.",
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function correctReceipt(): Promise<void> {
  if (!inventory.value || !reason.value.trim()) return;
  try {
    const body: S["CorrectInventoryReceiptDto"] = {
      currency: "CZK",
      vendor: vendor.value.trim(),
      receivedMilligrams: receivedMilligrams.value,
      purchasedAt: isoFromZonedInput(purchasedAt.value),
      priceMinorUnitsNumerator: priceNumerator.value,
      priceMinorUnitsDenominator: priceDenominator.value,
      supersedesReceiptId: supersedesReceiptId.value,
      reason: reason.value.trim(),
    };
    const id = inventory.value.id;
    await run(
      `inventory:${id}:receipt-correction`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST(
            "/admin/nodes/{nodeId}/inventories/{inventoryId}/receipt-corrections",
            {
              params: {
                path: { nodeId: nodeId.value, inventoryId: id },
                header: commandHeaders(key),
              },
              body: frozen,
            },
          ),
        ),
      "Oprava příjmu vytvořila nový doklad; historické čerpání se nemění.",
    );
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function mount(status: "MOUNTED" | "UNMOUNTED"): Promise<void> {
  if (!inventory.value || !reason.value.trim()) return;
  const id = inventory.value.id;
  const body: S["InventoryMountDto"] = {
    mountStatus: status,
    reason: reason.value.trim(),
  };
  await run(
    `inventory:${id}:mount`,
    body,
    async (frozen, key) =>
      requireData(
        await apiClient.POST(
          "/admin/nodes/{nodeId}/inventories/{inventoryId}/mount",
          {
            params: {
              path: { nodeId: nodeId.value, inventoryId: id },
              header: commandHeaders(key),
            },
            body: frozen,
          },
        ),
      ),
    "Stav nasazení byl potvrzen. Množství ani rezervace se nezměnily.",
  );
}

async function changeInventoryStatus(
  status: S["InventoryStatusDto"]["status"],
): Promise<void> {
  if (!inventory.value || !reason.value.trim()) return;
  const id = inventory.value.id;
  const body: S["InventoryStatusDto"] = { status, reason: reason.value.trim() };
  await run(
    `inventory:${id}:status`,
    body,
    async (frozen, key) =>
      requireData(
        await apiClient.POST(
          "/admin/nodes/{nodeId}/inventories/{inventoryId}/status",
          {
            params: {
              path: { nodeId: nodeId.value, inventoryId: id },
              header: commandHeaders(key),
            },
            body: frozen,
          },
        ),
      ),
    "Stav šarže byl změněn.",
  );
}

async function adjustInventory(): Promise<void> {
  if (!inventory.value || !reason.value.trim()) return;
  const id = inventory.value.id;
  const body: S["InventoryAdjustmentDto"] = {
    deltaMilligrams: adjustmentMilligrams.value,
    reason: reason.value.trim(),
  };
  await run(
    `inventory:${id}:adjust`,
    body,
    async (frozen, key) =>
      requireData(
        await apiClient.POST(
          "/admin/nodes/{nodeId}/inventories/{inventoryId}/adjustments",
          {
            params: {
              path: { nodeId: nodeId.value, inventoryId: id },
              header: commandHeaders(key),
            },
            body: frozen,
          },
        ),
      ),
    "Množství bylo upraveno. Rezervovaná hmotnost zůstává chráněna.",
  );
}

async function publishAvailability(): Promise<void> {
  if (
    !availability.value ||
    !reason.value.trim() ||
    busy.value ||
    loading.value
  )
    return;
  const machineId = availabilityMachineId.value;
  if (availability.value.machineId !== machineId) return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    const body: S["ReplaceMachineAvailabilityDto"] = {
      expectedVersion: availability.value.selectionVersion ?? null,
      reason: reason.value.trim(),
      windows: windows.value.map((item) => ({
        startsAt: isoFromZonedInput(item.startsAt),
        endsAt: isoFromZonedInput(item.endsAt),
      })),
    };
    await journal.submit(
      `machine:${machineId}:availability`,
      body,
      async (frozen, key) =>
        requireData(
          await apiClient.POST(
            "/admin/nodes/{nodeId}/machines/{machineId}/availability",
            {
              params: {
                path: {
                  nodeId: nodeId.value,
                  machineId,
                },
                header: commandHeaders(key),
              },
              body: frozen,
            },
          ),
        ),
    );
    success.value =
      "Dostupnost byla publikována pro nové rezervace. Existující potvrzené rezervace zůstávají zachovány.";
    await inspectAvailability();
  } catch (cause) {
    error.value = errorMessage(cause);
    if (cause instanceof OperatorRequestError && cause.status === 409) {
      const conflict = errorMessage(cause);
      await inspectAvailability();
      error.value = `Publikace koliduje s aktuální verzí nebo živou rezervací. ${conflict} Zkontrolujte intervaly a potvrďte změnu znovu.`;
    }
  } finally {
    busy.value = false;
  }
}

onMounted(() => void refresh());
</script>

<template>
  <section class="operator-page">
    <p class="eyebrow">Provozní uzel {{ nodeId }}</p>
    <h1>Stroje a sklad</h1>
    <p>
      Stav nasazení, dostupná hmotnost, rezervovaná hmotnost a nákupní cena jsou
      samostatné údaje. Nabízené barvy vycházejí ze skutečně způsobilých zásob.
    </p>
    <button type="button" :disabled="loading || busy" @click="refresh">
      Obnovit zdroje
    </button>
    <p v-if="loading" role="status">Načítám zdroje…</p>
    <p v-if="error" role="alert" class="form-error">
      {{ error }}
    </p>
    <p v-if="success" role="status" class="form-success">
      {{ success }}
    </p>
    <label v-if="canWrite" class="operator-reason"
      >Důvod změny <input v-model="reason"
    /></label>

    <section class="operator-card">
      <h2>Stroje</h2>
      <ul class="operator-list">
        <li v-for="machine in machines" :key="machine.id">
          <strong>{{ machine.displayName }}</strong> · {{ machine.code }} ·
          {{ machine.status }} · tryska
          {{ machine.installedNozzleMicrometers }} µm
          <button
            class="text-action"
            type="button"
            :disabled="busy"
            @click="
              availabilityMachineId = machine.id;
              availability = null;
              windows = [];
              inspectAvailability();
            "
          >
            Dostupnost
          </button>
          <template v-if="canWrite">
            <button
              type="button"
              :disabled="
                busy || loading || inventoryRefreshRequired || !reason.trim()
              "
              @click="machineStatus(machine.id, 'ACTIVE')"
            >
              Aktivní</button
            ><button
              type="button"
              :disabled="
                busy || loading || inventoryRefreshRequired || !reason.trim()
              "
              @click="machineStatus(machine.id, 'MAINTENANCE')"
            >
              Údržba</button
            ><button
              type="button"
              :disabled="
                busy || loading || inventoryRefreshRequired || !reason.trim()
              "
              @click="machineStatus(machine.id, 'DISABLED')"
            >
              Vypnout
            </button>
          </template>
        </li>
      </ul>
      <button
        v-if="machineCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('machine')"
      >
        Další stroje
      </button>
      <button v-if="canWrite" type="button" @click="form = 'machine'">
        Registrovat stroj
      </button>
    </section>

    <section v-if="availabilityMachineId" class="operator-card">
      <h2>Dostupnost stroje</h2>
      <p>
        Intervaly jsou absolutní. Zadejte ISO čas s pražským posunem +01:00 nebo
        +02:00. Při změně letního času použijte správný posun pro každý krajní
        bod. Prázdný seznam pozastaví nová přijetí.
      </p>
      <div class="operator-inline">
        <label>Od <input v-model="from" /></label
        ><label>Do <input v-model="to" /></label
        ><button type="button" @click="inspectAvailability()">Načíst</button>
      </div>
      <p v-if="availability">
        Verze výběru {{ availability.selectionVersion ?? "dosud nezaložena" }} ·
        revize {{ availability.revisionId ?? "žádná" }}
      </p>
      <h3>Obsazené intervaly</h3>
      <ul class="operator-list">
        <li
          v-for="item in availability?.occupiedIntervals ?? []"
          :key="item.id"
        >
          {{ formatPragueInstant(item.startsAt) }} –
          {{ formatPragueInstant(item.endsAt) }} · {{ item.status }} ·
          {{ item.id }}
        </li>
      </ul>
      <p v-if="!availability?.occupiedIntervals.length">
        V zobrazeném rozsahu žádné.
      </p>
      <form
        v-if="canWrite && availability"
        class="operator-form"
        @submit.prevent="publishAvailability"
      >
        <h3>Okna pro nové přijetí</h3>
        <div
          v-for="(window, index) in windows"
          :key="index"
          class="operator-inline"
        >
          <label>Začátek <input v-model="window.startsAt" required /></label
          ><label>Konec <input v-model="window.endsAt" required /></label>
          <button type="button" @click="windows.splice(index, 1)">
            Odebrat
          </button>
        </div>
        <div class="operator-actions">
          <button
            type="button"
            @click="windows.push({ startsAt: from, endsAt: to })"
          >
            Přidat okno</button
          ><button type="submit" :disabled="busy || loading || !reason.trim()">
            Publikovat dostupnost
          </button>
        </div>
      </form>
    </section>

    <section class="operator-card">
      <h2>Kalibrace</h2>
      <ul class="operator-list">
        <li v-for="item in calibrations" :key="item.id">
          Stroj {{ item.machineId }} · {{ item.state }} · průtok
          {{ item.flowRatioPartsPerMillion }} ppm
          <template v-if="canWrite">
            <button
              type="button"
              :disabled="
                busy || loading || inventoryRefreshRequired || !reason.trim()
              "
              @click="calibrationAction(item.id, 'activate')"
            >
              Aktivovat</button
            ><button
              type="button"
              :disabled="
                busy || loading || inventoryRefreshRequired || !reason.trim()
              "
              @click="calibrationAction(item.id, 'retire')"
            >
              Vyřadit
            </button>
          </template>
        </li>
      </ul>
      <button
        v-if="calibrationCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('calibration')"
      >
        Další kalibrace
      </button>
      <button v-if="canWrite" type="button" @click="form = 'calibration'">
        Nová kalibrace
      </button>
    </section>

    <section class="operator-card">
      <h2>Skladové šarže</h2>
      <ul class="operator-list">
        <li v-for="item in inventories" :key="item.id">
          <strong>{{ item.sku }}</strong> · {{ item.material }}
          {{ item.color ?? "bez barvy" }} · {{ item.status }} · nasazení
          {{ item.mountStatus }} · příjem {{ item.receiptCoverage }}<br />
          Zbývá {{ item.remainingMilligrams }} mg · rezervováno
          {{ item.reservedMilligrams }} mg · dostupné
          {{ item.availableMilligrams }} mg
          <button
            class="text-action"
            type="button"
            @click="selectInventory(item.id)"
          >
            Detail a rychlé změny
          </button>
        </li>
      </ul>
      <button
        v-if="inventoryCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('inventory')"
      >
        Další šarže
      </button>
      <button v-if="canWrite" type="button" @click="form = 'receipt'">
        Přijmout novou šarži
      </button>
    </section>

    <section v-if="inventory" class="operator-card">
      <h2>Šarže {{ inventory.sku }}</h2>
      <p>
        {{ inventory.vendor }} · {{ inventory.lotCode ?? "bez čísla šarže" }} ·
        {{ inventory.currency }} · nákupní cena
        {{ inventory.priceMinorUnitsNumerator }} /
        {{ inventory.priceMinorUnitsDenominator }} minor jednotek za mg
      </p>
      <p>
        Dostupné {{ inventory.availableMilligrams }} mg · rezervované
        {{ inventory.reservedMilligrams }} mg · zbývající
        {{ inventory.remainingMilligrams }} mg · nasazení
        {{ inventory.mountStatus }}
      </p>
      <h3>Doklady příjmu</h3>
      <ul class="operator-list">
        <li v-for="receipt in inventory.receipts" :key="receipt.id">
          {{ receipt.kind }} · {{ formatPragueInstant(receipt.purchasedAt) }} ·
          {{ receipt.vendor }} · {{ receipt.receivedMilligrams }} mg ·
          {{ receipt.priceMinorUnitsNumerator }}/{{
            receipt.priceMinorUnitsDenominator
          }}
          · {{ receipt.id }}
        </li>
      </ul>
      <template v-if="canWrite">
        <div class="operator-actions">
          <button
            type="button"
            :disabled="
              busy || loading || inventoryRefreshRequired || !reason.trim()
            "
            @click="mount('MOUNTED')"
          >
            Nasadit</button
          ><button
            type="button"
            :disabled="
              busy || loading || inventoryRefreshRequired || !reason.trim()
            "
            @click="mount('UNMOUNTED')"
          >
            Sundat</button
          ><button
            type="button"
            :disabled="
              busy || loading || inventoryRefreshRequired || !reason.trim()
            "
            @click="changeInventoryStatus('AVAILABLE')"
          >
            Dostupné</button
          ><button
            type="button"
            :disabled="
              busy || loading || inventoryRefreshRequired || !reason.trim()
            "
            @click="changeInventoryStatus('DEPLETED')"
          >
            Vyčerpané</button
          ><button
            type="button"
            :disabled="
              busy || loading || inventoryRefreshRequired || !reason.trim()
            "
            @click="changeInventoryStatus('RETIRED')"
          >
            Vyřadit
          </button>
        </div>
        <form class="operator-inline" @submit.prevent="adjustInventory">
          <label
            >Změna množství v mg (znaménko +/−)
            <input v-model="adjustmentMilligrams" required /></label
          ><button
            type="submit"
            :disabled="
              busy || loading || inventoryRefreshRequired || !reason.trim()
            "
          >
            Upravit množství
          </button>
        </form>
        <div class="operator-actions">
          <button
            v-if="inventory.receiptCoverage === 'UNKNOWN'"
            type="button"
            @click="openLegacyReceipt"
          >
            Doplnit počáteční doklad</button
          ><button v-if="currentReceipt" type="button" @click="openCorrection">
            Opravit doklad
          </button>
        </div>
      </template>
    </section>

    <section v-if="canWrite && form" class="operator-card">
      <h2>
        {{
          form === "receipt"
            ? "Nová skladová šarže"
            : form === "machine"
              ? "Nový stroj"
              : form === "calibration"
                ? "Nová kalibrace"
                : form === "correction"
                  ? "Oprava dokladu"
                  : "Počáteční doklad"
        }}
      </h2>
      <form
        class="operator-form"
        @submit.prevent="
          form === 'machine'
            ? registerMachine()
            : form === 'calibration'
              ? createCalibration()
              : form === 'receipt'
                ? receiveInventory()
                : form === 'correction'
                  ? correctReceipt()
                  : legacyReceipt()
        "
      >
        <template v-if="form === 'machine'">
          <label>Kód <input v-model="machineCode" required /></label
          ><label>Název <input v-model="machineName" required /></label
          ><label
            >Schopnost
            <select v-model="machineCapabilityId" required>
              <option value="">Vyberte</option>
              <option
                v-for="item in capabilities"
                :key="item.id"
                :value="item.id"
              >
                {{ item.capabilityKey }}
              </option>
            </select></label
          ><button
            v-if="capabilityCursor"
            type="button"
            :disabled="loading || busy"
            @click="more('capability')"
          >
            Další schopnosti</button
          ><label
            >Tryska µm
            <input
              v-model.number="installedNozzle"
              type="number"
              min="1"
              required
          /></label>
        </template>
        <template v-else-if="form === 'calibration'">
          <label
            >Stroj
            <select v-model="formMachineId" required>
              <option value="">Vyberte</option>
              <option v-for="item in machines" :key="item.id" :value="item.id">
                {{ item.displayName }}
              </option>
            </select></label
          ><label
            >Průtok ppm
            <input v-model.number="flowRatio" type="number" required /></label
          ><label
            >XY korekce µm
            <input
              v-model.number="xyCompensation"
              type="number"
              required /></label
          ><label
            >Elephant foot µm
            <input
              v-model.number="elephantFoot"
              type="number"
              required /></label
          ><label
            >Nastavení JSON <textarea v-model="calibrationSettings" rows="6" />
          </label>
        </template>
        <template v-else>
          <template v-if="form === 'receipt'">
            <label
              >Stroj
              <select v-model="formMachineId" required>
                <option value="">Vyberte</option>
                <option
                  v-for="item in machines"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.displayName }}
                </option>
              </select></label
            ><label>SKU <input v-model="sku" required /></label
            ><label>Číslo šarže <input v-model="lotCode" /></label
            ><label
              >Materiál
              <select v-model="material">
                <option>PLA</option>
                <option>PETG</option>
              </select></label
            ><label>Barva <input v-model="color" /></label>
          </template>
          <label>Dodavatel <input v-model="vendor" required /></label
          ><label
            >Nakoupeno (ISO s posunem)
            <input v-model="purchasedAt" required /></label
          ><label
            >Přijaté množství mg
            <input
              v-model="receivedMilligrams"
              inputmode="numeric"
              required /></label
          ><label
            >Jednotková cena čitatel (minor jednotky)
            <input
              v-model="priceNumerator"
              inputmode="numeric"
              required /></label
          ><label
            >Jednotková cena jmenovatel (mg)
            <input v-model="priceDenominator" inputmode="numeric" required
          /></label>
          <p v-if="form === 'correction'">
            Nahrazený doklad {{ supersedesReceiptId }}
          </p>
        </template>
        <button
          type="submit"
          :disabled="
            busy ||
            loading ||
            inventoryRefreshRequired ||
            ((form === 'correction' || form === 'legacy-receipt') &&
              !reason.trim())
          "
        >
          Zapsat</button
        ><button type="button" @click="form = ''">Zavřít</button>
      </form>
    </section>
  </section>
</template>
