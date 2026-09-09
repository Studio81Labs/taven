import { createHash } from "node:crypto";
import { ResourceValidationError } from "./resource-errors";

type JsonPrimitive = boolean | number | string | null;
export type CanonicalJson =
  | JsonPrimitive
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

/**
 * Historical serialization for persisted resource identities and snapshots.
 * Its bytes (including localeCompare's ordering) are an existing compatibility
 * contract and must not be changed without an explicit data migration.
 */
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

/**
 * Total-order serialization for catalog command idempotency fingerprints only.
 * Persisted revisions and slicer snapshots must continue to use canonicalJson.
 */
export function canonicalCatalogCommandJson(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ResourceValidationError(
        "catalog command numbers must be finite",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => canonicalCatalogCommandJson(item))
      .join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalCatalogCommandJson(item)}`,
    )
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
