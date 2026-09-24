import { CommandIntent } from "./command-intent";
import { requestFeedback } from "./request-feedback";
import { session } from "./session";

export class OperatorRequestError extends Error {
  constructor(
    readonly status: number,
    readonly refreshRequired: boolean,
    message: string,
  ) {
    super(message);
  }
}

export function requireData<T>(result: {
  data?: T;
  error?: unknown;
  response: Response;
}): T {
  if (result.data !== undefined) return result.data;
  const feedback = requestFeedback(
    result.response.status,
    result.response.headers.get("Retry-After"),
  );
  const details =
    result.error && typeof result.error === "object"
      ? (result.error as Record<string, unknown>)
      : null;
  const conflictIds = Array.isArray(details?.conflictReservationIds)
    ? details.conflictReservationIds
        .filter(
          (id): id is string =>
            typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id),
        )
        .slice(0, 100)
    : [];
  const message = conflictIds.length
    ? `${feedback.message} Konfliktní rezervace: ${conflictIds.join(", ")}${details?.moreConflicts === true ? " (další konflikty)" : ""}.`
    : feedback.message;
  throw new OperatorRequestError(
    result.response.status,
    feedback.refreshRequired,
    message,
  );
}

export function commandHeaders(key: string): {
  "Idempotency-Key": string;
  "x-csrf-token": string;
} {
  const token = session.value?.csrfToken;
  if (!token) throw new Error("Relace není připravena pro zápis.");
  return { "Idempotency-Key": key, "x-csrf-token": token };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Požadavek se nepodařilo dokončit. Ověřte aktuální stav.";
}

export class CommandJournal {
  private readonly intents = new Map<string, CommandIntent<unknown, unknown>>();

  async submit<Body, Result>(
    action: string,
    body: Body,
    send: (body: Readonly<Body>, key: string) => Promise<Result>,
  ): Promise<Result> {
    const fingerprint = JSON.stringify([action, body]);
    let intent = this.intents.get(fingerprint) as
      CommandIntent<Body, Result> | undefined;
    if (!intent) {
      intent = new CommandIntent<Body, Result>(body);
      this.intents.set(fingerprint, intent);
    }
    const result = await intent.submit(send);
    if (this.intents.get(fingerprint) === intent)
      this.intents.delete(fingerprint);
    return result;
  }
}

export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Zadejte JSON objekt.");
  }
  return parsed as Record<string, unknown>;
}

export function isoFromZonedInput(value: string): string {
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i.exec(
      value,
    );
  if (!parts)
    throw new Error("Uveďte časové pásmo, například +01:00 nebo +02:00.");
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()))
    throw new Error("Zadejte platné datum a čas včetně časového pásma.");
  if (parts[6]?.toUpperCase() === "Z") {
    const utcParts = [
      String(date.getUTCFullYear()).padStart(4, "0"),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
      String(date.getUTCHours()).padStart(2, "0"),
      String(date.getUTCMinutes()).padStart(2, "0"),
    ];
    if (parts.slice(1, 6).some((part, index) => part !== utcParts[index]))
      throw new Error("Zadejte platné datum a čas včetně časového pásma.");
  } else {
    const local = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const part = (type: string) =>
      local.find((item) => item.type === type)?.value;
    if (
      parts[1] !== part("year") ||
      parts[2] !== part("month") ||
      parts[3] !== part("day") ||
      parts[4] !== part("hour") ||
      parts[5] !== part("minute")
    ) {
      throw new Error("Čas a posun neodpovídají pražskému pásmu v zadaný den.");
    }
  }
  return date.toISOString();
}
