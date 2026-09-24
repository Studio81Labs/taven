import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  canonicalJson,
  type CanonicalJson,
} from "../../src/modules/resources/resource-identity";

type SqlClient = Pick<PoolClient, "query">;

const operatorId = "f0000000-0000-4000-8000-000000000001";

export const e2eLegalRevisionCodes = {
  terms: "terms-v1",
  claims: "claim-policy-v1",
  privacy: "privacy-v1",
  prohibitedContent: "prohibited-v1",
  retention: "retention-v1",
  photoConsent: "photos-v1",
} as const;

/** Publishes the migration-owned legal drafts only for integration test flows. */
export async function publishE2eLegalFixtures(
  client: SqlClient,
): Promise<void> {
  await client.query(
    `INSERT INTO operator_identities (id, email, role)
     VALUES ($1, 'e2e-legal-fixture@example.test', 'ADMIN')
     ON CONFLICT (id) DO NOTHING`,
    [operatorId],
  );
  await client.query(
    `UPDATE legal_document_revisions revision
     SET status = 'APPROVED',
         revision_code = CASE document.key
           WHEN 'terms' THEN $1
           WHEN 'claims' THEN $2
           WHEN 'privacy' THEN $3
           WHEN 'prohibitedContent' THEN $4
           WHEN 'retention' THEN $5
           WHEN 'photoConsent' THEN $6
         END,
         effective_at = clock_timestamp() - interval '1 minute',
         approval_evidence = 'E2E fixture publication',
         approved_by = $7,
         approved_at = clock_timestamp()
     FROM legal_documents document
     WHERE document.id = revision.document_id
       AND revision.status = 'DRAFT'
       AND revision.sequence = 1
       AND document.key IN (
         'terms', 'claims', 'privacy', 'prohibitedContent', 'retention', 'photoConsent'
       )`,
    [
      e2eLegalRevisionCodes.terms,
      e2eLegalRevisionCodes.claims,
      e2eLegalRevisionCodes.privacy,
      e2eLegalRevisionCodes.prohibitedContent,
      e2eLegalRevisionCodes.retention,
      e2eLegalRevisionCodes.photoConsent,
      operatorId,
    ],
  );
  await client.query(
    `INSERT INTO legal_document_publications
       (id, document_id, revision_id, starts_at, published_by, reason)
     SELECT gen_random_uuid(), document.id, revision.id, clock_timestamp(), $1,
            'E2E fixture publication'
     FROM legal_documents document
     JOIN legal_document_revisions revision ON revision.document_id = document.id
     WHERE document.key IN (
       'terms', 'claims', 'privacy', 'prohibitedContent', 'retention', 'photoConsent'
     )
       AND revision.status = 'APPROVED'
       AND revision.sequence = 1
       AND revision.revision_code = CASE document.key
         WHEN 'terms' THEN $2
         WHEN 'claims' THEN $3
         WHEN 'privacy' THEN $4
         WHEN 'prohibitedContent' THEN $5
         WHEN 'retention' THEN $6
         WHEN 'photoConsent' THEN $7
       END
       AND NOT EXISTS (
         SELECT 1
         FROM legal_document_publications publication
         WHERE publication.revision_id = revision.id
           AND publication.cancelled_at IS NULL
       )`,
    [
      operatorId,
      e2eLegalRevisionCodes.terms,
      e2eLegalRevisionCodes.claims,
      e2eLegalRevisionCodes.privacy,
      e2eLegalRevisionCodes.prohibitedContent,
      e2eLegalRevisionCodes.retention,
      e2eLegalRevisionCodes.photoConsent,
    ],
  );
}

export async function publishE2eLegalFixturesForDatabase(
  databaseUrl: string,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await publishE2eLegalFixtures(pool);
  } finally {
    await pool.end();
  }
}

/** Reads only the isolated browser database so rejected checkout effects stay observable. */
export async function readE2eCheckoutEffectsForBrowser(
  databaseUrl: string,
  sessionId: string,
): Promise<{
  acceptedOrderPriceBindingId: string | null;
  paymentCount: number;
  acceptanceCount: number;
  decisionCount: number;
  idempotencyCount: number;
}> {
  assertIsolatedBrowserDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      accepted_order_price_binding_id: string | null;
      payment_count: number;
      acceptance_count: number;
      decision_count: number;
      idempotency_count: number;
    }>(
      `SELECT target.accepted_order_price_binding_id,
              (SELECT count(*)::int FROM payments WHERE order_id = target.id) AS payment_count,
              (SELECT count(*)::int FROM legal_acceptances WHERE order_id = target.id) AS acceptance_count,
              (SELECT count(*)::int FROM legal_acceptance_decisions WHERE order_id = target.id) AS decision_count,
              (SELECT count(*)::int FROM idempotency_records
               WHERE namespace = 'checkout-payment:' || origin.quote_session_id::text) AS idempotency_count
       FROM automatic_order_origins origin
       JOIN orders target ON target.id = origin.order_id
       WHERE origin.quote_session_id = $1`,
      [sessionId],
    );
    if (result.rows.length !== 1) {
      throw new Error("Isolated browser checkout order is unavailable");
    }
    const row = result.rows[0]!;
    return {
      acceptedOrderPriceBindingId: row.accepted_order_price_binding_id,
      paymentCount: row.payment_count,
      acceptanceCount: row.acceptance_count,
      decisionCount: row.decision_count,
      idempotencyCount: row.idempotency_count,
    };
  } finally {
    await pool.end();
  }
}

/** Sanitized first-party funnel evidence from the isolated browser database. */
export async function readE2eFunnelEvidenceForBrowser(
  databaseUrl: string,
  sessionId: string,
  sessionToken: string,
  customerEmail: string,
): Promise<{
  quoteViews: number;
  checkoutStarts: number;
  capturedPayments: number;
  confirmedOrders: number;
  capturedPaymentRows: number;
  unexpectedSources: number;
  sensitiveEventRows: number;
}> {
  assertIsolatedBrowserDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      quote_views: number;
      checkout_starts: number;
      captured_payments: number;
      confirmed_orders: number;
      captured_payment_rows: number;
      unexpected_sources: number;
      sensitive_event_rows: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM business_events event
          WHERE event.quote_session_id = origin.quote_session_id
            AND event.event_type = 'quote.viewed') AS quote_views,
         (SELECT count(*)::int FROM business_events event
          WHERE event.quote_session_id = origin.quote_session_id
            AND event.event_type = 'checkout.started') AS checkout_starts,
         (SELECT count(*)::int FROM business_events event
          WHERE event.order_id = origin.order_id
            AND event.event_type = 'payment.captured') AS captured_payments,
         (SELECT count(*)::int FROM business_events event
          WHERE event.order_id = origin.order_id
            AND event.event_type = 'order.confirmed') AS confirmed_orders,
         (SELECT count(*)::int FROM payments payment
          WHERE payment.order_id = origin.order_id
            AND payment.status = 'CAPTURED') AS captured_payment_rows,
         (SELECT count(*)::int FROM business_events event
          WHERE (event.quote_session_id = origin.quote_session_id
                 OR event.order_id = origin.order_id)
            AND ((event.event_type IN ('quote.viewed', 'checkout.started')
                  AND event.source <> 'CLIENT')
              OR (event.event_type IN ('payment.captured', 'order.confirmed')
                  AND event.source <> 'SERVER'))) AS unexpected_sources,
         (SELECT count(*)::int FROM business_events event
          WHERE (event.quote_session_id = origin.quote_session_id
                 OR event.order_id = origin.order_id)
            AND (strpos(event.payload::text, $2) > 0
              OR strpos(event.payload::text, $3) > 0)) AS sensitive_event_rows
       FROM automatic_order_origins origin
       WHERE origin.quote_session_id = $1`,
      [sessionId, sessionToken, customerEmail],
    );
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) {
      throw new Error("Isolated browser funnel order is unavailable");
    }
    return {
      quoteViews: row.quote_views,
      checkoutStarts: row.checkout_starts,
      capturedPayments: row.captured_payments,
      confirmedOrders: row.confirmed_orders,
      capturedPaymentRows: row.captured_payment_rows,
      unexpectedSources: row.unexpected_sources,
      sensitiveEventRows: row.sensitive_event_rows,
    };
  } finally {
    await pool.end();
  }
}

/** Exact immutable acceptance versions persisted by the isolated checkout. */
export async function readE2eAcceptedLegalVersionsForBrowser(
  databaseUrl: string,
  sessionId: string,
): Promise<Array<{ purpose: string; revision: string; contentHash: string }>> {
  assertIsolatedBrowserDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      purpose: string;
      revision: string;
      content_hash: string;
    }>(
      `SELECT acceptance.purpose, revision.revision_code AS revision,
              revision.content_hash
       FROM automatic_order_origins origin
       JOIN legal_acceptances acceptance ON acceptance.order_id = origin.order_id
       JOIN legal_document_revisions revision ON revision.id = acceptance.revision_id
       WHERE origin.quote_session_id = $1
       ORDER BY acceptance.purpose`,
      [sessionId],
    );
    return result.rows.map((row) => ({
      purpose: row.purpose,
      revision: row.revision,
      contentHash: row.content_hash,
    }));
  } finally {
    await pool.end();
  }
}

/** Reads the accepted binding's actual parcel allocations, not UI-derived counts. */
export async function readE2eParcelAllocationsForBrowser(
  databaseUrl: string,
  sessionId: string,
): Promise<{
  acceptedBindingId: string;
  destinationCount: number;
  parcels: Array<{
    ordinal: number;
    category: string;
    slotCount: number;
    supportedCategoryIds: string[];
  }>;
  itemBoundsMicrometers: Array<{
    ordinal: number;
    bodyIds: string[];
    x: string;
    y: string;
    z: string;
  }>;
}> {
  assertIsolatedBrowserDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await pool.query<{
      accepted_binding_id: string;
      ordinal: number;
      category: string;
      slot_count: number;
      destination_id: string;
      supported_category_ids: string[];
    }>(
      `SELECT target.accepted_order_price_binding_id AS accepted_binding_id,
              plan.ordinal,
              plan.category,
              plan.delivery_destination_id AS destination_id,
              destination.capability_snapshot->'supportedCategoryIds' AS supported_category_ids,
              count(allocation.fulfilment_slot_id)::int AS slot_count
       FROM automatic_order_origins origin
       JOIN orders target ON target.id = origin.order_id
       JOIN shipment_plans plan
         ON plan.order_price_binding_id = target.accepted_order_price_binding_id
       JOIN delivery_destinations destination
         ON destination.id = plan.delivery_destination_id
       LEFT JOIN shipment_plan_fulfilment_slots allocation
         ON allocation.shipment_plan_id = plan.id
       WHERE origin.quote_session_id = $1
       GROUP BY target.accepted_order_price_binding_id, plan.id, destination.id
       ORDER BY plan.ordinal`,
      [sessionId],
    );
    if (result.rows.length === 0) {
      throw new Error("Isolated browser accepted parcel plan is unavailable");
    }
    const itemBounds = await pool.query<{
      ordinal: number;
      body_ids: string[];
      x: string;
      y: string;
      z: string;
    }>(
      `SELECT item.ordinal, item.body_ids,
              geometry.bounds_x_micrometers::text AS x,
              geometry.bounds_y_micrometers::text AS y,
              geometry.bounds_z_micrometers::text AS z
       FROM automatic_order_origins origin
       JOIN automatic_quote_item_drafts item ON item.order_id = origin.order_id
       JOIN model_geometries geometry ON geometry.id = item.target_model_geometry_id
       WHERE origin.quote_session_id = $1
       ORDER BY item.ordinal`,
      [sessionId],
    );
    return {
      acceptedBindingId: result.rows[0]!.accepted_binding_id,
      destinationCount: new Set(result.rows.map((row) => row.destination_id))
        .size,
      parcels: result.rows.map((row) => ({
        ordinal: row.ordinal,
        category: row.category,
        slotCount: row.slot_count,
        supportedCategoryIds: row.supported_category_ids,
      })),
      itemBoundsMicrometers: itemBounds.rows.map((row) => ({
        ordinal: row.ordinal,
        bodyIds: row.body_ids,
        x: row.x,
        y: row.y,
        z: row.z,
      })),
    };
  } finally {
    await pool.end();
  }
}

/** Starts each serial browser scenario with a fresh anonymous admission budget. */
export async function resetE2eAnonymousAdmissionLimitsForBrowser(
  databaseUrl: string,
): Promise<void> {
  assertIsolatedBrowserDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DELETE FROM anonymous_upload_limits");
    await pool.query("DELETE FROM anonymous_quote_limits");
  } finally {
    await pool.end();
  }
}

function assertIsolatedBrowserDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/taven_web_browser") {
    throw new Error(
      "Legal browser fixture requires the isolated local database",
    );
  }
}

/** Temporary archive for the isolated browser database; never use against staging. */
export async function archiveE2eCheckoutDocumentsForBrowser(
  databaseUrl: string,
): Promise<() => Promise<void>> {
  assertIsolatedBrowserDatabase(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl });
  const archived: {
    documentId: string;
    generation: number;
    publicationId: string;
  }[] = [];
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const documents = await client.query<{
        id: string;
        key: string;
        generation: number;
      }>(
        `SELECT id, key, generation FROM legal_documents
         WHERE key IN ('terms', 'claims', 'photoConsent')
         ORDER BY id FOR UPDATE`,
      );
      if (documents.rows.length !== 3)
        throw new Error("Checkout legal fixtures missing");
      for (const document of documents.rows) {
        const publication = await client.query<{ id: string }>(
          `SELECT id FROM legal_document_publications
           WHERE document_id = $1 AND cancelled_at IS NULL AND ends_at IS NULL
           ORDER BY starts_at DESC LIMIT 1 FOR UPDATE`,
          [document.id],
        );
        if (publication.rows.length !== 1)
          throw new Error(`Active ${document.key} publication fixture missing`);
        const publicationId = publication.rows[0]!.id;
        await client.query(
          "UPDATE legal_document_publications SET ends_at = clock_timestamp() WHERE id = $1",
          [publicationId],
        );
        await client.query(
          "UPDATE legal_documents SET generation = generation + 1 WHERE id = $1",
          [document.id],
        );
        archived.push({
          documentId: document.id,
          generation: document.generation,
          publicationId,
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    await pool.end();
    throw error;
  }

  return async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = 'replica'");
      for (const entry of archived) {
        await client.query(
          "UPDATE legal_document_publications SET ends_at = NULL WHERE id = $1",
          [entry.publicationId],
        );
        await client.query(
          "UPDATE legal_documents SET generation = $2 WHERE id = $1",
          [entry.documentId, entry.generation],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  };
}

/** Forward-only replacement in the disposable browser database; run after other scenarios. */
export async function replaceE2eCheckoutDocumentsForBrowser(
  databaseUrl: string,
  startDelayMilliseconds = 0,
): Promise<
  Record<
    "terms" | "claims" | "photoConsent",
    {
      previousRevision: string;
      previousContentHash: string;
      previousTitle: string;
      revision: string;
      contentHash: string;
      title: string;
      startsAt: string | null;
    }
  >
> {
  assertIsolatedBrowserDatabase(databaseUrl);
  if (
    !Number.isInteger(startDelayMilliseconds) ||
    startDelayMilliseconds < 0 ||
    startDelayMilliseconds > 60_000
  ) {
    throw new Error("Invalid isolated legal replacement schedule");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;
  try {
    // Playwright retries reuse this disposable database. The prior attempt may
    // have committed a future publication that cannot be replaced yet.
    let waitedMilliseconds = 0;
    for (;;) {
      const pending = await pool.query<{ remaining_ms: number }>(
        `SELECT greatest(0, coalesce(ceil(extract(epoch FROM
           max(publication.starts_at) - clock_timestamp()) * 1000), 0))::int
           AS remaining_ms
         FROM legal_document_publications publication
         JOIN legal_documents document ON document.id = publication.document_id
         WHERE document.key IN ('terms', 'claims', 'photoConsent')
           AND publication.cancelled_at IS NULL
           AND publication.starts_at > clock_timestamp()`,
      );
      const remainingMilliseconds = pending.rows[0]!.remaining_ms;
      if (remainingMilliseconds === 0) break;
      if (waitedMilliseconds >= 60_000) {
        throw new Error("Pending legal fixture publication did not activate");
      }
      const waitMilliseconds = Math.min(1_000, remainingMilliseconds + 50);
      await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
      waitedMilliseconds += waitMilliseconds;
    }
    client = await pool.connect();
  } catch (error) {
    await pool.end();
    throw error;
  }
  try {
    await client.query("BEGIN");
    const documents = await client.query<{
      id: string;
      key: "terms" | "claims" | "photoConsent";
    }>(
      `SELECT id, key FROM legal_documents
       WHERE key IN ('terms', 'claims', 'photoConsent')
       ORDER BY key FOR UPDATE`,
    );
    if (documents.rows.length !== 3) {
      throw new Error("Checkout legal replacement fixtures are missing");
    }
    const scheduledStart = startDelayMilliseconds
      ? (
          await client.query<{ starts_at: Date }>(
            `SELECT clock_timestamp() + ($1::integer * interval '1 millisecond') AS starts_at`,
            [startDelayMilliseconds],
          )
        ).rows[0]!.starts_at
      : null;
    const replacements = {} as Record<
      "terms" | "claims" | "photoConsent",
      {
        previousRevision: string;
        previousContentHash: string;
        previousTitle: string;
        revision: string;
        contentHash: string;
        title: string;
        startsAt: string | null;
      }
    >;
    for (const document of documents.rows) {
      const current = await client.query<{
        revision_code: string;
        content_hash: string;
        title: string;
        summary: string;
        sections: CanonicalJson[];
      }>(
        `SELECT revision.revision_code, revision.content_hash,
                revision.title, revision.summary, revision.sections
         FROM legal_document_publications publication
         JOIN legal_document_revisions revision
           ON revision.id = publication.revision_id
         WHERE publication.document_id = $1
           AND publication.cancelled_at IS NULL
           AND publication.ends_at IS NULL
         ORDER BY publication.starts_at DESC LIMIT 1
         FOR UPDATE OF publication`,
        [document.id],
      );
      const previous = current.rows[0];
      if (!previous?.revision_code) {
        throw new Error(`Current ${document.key} revision is missing`);
      }
      const sequence = await client.query<{ next_sequence: number }>(
        `SELECT coalesce(max(sequence), 0) + 1 AS next_sequence
         FROM legal_document_revisions WHERE document_id = $1`,
        [document.id],
      );
      const title = `${previous.title} · browser replacement`;
      const summary = `${previous.summary} Browser replacement fixture.`;
      const content = {
        contentVersion: 1,
        title,
        summary,
        sections: previous.sections,
      };
      const contentHash = createHash("sha256")
        .update(canonicalJson(content))
        .digest("hex");
      const revisionId = randomUUID();
      const revision = `${document.key}-browser-${randomUUID()}`;
      await client.query(
        `INSERT INTO legal_document_revisions
           (id, document_id, sequence, edit_version, status, content_version,
            title, summary, sections, content_hash, revision_code, effective_at,
            approval_evidence, approved_by, approved_at)
         VALUES ($1, $2, $3, 1, 'APPROVED', 1,
                 $4, $5, $6::jsonb, $7, $8,
                 coalesce($10::timestamptz, clock_timestamp() - interval '1 minute'),
                 'Isolated browser replacement fixture', $9, clock_timestamp())`,
        [
          revisionId,
          document.id,
          sequence.rows[0]!.next_sequence,
          title,
          summary,
          JSON.stringify(previous.sections),
          contentHash,
          revision,
          operatorId,
          scheduledStart,
        ],
      );
      // The database publication trigger closes the predecessor at the new start.
      await client.query(
        `INSERT INTO legal_document_publications
           (id, document_id, revision_id, starts_at, published_by, reason)
         VALUES ($1, $2, $3, coalesce($5::timestamptz, clock_timestamp()), $4,
                 'Isolated browser replacement fixture')`,
        [randomUUID(), document.id, revisionId, operatorId, scheduledStart],
      );
      await client.query(
        `UPDATE legal_documents SET generation = generation + 1 WHERE id = $1`,
        [document.id],
      );
      replacements[document.key] = {
        previousRevision: previous.revision_code,
        previousContentHash: previous.content_hash,
        previousTitle: previous.title,
        revision,
        contentHash,
        title,
        startsAt: scheduledStart?.toISOString() ?? null,
      };
    }
    await client.query("COMMIT");
    return replacements;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
