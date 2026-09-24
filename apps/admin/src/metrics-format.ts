import type { components } from "@taven/openapi-client";
import { formatCzkMinor } from "./format";

type S = components["schemas"];

export function ratio(value: S["MetricRatioDto"]): string {
  return value.value === null
    ? `Není dostupné (${value.numerator}/${value.denominator})`
    : `${(value.value * 100).toLocaleString("cs-CZ", { maximumFractionDigits: 1 })} % (${value.numerator}/${value.denominator})`;
}

export function money(value: S["MetricMoneyDto"] | null): string {
  return value ? formatCzkMinor(value.amountMinor) : "Neznámé";
}

export function moneyRatio(value: S["MetricMoneyRatioDto"]): string {
  return value.value
    ? `${money(value.value)} / ${value.denominator}`
    : `Neznámé / ${value.denominator}`;
}

export function pragueMidnight(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new Error("Zadejte platné datum.");
  const midnightUtc = new Date(`${date}T00:00:00Z`);
  if (
    Number.isNaN(midnightUtc.getTime()) ||
    midnightUtc.toISOString().slice(0, 10) !== date
  )
    throw new Error("Zadejte platné datum.");
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Prague",
    timeZoneName: "shortOffset",
  })
    .formatToParts(midnightUtc)
    .find((part) => part.type === "timeZoneName")?.value;
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name ?? "");
  if (!match) throw new Error("Pražské časové pásmo není dostupné.");
  const offset =
    (Number(match[2]) * 60 + Number(match[3] ?? 0)) *
    (match[1] === "+" ? 1 : -1);
  return new Date(midnightUtc.getTime() - offset * 60_000).toISOString();
}

export function currentPragueMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}`;
}
