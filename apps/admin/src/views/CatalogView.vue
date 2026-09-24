<script setup lang="ts">
import type { components } from "@taven/openapi-client";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { apiClient } from "../api";
import { CommandIntent } from "../command-intent";
import { CursorPager } from "../cursor-pager";
import { formatPragueInstant } from "../format";
import {
  commandHeaders,
  CommandJournal,
  errorMessage,
  OperatorRequestError,
  parseJsonObject,
  requireData,
} from "../operator-requests";
import { hasPermission } from "../session";

type S = components["schemas"];
type Notice = S["ReferenceProfileActivationNoticeDto"];
type Price = S["PriceListReadDto"];
type Reference = S["ReferenceProfileReadDto"];
type MachineProfile = S["MachineProfileReadDto"];
type Config = S["PrintConfigRevisionReadDto"];
type Capability = S["MachineCapabilityReadDto"];

const canWrite = computed(() => hasPermission("catalog:write"));
const busy = ref(false);
const loading = ref(false);
const error = ref("");
const success = ref("");
const prices = ref<Price[]>([]);
const references = ref<Reference[]>([]);
const profiles = ref<MachineProfile[]>([]);
const configs = ref<Config[]>([]);
const capabilities = ref<Capability[]>([]);
const priceCursor = ref<string | null>(null);
const referenceCursor = ref<string | null>(null);
const profileCursor = ref<string | null>(null);
const configCursor = ref<string | null>(null);
const capabilityCursor = ref<string | null>(null);
const selection = ref<S["CommercialPolicySelectionDto"] | null>(null);
const selectedPrice = ref<S["PriceListDetailDto"] | null>(null);
const priceDetailPending = ref(false);
const requestedPriceId = ref("");
const selectedQuoteParameters = computed(() => {
  const parameters = selectedPrice.value?.parameters;
  return parameters && "automaticQuote" in parameters
    ? parameters.automaticQuote
    : null;
});
const selectedReference = ref<S["ReferenceProfileDetailDto"] | null>(null);
const selectedProfile = ref<S["MachineProfileDetailDto"] | null>(null);
const selectedConfig = ref<S["PrintConfigRevisionDetailDto"] | null>(null);
const selectedCapability = ref<Capability | null>(null);
const referenceDetailPending = ref(false);
const profileDetailPending = ref(false);
const configDetailPending = ref(false);
const requestedReferenceId = ref("");
const requestedProfileId = ref("");
const requestedConfigId = ref("");
const localNotices = ref<Notice[]>([]);
const noticeItems = ref<Notice[]>([]);
const noticeNext = ref<string | null>(null);
const notices = computed(() => {
  const byId = new Map<string, Notice>();
  for (const item of [...localNotices.value, ...noticeItems.value])
    byId.set(item.id, item);
  return [...byId.values()].sort((a, b) =>
    b.activatedAt.localeCompare(a.activatedAt),
  );
});
const noticePager = new CursorPager<Notice>(async (cursor, signal) => {
  const page = requireData(
    await apiClient.GET("/admin/catalog/reference-profile-activation-notices", {
      params: { query: { limit: 20, ...(cursor ? { cursor } : {}) } },
      signal,
    }),
  );
  return { items: page.items, nextCursor: page.nextCursor ?? null };
});

const editor = ref<
  "price" | "reference" | "profile" | "config" | "capability" | ""
>("");
const priceRevision = ref("");
const termsRevision = ref("");
const priceParameters = ref("{}");
const material = ref<"PLA" | "PETG">("PLA");
const quality = ref<"DRAFT" | "STANDARD" | "FINE">("STANDARD");
const slicerEngine = ref("");
const slicerVersion = ref("");
const settings = ref("{}");
const capabilityId = ref("");
const referenceId = ref("");
const nozzle = ref(400);
const artifactFormat = ref<"GCODE_3MF" | "BGCODE" | "GCODE">("GCODE_3MF");
const infill = ref(20);
const layerHeight = ref(200);
const brim = ref(false);
const supports = ref(false);
const capabilityKey = ref("");
const manufacturer = ref("");
const model = ref("");
const volumeX = ref("220000");
const volumeY = ref("220000");
const volumeZ = ref("250000");
const supportsPla = ref(true);
const supportsPetg = ref(false);
const supportedNozzles = ref("400");
const actionReason = ref("");
const journal = new CommandJournal();

let activationIntent: CommandIntent<
  S["ActivateCommercialPolicyDto"],
  S["CommercialPolicyActivationResultDto"]
> | null = null;
let activationSignature = "";
let priceReadGeneration = 0;
let referenceReadGeneration = 0;
let profileReadGeneration = 0;
let configReadGeneration = 0;
let capabilityReadGeneration = 0;

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [
      pricePage,
      referencePage,
      profilePage,
      configPage,
      capabilityPage,
      policy,
    ] = await Promise.all([
      apiClient.GET("/admin/catalog/price-lists", {
        params: { query: { limit: 100 } },
      }),
      apiClient.GET("/admin/catalog/reference-profiles", {
        params: { query: { limit: 100 } },
      }),
      apiClient.GET("/admin/catalog/machine-profiles", {
        params: { query: { limit: 100 } },
      }),
      apiClient.GET("/admin/catalog/print-config-revisions", {
        params: { query: { limit: 100 } },
      }),
      apiClient.GET("/admin/catalog/machine-capabilities", {
        params: { query: { limit: 100 } },
      }),
      apiClient.GET("/admin/catalog/commercial-policy-selections/{currency}", {
        params: { path: { currency: "CZK" } },
      }),
    ]);
    const priceData = requireData(pricePage);
    const referenceData = requireData(referencePage);
    const profileData = requireData(profilePage);
    const configData = requireData(configPage);
    const capabilityData = requireData(capabilityPage);
    prices.value = priceData.items;
    priceCursor.value = priceData.nextCursor ?? null;
    references.value = referenceData.items;
    referenceCursor.value = referenceData.nextCursor ?? null;
    profiles.value = profileData.items;
    profileCursor.value = profileData.nextCursor ?? null;
    configs.value = configData.items;
    configCursor.value = configData.nextCursor ?? null;
    capabilities.value = capabilityData.items;
    capabilityCursor.value = capabilityData.nextCursor ?? null;
    selection.value = requireData(policy);
    if (selectedPrice.value?.id !== selection.value.priceListId)
      await inspectPrice(selection.value.priceListId);
    await refreshNotices();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    loading.value = false;
  }
}

async function more(
  kind: "price" | "reference" | "profile" | "config" | "capability",
): Promise<void> {
  const cursors = {
    price: priceCursor,
    reference: referenceCursor,
    profile: profileCursor,
    config: configCursor,
    capability: capabilityCursor,
  };
  const cursor = cursors[kind].value;
  if (!cursor || loading.value || busy.value) return;
  loading.value = true;
  try {
    if (kind === "price") {
      const page = requireData(
        await apiClient.GET("/admin/catalog/price-lists", {
          params: { query: { limit: 100, cursor } },
        }),
      );
      prices.value = [...prices.value, ...page.items];
      priceCursor.value = page.nextCursor ?? null;
    } else if (kind === "reference") {
      const page = requireData(
        await apiClient.GET("/admin/catalog/reference-profiles", {
          params: { query: { limit: 100, cursor } },
        }),
      );
      references.value = [...references.value, ...page.items];
      referenceCursor.value = page.nextCursor ?? null;
    } else if (kind === "profile") {
      const page = requireData(
        await apiClient.GET("/admin/catalog/machine-profiles", {
          params: { query: { limit: 100, cursor } },
        }),
      );
      profiles.value = [...profiles.value, ...page.items];
      profileCursor.value = page.nextCursor ?? null;
    } else if (kind === "config") {
      const page = requireData(
        await apiClient.GET("/admin/catalog/print-config-revisions", {
          params: { query: { limit: 100, cursor } },
        }),
      );
      configs.value = [...configs.value, ...page.items];
      configCursor.value = page.nextCursor ?? null;
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

async function refreshNotices(): Promise<void> {
  await noticePager.reset("activation-notices");
  noticeItems.value = [...noticePager.items];
  noticeNext.value = noticePager.nextCursor;
}

async function moreNotices(): Promise<void> {
  try {
    await noticePager.more();
    noticeItems.value = [...noticePager.items];
    noticeNext.value = noticePager.nextCursor;
  } catch (cause) {
    error.value = errorMessage(cause);
  }
}

async function inspectPrice(id: string): Promise<void> {
  const generation = ++priceReadGeneration;
  requestedPriceId.value = id;
  priceDetailPending.value = true;
  try {
    const detail = requireData(
      await apiClient.GET("/admin/catalog/price-lists/{id}", {
        params: { path: { id } },
      }),
    );
    if (generation !== priceReadGeneration) return;
    selectedPrice.value = detail;
    if (editor.value !== "price") {
      priceParameters.value = JSON.stringify(
        selectedPrice.value.parameters,
        null,
        2,
      );
      termsRevision.value = selectedPrice.value.termsRevision;
    }
  } catch (cause) {
    if (generation === priceReadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === priceReadGeneration) priceDetailPending.value = false;
  }
}

async function inspectReference(id: string): Promise<void> {
  const generation = ++referenceReadGeneration;
  requestedReferenceId.value = id;
  referenceDetailPending.value = true;
  try {
    const detail = requireData(
      await apiClient.GET("/admin/catalog/reference-profiles/{id}", {
        params: { path: { id } },
      }),
    );
    if (generation === referenceReadGeneration)
      selectedReference.value = detail;
  } catch (cause) {
    if (generation === referenceReadGeneration)
      error.value = errorMessage(cause);
  } finally {
    if (generation === referenceReadGeneration)
      referenceDetailPending.value = false;
  }
}

async function inspectProfile(id: string): Promise<void> {
  const generation = ++profileReadGeneration;
  requestedProfileId.value = id;
  profileDetailPending.value = true;
  try {
    const detail = requireData(
      await apiClient.GET("/admin/catalog/machine-profiles/{id}", {
        params: { path: { id } },
      }),
    );
    if (generation === profileReadGeneration) selectedProfile.value = detail;
  } catch (cause) {
    if (generation === profileReadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === profileReadGeneration)
      profileDetailPending.value = false;
  }
}

async function inspectConfig(id: string): Promise<void> {
  const generation = ++configReadGeneration;
  requestedConfigId.value = id;
  configDetailPending.value = true;
  try {
    const detail = requireData(
      await apiClient.GET("/admin/catalog/print-config-revisions/{id}", {
        params: { path: { id } },
      }),
    );
    if (generation === configReadGeneration) selectedConfig.value = detail;
  } catch (cause) {
    if (generation === configReadGeneration) error.value = errorMessage(cause);
  } finally {
    if (generation === configReadGeneration) configDetailPending.value = false;
  }
}

async function inspectCapability(id: string): Promise<void> {
  const generation = ++capabilityReadGeneration;
  try {
    const detail = requireData(
      await apiClient.GET("/admin/catalog/machine-capabilities/{id}", {
        params: { path: { id } },
      }),
    );
    if (generation === capabilityReadGeneration)
      selectedCapability.value = detail;
  } catch (cause) {
    if (generation === capabilityReadGeneration)
      error.value = errorMessage(cause);
  }
}

function edit(type: typeof editor.value): void {
  if (busy.value || loading.value) return;
  if (
    type === "price" &&
    (priceDetailPending.value ||
      !selectedPrice.value ||
      selectedPrice.value.id !== requestedPriceId.value)
  )
    return;
  if (
    (type === "reference" &&
      (referenceDetailPending.value ||
        (requestedReferenceId.value &&
          selectedReference.value?.id !== requestedReferenceId.value))) ||
    (type === "profile" &&
      (profileDetailPending.value ||
        (requestedProfileId.value &&
          selectedProfile.value?.id !== requestedProfileId.value))) ||
    (type === "config" &&
      (configDetailPending.value ||
        (requestedConfigId.value &&
          selectedConfig.value?.id !== requestedConfigId.value)))
  )
    return;
  editor.value = type;
  error.value = "";
  success.value = "";
  if (type === "price" && selectedPrice.value) {
    priceParameters.value = JSON.stringify(
      selectedPrice.value.parameters,
      null,
      2,
    );
    termsRevision.value = selectedPrice.value.termsRevision;
  }
  if (type === "reference" && selectedReference.value) {
    material.value = selectedReference.value.material as typeof material.value;
    quality.value = selectedReference.value.quality as typeof quality.value;
    slicerEngine.value = selectedReference.value.slicerEngine;
    slicerVersion.value = selectedReference.value.slicerVersion;
    settings.value = JSON.stringify(selectedReference.value.settings, null, 2);
  }
  if (type === "profile" && selectedProfile.value) {
    material.value = selectedProfile.value.material as typeof material.value;
    quality.value = selectedProfile.value.quality as typeof quality.value;
    slicerEngine.value = selectedProfile.value.slicerEngine;
    slicerVersion.value = selectedProfile.value.slicerVersion;
    settings.value = JSON.stringify(selectedProfile.value.settings, null, 2);
    capabilityId.value = selectedProfile.value.machineCapabilityId;
    referenceId.value = selectedProfile.value.referenceProfileId;
    nozzle.value = selectedProfile.value.nozzleDiameterMicrometers;
    artifactFormat.value = selectedProfile.value
      .productionArtifactFormat as typeof artifactFormat.value;
  }
  if (type === "config" && selectedConfig.value) {
    quality.value = selectedConfig.value.quality as typeof quality.value;
    infill.value = selectedConfig.value.infillPercent;
    layerHeight.value = selectedConfig.value.layerHeightMicrometers;
    brim.value = selectedConfig.value.brimEnabled;
    supports.value = selectedConfig.value.supportsEnabled;
    settings.value = JSON.stringify(selectedConfig.value.settings, null, 2);
  }
}

async function createRevision(): Promise<void> {
  if (!canWrite.value || busy.value || loading.value) return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    if (editor.value === "price") {
      const body: S["CreatePriceListDto"] = {
        currency: "CZK",
        revision: priceRevision.value.trim(),
        termsRevision: termsRevision.value.trim(),
        parameters: parseJsonObject(
          priceParameters.value,
        ) as S["PriceListParametersDto"],
      };
      await journal.submit("create-price", body, async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/catalog/price-lists", {
            body: frozen,
            params: { header: commandHeaders(key) },
          }),
        ),
      );
    } else if (editor.value === "reference") {
      const body: S["CreateReferenceProfileDto"] = {
        material: material.value,
        quality: quality.value,
        slicerEngine: slicerEngine.value.trim(),
        slicerVersion: slicerVersion.value.trim(),
        settings: parseJsonObject(settings.value),
      };
      await journal.submit("create-reference", body, async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/catalog/reference-profiles", {
            body: frozen,
            params: { header: commandHeaders(key) },
          }),
        ),
      );
    } else if (editor.value === "profile") {
      const body: S["CreateMachineProfileDto"] = {
        material: material.value,
        quality: quality.value,
        slicerEngine: slicerEngine.value.trim(),
        slicerVersion: slicerVersion.value.trim(),
        settings: parseJsonObject(settings.value),
        machineCapabilityId: capabilityId.value,
        referenceProfileId: referenceId.value,
        nozzleDiameterMicrometers: nozzle.value,
        productionArtifactFormat: artifactFormat.value,
      };
      await journal.submit("create-profile", body, async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/catalog/machine-profiles", {
            body: frozen,
            params: { header: commandHeaders(key) },
          }),
        ),
      );
    } else if (editor.value === "config") {
      const body: S["CreatePrintConfigRevisionDto"] = {
        quality: quality.value,
        infillPercent: infill.value,
        layerHeightMicrometers: layerHeight.value,
        brimEnabled: brim.value,
        supportsEnabled: supports.value,
        settings: parseJsonObject(settings.value),
      };
      await journal.submit("create-config", body, async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/catalog/print-config-revisions", {
            body: frozen,
            params: { header: commandHeaders(key) },
          }),
        ),
      );
    } else if (editor.value === "capability") {
      if (!supportsPla.value && !supportsPetg.value)
        throw new Error("Vyberte alespoň jeden materiál.");
      const body: S["CreateMachineCapabilityDto"] = {
        capabilityKey: capabilityKey.value.trim(),
        manufacturer: manufacturer.value.trim(),
        model: model.value.trim(),
        buildVolumeXMicrometers: volumeX.value,
        buildVolumeYMicrometers: volumeY.value,
        buildVolumeZMicrometers: volumeZ.value,
        supportedMaterials: [
          ...(supportsPla.value ? ["PLA" as const] : []),
          ...(supportsPetg.value ? ["PETG" as const] : []),
        ],
        supportedNozzleMicrometers: supportedNozzles.value
          .split(",")
          .map(Number),
      };
      await journal.submit("create-capability", body, async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/catalog/machine-capabilities", {
            body: frozen,
            params: { header: commandHeaders(key) },
          }),
        ),
      );
    } else return;
    success.value =
      "Nová neměnná revize byla vytvořena. Aktivace je samostatný krok.";
    editor.value = "";
    await refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}

async function activatePrice(id: string): Promise<void> {
  if (
    !canWrite.value ||
    busy.value ||
    loading.value ||
    !selection.value ||
    selection.value.priceListId === id ||
    !actionReason.value.trim()
  )
    return;
  const signature = `${id}:${selection.value.selectionVersion}:${actionReason.value.trim()}`;
  const target = prices.value.find((price) => price.id === id);
  if (
    !window.confirm(
      `Publikovat ceník ${target?.revision ?? id} proti verzi výběru ${selection.value.selectionVersion}? Změna platí pro nově potvrzené cenové vazby. Existující vazby a nabídky včetně dosud nepřijatých si zachovají cenu, limity a původní lhůty.`,
    )
  )
    return;
  if (!activationIntent || activationSignature !== signature) {
    activationIntent = new CommandIntent<
      S["ActivateCommercialPolicyDto"],
      S["CommercialPolicyActivationResultDto"]
    >({
      expectedSelectionVersion: selection.value.selectionVersion,
      reason: actionReason.value.trim(),
    });
    activationSignature = signature;
  }
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    const result = await activationIntent.submit(async (body, key) =>
      requireData(
        await apiClient.POST("/admin/catalog/price-lists/{id}/activate", {
          params: { path: { id }, header: commandHeaders(key) },
          body,
        }),
      ),
    );
    activationIntent = null;
    selection.value = {
      currency: result.currency,
      priceListId: result.priceListId,
      selectionVersion: result.selectionVersion,
    };
    success.value =
      "Ceník je vybrán pro nově potvrzené cenové vazby. Existující vazby a nabídky zůstávají připnuté k původní ceně, limitům i lhůtám.";
    await refresh();
    if (error.value)
      error.value = `Publikace byla potvrzena, ale obnovení katalogu selhalo. ${error.value}`;
  } catch (cause) {
    error.value = errorMessage(cause);
    if (cause instanceof OperatorRequestError && cause.status === 409) {
      activationIntent = null;
      selection.value = null;
      await refresh();
      error.value = selection.value
        ? `Výběr ceníku se změnil v jiném okně. Zkontrolujte aktuální verzi a potvrďte změnu znovu.${error.value ? ` ${error.value}` : ""}`
        : `Výběr ceníku se změnil v jiném okně. Obnovení aktuálního výběru selhalo; před další publikací obnovte katalog. ${error.value}`;
    }
  } finally {
    busy.value = false;
  }
}

async function profileAction(
  kind: "reference" | "profile",
  id: string,
  action: "activate" | "retire",
): Promise<void> {
  if (
    !canWrite.value ||
    busy.value ||
    loading.value ||
    !actionReason.value.trim()
  )
    return;
  busy.value = true;
  error.value = "";
  success.value = "";
  try {
    const body = { reason: actionReason.value.trim() };
    if (kind === "reference" && action === "activate") {
      const result = await journal.submit(
        `reference:${id}:activate`,
        body,
        async (frozen, key) =>
          requireData(
            await apiClient.POST(
              "/admin/catalog/reference-profiles/{id}/activate",
              {
                params: { path: { id }, header: commandHeaders(key) },
                body: frozen,
              },
            ),
          ),
      );
      if (result.notice)
        localNotices.value = [result.notice, ...localNotices.value];
    } else if (kind === "reference") {
      await journal.submit(
        `reference:${id}:retire`,
        body,
        async (frozen, key) =>
          requireData(
            await apiClient.POST(
              "/admin/catalog/reference-profiles/{id}/retire",
              {
                params: { path: { id }, header: commandHeaders(key) },
                body: frozen,
              },
            ),
          ),
      );
    } else if (action === "activate") {
      await journal.submit(
        `profile:${id}:activate`,
        body,
        async (frozen, key) =>
          requireData(
            await apiClient.POST(
              "/admin/catalog/machine-profiles/{id}/activate",
              {
                params: { path: { id }, header: commandHeaders(key) },
                body: frozen,
              },
            ),
          ),
      );
    } else {
      await journal.submit(`profile:${id}:retire`, body, async (frozen, key) =>
        requireData(
          await apiClient.POST("/admin/catalog/machine-profiles/{id}/retire", {
            params: { path: { id }, header: commandHeaders(key) },
            body: frozen,
          }),
        ),
      );
    }
    success.value =
      "Změna profilu byla potvrzena. Existující cenové vazby a úlohy zůstávají neměnné.";
    await refresh();
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}

onMounted(() => void refresh());
onUnmounted(() => noticePager.dispose());
</script>

<template>
  <section class="operator-page">
    <p class="eyebrow">Revize a publikace</p>
    <h1>Katalog a ceny</h1>
    <p>
      Nové revize jsou neměnné. Aktivace ovlivní pouze budoucí přípravu a nově
      potvrzené vazby. Existující vazby, nabídky a úlohy si zachovají původní
      podklady.
    </p>
    <button type="button" :disabled="loading || busy" @click="refresh">
      Obnovit katalog a upozornění
    </button>
    <p v-if="loading" role="status">Načítám katalog…</p>
    <p v-if="error" role="alert" class="form-error">
      {{ error }}
    </p>
    <p v-if="success" role="status" class="form-success">
      {{ success }}
    </p>

    <section class="operator-card" aria-labelledby="notices-title">
      <h2 id="notices-title">Aktivace referenčních profilů</h2>
      <p>
        Datovaná historie k samostatné kontrole ceníku. Upozornění neříká, zda
        již byla cena upravena.
      </p>
      <p v-if="!notices.length">Žádná zaznamenaná aktivace.</p>
      <ul v-else class="operator-list">
        <li v-for="notice in notices" :key="notice.id">
          {{ formatPragueInstant(notice.activatedAt) }} ·
          {{ notice.material }} · {{ notice.quality }} ·
          <button
            class="text-action"
            type="button"
            @click="inspectReference(notice.referenceProfileId)"
          >
            Profil {{ notice.referenceProfileId }}
          </button>
          · <a href="#price-lists">Prohlédnout ceníky</a>
        </li>
      </ul>
      <button v-if="noticeNext" type="button" @click="moreNotices">
        Další upozornění
      </button>
    </section>

    <section
      id="price-lists"
      class="operator-card"
      aria-labelledby="prices-title"
    >
      <h2 id="prices-title">Ceníky a obchodní pravidla</h2>
      <p v-if="selection">
        Aktuálně vybraná verze: {{ selection.selectionVersion }} · ceník
        {{ selection.priceListId }}
      </p>
      <p v-else>Aktuální výběr není dostupný; publikace není možná.</p>
      <label v-if="canWrite"
        >Důvod publikace <input v-model="actionReason" required
      /></label>
      <ul class="operator-list">
        <li v-for="price in prices" :key="price.id">
          <strong>{{ price.revision }}</strong> · {{ price.currency }} ·
          podmínky {{ price.termsRevision }} ·
          {{ formatPragueInstant(price.createdAt) }}
          <span v-if="selection?.priceListId === price.id"> · vybráno</span>
          <button
            class="text-action"
            type="button"
            :disabled="loading || busy"
            @click="inspectPrice(price.id)"
          >
            Detail
          </button>
          <button
            v-if="canWrite"
            type="button"
            :disabled="
              busy ||
              loading ||
              !selection ||
              selection.priceListId === price.id ||
              !actionReason.trim()
            "
            @click="activatePrice(price.id)"
          >
            Potvrdit pro nové vazby
          </button>
        </li>
      </ul>
      <button
        v-if="priceCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('price')"
      >
        Další ceníky
      </button>
      <p v-if="!prices.length">Žádné ceníky.</p>
      <div v-if="selectedPrice" class="operator-detail">
        <h3>Revize {{ selectedPrice.revision }}</h3>
        <p>
          Podmínky {{ selectedPrice.termsRevision }} jsou evidencí původu.
          Účinné právní podmínky spravuje právní systém.
        </p>
        <dl v-if="selectedQuoteParameters" class="metric-grid">
          <div>
            <dt>Automatický limit ceny</dt>
            <dd>
              {{ selectedQuoteParameters.maximumAutomaticAmountMinor }} haléřů
            </dd>
          </div>
          <div>
            <dt>Automatický limit kusů</dt>
            <dd>{{ selectedQuoteParameters.maximumAutomaticQuantity }}</dd>
          </div>
          <div>
            <dt>Express: nejvýše podložek</dt>
            <dd>{{ selectedQuoteParameters.expressMaximumPlateCount }}</dd>
          </div>
          <div>
            <dt>Express: výrobní okno</dt>
            <dd>
              {{
                selectedQuoteParameters.expressAvailableProductionWindowSeconds
              }}
              s
            </dd>
          </div>
          <div>
            <dt>Práh dopravy zdarma</dt>
            <dd>
              {{ selectedQuoteParameters.freeShippingPrintThresholdMinor }}
              haléřů
            </dd>
          </div>
          <div>
            <dt>Přepravní kategorie</dt>
            <dd>{{ selectedQuoteParameters.shipmentCategories.length }}</dd>
          </div>
        </dl>
        <p v-else>
          Starší formát parametrů není šablonou pro novou podporovanou revizi.
        </p>
        <pre>{{ JSON.stringify(selectedPrice.parameters, null, 2) }}</pre>
      </div>
      <button
        v-if="canWrite"
        type="button"
        :disabled="
          busy ||
          loading ||
          priceDetailPending ||
          !selectedPrice ||
          selectedPrice.id !== requestedPriceId
        "
        @click="edit('price')"
      >
        Vytvořit revizi ceníku
      </button>
    </section>

    <section class="operator-card" aria-labelledby="references-title">
      <h2 id="references-title">Referenční profily</h2>
      <ul class="operator-list">
        <li v-for="item in references" :key="item.id">
          {{ item.material }} · {{ item.quality }} · {{ item.slicerEngine }}
          {{ item.slicerVersion }} · {{ item.state }}
          <button
            class="text-action"
            type="button"
            @click="inspectReference(item.id)"
          >
            Detail
          </button>
          <button
            v-if="canWrite"
            type="button"
            :disabled="busy || loading || !actionReason.trim()"
            @click="profileAction('reference', item.id, 'activate')"
          >
            Aktivovat
          </button>
          <button
            v-if="canWrite"
            type="button"
            :disabled="busy || loading || !actionReason.trim()"
            @click="profileAction('reference', item.id, 'retire')"
          >
            Vyřadit
          </button>
        </li>
      </ul>
      <div v-if="selectedReference" class="operator-detail">
        <h3>Detail referenčního profilu</h3>
        <p>{{ selectedReference.id }} · {{ selectedReference.state }}</p>
        <pre>{{ JSON.stringify(selectedReference.settings, null, 2) }}</pre>
      </div>
      <button
        v-if="referenceCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('reference')"
      >
        Další referenční profily
      </button>
      <button
        v-if="canWrite"
        type="button"
        :disabled="
          busy ||
          loading ||
          referenceDetailPending ||
          (!!requestedReferenceId &&
            selectedReference?.id !== requestedReferenceId)
        "
        @click="edit('reference')"
      >
        Nová revize profilu
      </button>
    </section>

    <section class="operator-card" aria-labelledby="profiles-title">
      <h2 id="profiles-title">Profily strojů</h2>
      <ul class="operator-list">
        <li v-for="item in profiles" :key="item.id">
          {{ item.material }} · {{ item.quality }} · {{ item.state }} · tryska
          {{ item.nozzleDiameterMicrometers }} µm
          <button
            class="text-action"
            type="button"
            @click="inspectProfile(item.id)"
          >
            Detail
          </button>
          <button
            v-if="canWrite"
            type="button"
            :disabled="busy || loading || !actionReason.trim()"
            @click="profileAction('profile', item.id, 'activate')"
          >
            Aktivovat
          </button>
          <button
            v-if="canWrite"
            type="button"
            :disabled="busy || loading || !actionReason.trim()"
            @click="profileAction('profile', item.id, 'retire')"
          >
            Vyřadit
          </button>
        </li>
      </ul>
      <div v-if="selectedProfile" class="operator-detail">
        <h3>Detail profilu stroje</h3>
        <p>
          Schopnost {{ selectedProfile.machineCapabilityId }} · reference
          {{ selectedProfile.referenceProfileId }}
        </p>
        <pre>{{ JSON.stringify(selectedProfile.settings, null, 2) }}</pre>
      </div>
      <button
        v-if="profileCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('profile')"
      >
        Další profily strojů
      </button>
      <button
        v-if="canWrite"
        type="button"
        :disabled="
          busy ||
          loading ||
          profileDetailPending ||
          (!!requestedProfileId && selectedProfile?.id !== requestedProfileId)
        "
        @click="edit('profile')"
      >
        Nová revize profilu stroje
      </button>
    </section>

    <section class="operator-card" aria-labelledby="configs-title">
      <h2 id="configs-title">Konfigurace tisku</h2>
      <ul class="operator-list">
        <li v-for="item in configs" :key="item.id">
          {{ item.quality }} · {{ item.infillPercent }} % výplň ·
          {{ item.layerHeightMicrometers }} µm vrstva
          <button
            class="text-action"
            type="button"
            @click="inspectConfig(item.id)"
          >
            Detail
          </button>
        </li>
      </ul>
      <div v-if="selectedConfig" class="operator-detail">
        <h3>Detail konfigurace</h3>
        <pre>{{ JSON.stringify(selectedConfig, null, 2) }}</pre>
      </div>
      <button
        v-if="configCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('config')"
      >
        Další konfigurace
      </button>
      <button
        v-if="canWrite"
        type="button"
        :disabled="
          busy ||
          loading ||
          configDetailPending ||
          (!!requestedConfigId && selectedConfig?.id !== requestedConfigId)
        "
        @click="edit('config')"
      >
        Nová revize konfigurace
      </button>
    </section>

    <section class="operator-card" aria-labelledby="capabilities-title">
      <h2 id="capabilities-title">Schopnosti strojů</h2>
      <ul class="operator-list">
        <li v-for="item in capabilities" :key="item.id">
          {{ item.capabilityKey }} · {{ item.manufacturer }} {{ item.model }}
          <button
            class="text-action"
            type="button"
            @click="inspectCapability(item.id)"
          >
            Detail
          </button>
        </li>
      </ul>
      <div v-if="selectedCapability" class="operator-detail">
        <h3>Detail schopnosti</h3>
        <pre>{{ JSON.stringify(selectedCapability, null, 2) }}</pre>
      </div>
      <button
        v-if="capabilityCursor"
        type="button"
        :disabled="loading || busy"
        @click="more('capability')"
      >
        Další schopnosti
      </button>
      <button
        v-if="canWrite"
        type="button"
        :disabled="busy || loading"
        @click="edit('capability')"
      >
        Nová schopnost stroje
      </button>
    </section>

    <section
      v-if="canWrite && editor"
      class="operator-card"
      aria-labelledby="editor-title"
    >
      <h2 id="editor-title">Nová neměnná revize: {{ editor }}</h2>
      <p>
        Vytvoření samo nic nepublikuje. Zkontrolujte budoucí rozsah před
        samostatnou aktivací.
      </p>
      <form class="operator-form" @submit.prevent="createRevision">
        <template v-if="editor === 'price'">
          <label
            >Označení revize <input v-model="priceRevision" required
          /></label>
          <label
            >Revize podmínek <input v-model="termsRevision" required
          /></label>
          <label
            >Úplné cenové parametry JSON
            <textarea v-model="priceParameters" rows="16" required />
          </label>
        </template>
        <template v-if="editor === 'reference' || editor === 'profile'">
          <label
            >Materiál
            <select v-model="material">
              <option>PLA</option>
              <option>PETG</option>
            </select></label
          >
          <label
            >Kvalita
            <select v-model="quality">
              <option>DRAFT</option>
              <option>STANDARD</option>
              <option>FINE</option>
            </select></label
          >
          <label>Slicer <input v-model="slicerEngine" required /></label>
          <label
            >Verze sliceru <input v-model="slicerVersion" required
          /></label>
          <label
            >Nastavení JSON <textarea v-model="settings" rows="10" required />
          </label>
          <template v-if="editor === 'profile'">
            <label
              >Schopnost stroje
              <select v-model="capabilityId" required>
                <option value="">Vyberte</option>
                <option
                  v-for="item in capabilities"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.capabilityKey }}
                </option>
              </select></label
            >
            <label
              >Referenční profil
              <select v-model="referenceId" required>
                <option value="">Vyberte</option>
                <option
                  v-for="item in references"
                  :key="item.id"
                  :value="item.id"
                >
                  {{ item.material }} · {{ item.quality }} · {{ item.id }}
                </option>
              </select></label
            >
            <label
              >Tryska µm
              <input v-model.number="nozzle" type="number" min="1" required
            /></label>
            <label
              >Výstupní formát
              <select v-model="artifactFormat">
                <option>GCODE_3MF</option>
                <option>BGCODE</option>
                <option>GCODE</option>
              </select></label
            >
          </template>
        </template>
        <template v-if="editor === 'config'">
          <label
            >Kvalita
            <select v-model="quality">
              <option>DRAFT</option>
              <option>STANDARD</option>
              <option>FINE</option>
            </select></label
          >
          <label
            >Výplň %
            <input
              v-model.number="infill"
              type="number"
              min="0"
              max="100"
              required
          /></label>
          <label
            >Výška vrstvy µm
            <input v-model.number="layerHeight" type="number" min="1" required
          /></label>
          <label><input v-model="brim" type="checkbox" /> Brim</label>
          <label><input v-model="supports" type="checkbox" /> Podpory</label>
          <label
            >Nastavení JSON <textarea v-model="settings" rows="10" required />
          </label>
        </template>
        <template v-if="editor === 'capability'">
          <label
            >Klíč schopnosti <input v-model="capabilityKey" required
          /></label>
          <label>Výrobce <input v-model="manufacturer" required /></label>
          <label>Model <input v-model="model" required /></label>
          <label
            >Objem X µm <input v-model="volumeX" inputmode="numeric" required
          /></label>
          <label
            >Objem Y µm <input v-model="volumeY" inputmode="numeric" required
          /></label>
          <label
            >Objem Z µm <input v-model="volumeZ" inputmode="numeric" required
          /></label>
          <fieldset>
            <legend>Podporované materiály</legend>
            <label><input v-model="supportsPla" type="checkbox" /> PLA</label
            ><label
              ><input v-model="supportsPetg" type="checkbox" /> PETG</label
            >
          </fieldset>
          <label
            >Trysky µm, oddělené čárkou
            <input v-model="supportedNozzles" required
          /></label>
        </template>
        <div class="operator-actions">
          <button type="submit" :disabled="busy || loading">
            Vytvořit revizi</button
          ><button type="button" :disabled="busy" @click="editor = ''">
            Zavřít
          </button>
        </div>
      </form>
    </section>
  </section>
</template>
