const czechInteger = new Intl.NumberFormat("cs-CZ", {
  maximumFractionDigits: 0,
});
const pragueDateTime = new Intl.DateTimeFormat("cs-CZ", {
  timeZone: "Europe/Prague",
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatCzkMinor(value: string | null | undefined): string {
  if (value == null) return "Není k dispozici";
  if (!/^-?\d+$/.test(value)) return "Neplatná částka";
  const amount = BigInt(value);
  const absolute = amount < 0n ? -amount : amount;
  const crowns = czechInteger.format(absolute / 100n);
  const halers = String(absolute % 100n).padStart(2, "0");
  return `${amount < 0n ? "−" : ""}${crowns},${halers} Kč`;
}

export function formatGrams(value: string | null | undefined): string {
  if (value == null) return "Není k dispozici";
  if (!/^\d+$/.test(value)) return "Neplatná hmotnost";
  return `${czechInteger.format(BigInt(value))} g`;
}

export function formatPragueInstant(value: string | null | undefined): string {
  if (!value) return "Není k dispozici";
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(value)) return "Neplatný čas";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Neplatný čas"
    : pragueDateTime.format(date);
}
