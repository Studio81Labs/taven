# ADR 0011: Use single-use capabilities for automatic-quote handoff

- **Status:** accepted
- **Date:** 2026-09-07
- **Decision authority:** architecture resolution of epic #7 escalation 002
- **Implementation:** issue #24, P4, PR #89; no production implementation in this decision

## Context

The automatic-quote browser flow can route an anonymous session to the
assisted `QuoteRequest` form. Its current browser context contains an
automatic-quote session ID, model-file IDs, item selections and handoff
reasons. Browser sanitization bounds those values but does not prove that the
caller may disclose or link them. The normalized attribution contract also
rejects arbitrary handoff objects.

The automatic quote already has a bearer capability, but that capability is
reusable and authorizes the source session's normal read and mutation APIs.
Passing it through the assisted-request command would widen the command's
trust boundary and leave replay and expiry semantics coupled to the source
session.

## Decision

Add a dedicated server-minted `ASSISTED_QUOTE_REQUEST` handoff capability.

1. The browser calls a new automatic-session handoff command while presenting
   the existing automatic-session bearer capability. The source service
   validates the session, bearer, active expiry, handoff-eligible state and
   current server-owned draft. It creates an opaque random handoff token whose
   hash is stored; the token is never logged or stored in plaintext.
2. The handoff has a 15-minute maximum lifetime, clamped to the automatic
   session expiry. It contains a server-generated, bounded context snapshot:
   source session ID, current model-file IDs, item selections and canonical
   handoff reasons. The client cannot choose or alter these values. The source
   session's normal bearer is not included in the assisted request.
3. The assisted `QuoteRequest` command accepts the opaque token in a dedicated
   top-level field such as `automaticQuoteHandoffToken`. It remains separate
   from normalized attribution, which continues to contain only
   `channel`, `source`, `medium` and `campaign`.
4. Inside the existing quote-request idempotency transaction, the backend
   locks the handoff row, verifies scope and expiry, and atomically consumes it
   while creating the request. It persists a typed server-derived handoff
   record linked to the request and source session. It never trusts client
   session IDs, model IDs, selections or reasons. The normalized attribution
   stored on the request is unchanged.
5. A successful create replay returns the saved response without re-consuming
   the token. Reusing the token with another idempotency key is rejected as a
   consumed capability; an expired or missing token is rejected without
   disclosing source existence. Any failed transaction rolls back consumption.
   Consumption is terminal and cannot be reset by the browser or source
   session.

The source handoff issuance command is idempotent. A retry with the same
source session, bearer capability and idempotency key returns the original
stored issuance response, even if that token has since been consumed; a
changed request fingerprint conflicts. Issuance does not consume the source
session bearer. Issuing a second handoff with a new key is allowed until source
expiry, but each token is independently single-use.

The persisted handoff snapshot is immutable and allowlisted. Operator reads
may display the source session and safe technical fields through a typed
projection; raw bearer tokens, contact data, arbitrary browser JSON and file
storage keys are never copied. The source session remains the authority for
validating the IDs at mint time, and the handoff snapshot remains the authority
for what the assisted request actually disclosed.

## Rejected alternatives

- **Reuse the existing automatic bearer directly.** It is broader than the
  assisted command needs, remains reusable, and makes the quote-request
  transaction depend on a long-lived source capability.
- **Accept a structured handoff object plus a session ID.** Sanitization and
  shape validation do not establish possession or source authorization; a
  client could submit another customer's identifiers.
- **Persist only the browser's sanitized values.** This preserves untrusted
  provenance and loses the server's source-of-truth check.
- **Stop transferring context and require manual re-entry.** This would remove
  a useful assisted flow despite a bounded capability design that preserves
  privacy and replay safety; it is a product fallback only if implementation
  cannot meet this contract.
- **Use a reusable signed/JWT handoff.** Signature validity alone does not
  provide single-use consumption or a durable replay fence; a database-backed
  opaque capability is required.

## Consequences and rollout

Add a forward migration for the handoff capability and immutable request
handoff record, with token-hash uniqueness, scope, expiry, consumed timestamp,
source-session/request relations and idempotency identity. Add the assisted
request field and handoff endpoint to OpenAPI and regenerate the client. Update
the web flow to request and store only the opaque handoff token while retaining
local context solely for display copy; the server response is authoritative.

No existing automatic session, quote request, attribution JSON or customer
record is backfilled. Existing browser contexts without a handoff token fall
back to the manual assisted form. Deploy the source endpoint, generated
contract, quote-request consumer and web consumer together before enabling the
automatic handoff path.

This decision does not change automatic pricing, accepted quotes, order
creation, public customer accounts, attribution dimensions or generic
analytics tracking.
