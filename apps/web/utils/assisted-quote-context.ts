import type { StorageLike } from "./quote-session-storage";

const STORAGE_KEY = "taven:assisted-quote-handoff:v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AssistedQuoteEntrySource =
  "automatic-quote" | "blocked-3mf" | "individual-file" | "no-file";

export interface AssistedQuoteItemContext {
  bodyIds: string[];
  fitSensitive: boolean;
  material: string;
  modelFileId: string;
  ordinal: number;
  quantity: number;
}

export interface AssistedQuoteHandoffContext {
  automaticQuoteSessionId: string;
  expiresAt: string;
  itemSelections: AssistedQuoteItemContext[];
  modelFileIds: string[];
  reasons: string[];
}

export interface AssistedQuotePrefill {
  description: string;
  note: string;
}

export function normalizeAssistedQuoteSource(
  value: unknown,
): AssistedQuoteEntrySource {
  const source = Array.isArray(value) ? value[0] : value;
  return source === "automatic-quote" ||
    source === "blocked-3mf" ||
    source === "individual-file"
    ? source
    : "no-file";
}

export function assistedQuotePrefill(
  source: AssistedQuoteEntrySource,
  context?: AssistedQuoteHandoffContext,
): AssistedQuotePrefill {
  if (source === "blocked-3mf") {
    return {
      description:
        "Potřebuji individuálně posoudit 3MF model s více materiály nebo barvami.",
      note: "Soubor z přímé kalkulace jsme do poptávky nezkopírovali. Přiložte prosím referenční fotografie a popište požadované barvy nebo materiály.",
    };
  }
  if (source === "individual-file") {
    return {
      description:
        "Potřebuji individuálně posoudit podklady, které nejsou vhodné pro přímou kalkulaci.",
      note: "Nepodporovaný ani neúspěšně načtený soubor se automaticky nepřenáší. Popište požadovaný výsledek a přidejte bezpečné referenční fotografie.",
    };
  }
  if (source === "automatic-quote") {
    const reasons = new Set(context?.reasons ?? []);
    if (reasons.has("RISK_DECLINED")) {
      return {
        description:
          "Potřebuji individuálně posoudit model, protože nechci přijmout riziko nalezené při automatické kontrole.",
        note: context
          ? "Přenesli jsme jen bezpečný technický kontext kalkulace. Cena ani obsah souboru se nepřenášejí."
          : "Původní kalkulace už není dostupná, proto její technický kontext nepřenášíme.",
      };
    }
    if (reasons.has("FIT_SENSITIVE")) {
      return {
        description:
          "Potřebuji individuální nabídku pro lícovaný díl, u kterého je důležitá přesnost rozměrů.",
        note: context
          ? "Přenesli jsme jen bezpečné volby z kalkulace. Výslednou toleranci prosím upřesněte v popisu."
          : "Původní kalkulace už není dostupná. Požadované tolerance prosím doplňte ručně.",
      };
    }
    if (
      reasons.has("AUTOMATIC_QUANTITY_LIMIT_EXCEEDED") ||
      reasons.has("BUILD_LIMIT_EXCEEDED")
    ) {
      return {
        description:
          "Potřebuji individuální nabídku pro zakázku mimo limity přímé kalkulace.",
        note: context
          ? "Přenesli jsme jen bezpečné technické volby a množství. Automatická cena se nepřenáší."
          : "Původní kalkulace už není dostupná, proto rozměry a množství doplňte znovu.",
      };
    }
    if (reasons.has("NO_CONFIGURATION_AVAILABLE")) {
      return {
        description:
          "Potřebuji individuální nabídku pro materiál nebo výrobní kombinaci, kterou přímá kalkulace nenabízí.",
        note: context
          ? "Přenesli jsme jen bezpečný technický kontext, nikoli cenu nebo obsah souboru."
          : "Původní kalkulace už není dostupná. Požadovaný materiál a provedení doplňte ručně.",
      };
    }
    return {
      description:
        "Potřebuji individuálně posoudit zakázku, kterou nelze bezpečně nacenit automaticky.",
      note: context
        ? "Přenesli jsme jen bezpečný technický kontext kalkulace. Automatická cena se nepřenáší."
        : "Původní kalkulace už není dostupná, proto její technický kontext nepřenášíme.",
    };
  }
  return {
    description: "",
    note: "Model není podmínkou. Popište díl, doplňte rozměry a ideálně přiložte fotografie ze tří stran s předmětem známé velikosti.",
  };
}

export function sanitizeAssistedQuoteHandoff(
  handoff: { reasons: readonly string[]; safeContext: unknown },
  expiresAt: string,
  now = Date.now(),
): AssistedQuoteHandoffContext | undefined {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return undefined;
  if (!isRecord(handoff.safeContext)) return undefined;
  const automaticQuoteSessionId = safeUuid(
    handoff.safeContext.automaticQuoteSessionId,
  );
  if (!automaticQuoteSessionId) return undefined;

  const modelFileIds = safeUuidArray(handoff.safeContext.modelFileIds, 20);
  const itemSelections = Array.isArray(handoff.safeContext.itemSelections)
    ? handoff.safeContext.itemSelections
        .slice(0, 50)
        .map(sanitizeItemSelection)
        .filter((item): item is AssistedQuoteItemContext => Boolean(item))
    : [];

  return {
    automaticQuoteSessionId,
    expiresAt: new Date(expiresAtMs).toISOString(),
    itemSelections,
    modelFileIds,
    reasons: handoff.reasons
      .filter((reason): reason is string => typeof reason === "string")
      .map((reason) => reason.slice(0, 100))
      .slice(0, 20),
  };
}

export function saveAssistedQuoteHandoff(
  storage: StorageLike,
  context: AssistedQuoteHandoffContext,
): boolean {
  try {
    storage.removeItem(STORAGE_KEY);
    storage.setItem(STORAGE_KEY, JSON.stringify(context));
    return true;
  } catch {
    return false;
  }
}

export function loadAssistedQuoteHandoff(
  storage: StorageLike,
  now = Date.now(),
): AssistedQuoteHandoffContext | undefined {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error("invalid handoff");
    const context = sanitizeAssistedQuoteHandoff(
      {
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
        safeContext: parsed,
      },
      typeof parsed.expiresAt === "string" ? parsed.expiresAt : "",
      now,
    );
    if (!context) throw new Error("expired handoff");
    return context;
  } catch {
    clearAssistedQuoteHandoff(storage);
    return undefined;
  }
}

export function clearAssistedQuoteHandoff(storage: StorageLike): boolean {
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function sanitizeItemSelection(
  value: unknown,
): AssistedQuoteItemContext | null {
  if (!isRecord(value)) return null;
  const modelFileId = safeUuid(value.modelFileId);
  const ordinal = safeInteger(value.ordinal, 0, 999);
  const quantity = safeInteger(value.quantity, 1, 1_000);
  if (!modelFileId || ordinal === undefined || quantity === undefined)
    return null;
  return {
    bodyIds: Array.isArray(value.bodyIds)
      ? value.bodyIds
          .filter((bodyId): bodyId is string => typeof bodyId === "string")
          .map((bodyId) => bodyId.slice(0, 200))
          .slice(0, 100)
      : [],
    fitSensitive: value.fitSensitive === true,
    material:
      typeof value.material === "string"
        ? value.material.slice(0, 100)
        : "UNSPECIFIED",
    modelFileId,
    ordinal,
    quantity,
  };
}

function safeUuidArray(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(safeUuid)
    .filter((id): id is string => Boolean(id))
    .slice(0, maximum);
}

function safeUuid(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
