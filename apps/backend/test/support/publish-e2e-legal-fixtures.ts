import { Pool, type PoolClient } from "pg";

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
       AND NOT EXISTS (
         SELECT 1
         FROM legal_document_publications publication
         WHERE publication.revision_id = revision.id
           AND publication.cancelled_at IS NULL
       )`,
    [operatorId],
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
