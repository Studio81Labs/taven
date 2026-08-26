import { DomainError } from "../primitives/errors.js";

const KEY_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

export interface KeyComponent {
  readonly name: string;
  readonly value: string | number | bigint;
}

export class InvalidKeyComponentError extends DomainError {
  override readonly name = "InvalidKeyComponentError";

  constructor(message: string) {
    super("INVALID_KEY_COMPONENT", message);
  }
}

function assertKeyName(value: string, label: string): void {
  if (!KEY_NAME_PATTERN.test(value)) {
    throw new InvalidKeyComponentError(
      `${label} must match ${KEY_NAME_PATTERN.source}`,
    );
  }
}

function normalizeValue(value: KeyComponent["value"]): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new InvalidKeyComponentError(
        "numeric key components must be safe integers",
      );
    }
    return value.toString(10);
  }

  return typeof value === "bigint" ? value.toString(10) : value;
}

/**
 * Produces a readable, versioned key without relying on delimiters inside
 * caller-controlled values. Field order is significant and must be declared by
 * each domain-specific builder.
 */
export function buildCanonicalKey(
  namespace: string,
  version: number,
  components: readonly KeyComponent[],
): string {
  assertKeyName(namespace, "key namespace");
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new InvalidKeyComponentError(
      "key version must be a positive safe integer",
    );
  }
  if (components.length === 0) {
    throw new InvalidKeyComponentError("a key requires at least one component");
  }

  const componentNames = new Set<string>();
  const encoded = components.map(({ name, value }) => {
    assertKeyName(name, "component name");
    if (componentNames.has(name)) {
      throw new InvalidKeyComponentError(
        `key component '${name}' must appear exactly once`,
      );
    }
    componentNames.add(name);
    const normalized = normalizeValue(value);
    if (normalized.length === 0) {
      throw new InvalidKeyComponentError(
        `key component '${name}' must not be empty`,
      );
    }
    return `${name}:${normalized.length}:${normalized}`;
  });

  return `taven:${namespace}:v${version}|${encoded.join("|")}`;
}
