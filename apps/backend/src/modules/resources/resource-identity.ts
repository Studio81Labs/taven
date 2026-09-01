import { createHash } from "node:crypto";
import { ResourceValidationError } from "./resource-errors";

type JsonPrimitive = boolean | number | string | null;
export type CanonicalJson =
  | JsonPrimitive
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

export function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ResourceValidationError(
        "revision payload numbers must be finite",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

/** Stable identity for immutable resource-catalog revisions. */
export function resourceRevisionDigest(
  kind: string,
  payload: CanonicalJson,
): string {
  if (kind.trim().length === 0) {
    throw new ResourceValidationError("revision kind must not be blank");
  }
  return createHash("sha256")
    .update(canonicalJson({ kind, payload } as CanonicalJson))
    .digest("hex");
}
