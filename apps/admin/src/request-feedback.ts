export type RequestFeedback = Readonly<{
  message: string;
  retryAfterSeconds: number | null;
  refreshRequired: boolean;
}>;

export function requestFeedback(
  status: number,
  retryAfter: string | null = null,
): RequestFeedback {
  switch (status) {
    case 400:
      return {
        message: "Zkontrolujte zadané údaje.",
        retryAfterSeconds: null,
        refreshRequired: false,
      };
    case 401:
      return {
        message: "Relace vypršela. Přihlaste se znovu.",
        retryAfterSeconds: null,
        refreshRequired: false,
      };
    case 403:
      return {
        message: "K této akci nemáte oprávnění.",
        retryAfterSeconds: null,
        refreshRequired: true,
      };
    case 409:
      return {
        message:
          "Údaje se mezitím změnily. Načtěte aktuální stav a změnu zkontrolujte.",
        retryAfterSeconds: null,
        refreshRequired: true,
      };
    case 410:
      return {
        message: "Tento podklad již není dostupný.",
        retryAfterSeconds: null,
        refreshRequired: true,
      };
    case 429:
      return {
        message: "Příliš mnoho požadavků. Zkuste to později.",
        retryAfterSeconds: parseRetryAfter(retryAfter),
        refreshRequired: false,
      };
    case 503:
      return {
        message: "Služba není dostupná. Změna nebyla potvrzena.",
        retryAfterSeconds: null,
        refreshRequired: false,
      };
    default:
      return {
        message: "Požadavek se nepodařilo dokončit. Ověřte aktuální stav.",
        retryAfterSeconds: null,
        refreshRequired: true,
      };
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  if (/^\d{1,6}$/.test(value)) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? null
    : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}
