import { DomainError } from "./errors.js";

declare const revisionReferenceBrand: unique symbol;

/**
 * Globally unique identifier of an immutable revision snapshot. The generic
 * kind prevents accidentally passing one revision family to another in typed
 * command code while retaining a simple string at persistence boundaries.
 */
export class RevisionRef<Kind extends string = string> {
  readonly id: string;
  readonly kind: Kind;
  declare readonly [revisionReferenceBrand]: Kind;

  private constructor(kind: Kind, id: string) {
    this.kind = kind;
    this.id = id;
    Object.freeze(this);
  }

  static create<Kind extends string>(
    kind: Kind,
    id: string,
  ): RevisionRef<Kind> {
    if (kind.trim().length === 0 || id.trim().length === 0) {
      throw new DomainError(
        "INVALID_REVISION_REFERENCE",
        "revision kind and id must not be blank",
      );
    }
    return new RevisionRef(kind, id);
  }

  equals(other: RevisionRef<Kind>): boolean {
    return this.kind === other.kind && this.id === other.id;
  }

  toString(): string {
    return `${this.kind}:${this.id}`;
  }
}
