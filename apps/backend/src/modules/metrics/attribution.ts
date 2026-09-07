import { BadRequestException } from "@nestjs/common";
import type { AttributionDto } from "./attribution.dto";

const CHANNELS = new Set(["direct", "organic", "paid", "referral", "unknown"]);
const FIELDS = new Set(["channel", "source", "medium", "campaign"]);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRE_NORMALIZED_SLUG = /^\s*[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s*$/;
const MAX_INPUT_LENGTH = 256;

export type NormalizedAttribution = Readonly<{
  channel: "direct" | "organic" | "paid" | "referral" | "unknown";
  source?: string;
  medium?: string;
  campaign?: string;
}>;

export function normalizeAttribution(
  value: AttributionDto | Record<string, unknown> | undefined,
  field = "attribution",
): NormalizedAttribution | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new BadRequestException(`${field} is invalid`);
  for (const key of Object.keys(value)) {
    if (!FIELDS.has(key))
      throw new BadRequestException(`${field}.${key} is not allowed`);
  }
  const channel = value.channel;
  if (typeof channel !== "string" || !CHANNELS.has(channel))
    throw new BadRequestException(`${field}.channel is invalid`);
  const normalized: {
    channel: NormalizedAttribution["channel"];
    source?: string;
    medium?: string;
    campaign?: string;
  } = { channel: channel as NormalizedAttribution["channel"] };
  for (const key of ["source", "medium", "campaign"] as const) {
    const label = value[key];
    if (label === undefined) continue;
    if (typeof label !== "string")
      throw new BadRequestException(`${field}.${key} is invalid`);
    if (label.length > MAX_INPUT_LENGTH || !PRE_NORMALIZED_SLUG.test(label)) {
      throw new BadRequestException(`${field}.${key} is invalid`);
    }
    const result = label.trim().toLowerCase();
    if (result.length > 64 || !SLUG.test(result))
      throw new BadRequestException(`${field}.${key} is invalid`);
    normalized[key] = result;
  }
  return normalized;
}
