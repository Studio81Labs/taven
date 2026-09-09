# ADR 0015: Use deterministic initial resource serialization

- **Status:** accepted
- **Date:** 2026-09-09
- **Related:** Epic #7 revision 5 §4.4.3, escalations #102 and #103, issue #104

## Context

ADR 0013 separated catalog-command fingerprint serialization from persisted
resource revision and snapshot serialization to preserve a presumed historical
locale-based contract. The owner subsequently confirmed that Taven is fresh,
undeployed, and has no historical resource revisions, slicer snapshots, jobs,
or object keys to preserve. Epic #7 revision 5 and escalation #103 confirm the
later #102 amendment as the authority.

The resource domain needs one deterministic initial serialization rule across
revision identities, immutable snapshot bytes, activation receipts, bootstrap
and repair, queue pointers, publication checks, and catalog command
fingerprints. Locale-sensitive comparison is not deterministic enough for that
contract, particularly for distinct Unicode keys that compare equally in some
locales.

## Decision

1. Resource-domain `canonicalJson` recursively orders object keys using the
   UTF-16 code-unit comparator `a === b ? 0 : a < b ? -1 : 1`.
2. The same serializer is used for resource revision digests, slicer snapshot
   bytes and SHA-256 object keys, activation verification receipts,
   bootstrap/repair and producer/publisher pointers, and catalog command
   idempotency fingerprints. It preserves array order, existing JSON primitive
   encoding, finite-number validation, UTF-8 hashing, and the existing
   `{kind,payload}` revision-digest envelope.
3. No locale-based resource helper, dual-hash fallback, migration, new version
   field, historical audit, cleanup, writer drain, or deployment procedure is
   introduced. Orders, Quotes, Payments, and other unrelated serializers remain
   outside this decision.
4. Literal UTF-8 bytes and independently fixed SHA-256 goldens cover nested
   keys, numeric-looking keys, composed/decomposed Unicode, astral/BMP text,
   arrays, escapes, and numbers. Worker raw-byte/hash verification and the v2
   slicer message shape remain unchanged.

## Consequences

Every initial resource writer and reader agrees on one stable byte and object
identity. Reordered semantic object members produce the same digest and command
fingerprint; distinct Unicode keys remain distinct and are never normalized.
Immutable snapshot mismatch rejection, committed-revision ownership, activation
verification, replay, and missing-object repair continue unchanged.

ADR 0013 is retained as superseded history. Any future resource serialization
change after durable data exists requires an explicit compatibility decision.
