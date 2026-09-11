import { HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const ANONYMOUS_QUOTE_WINDOW_MILLISECONDS = 15 * 60 * 1_000;
const ANONYMOUS_QUOTE_CLIENT_MAX_ISSUED = 5;
const ANONYMOUS_QUOTE_GLOBAL_MAX_ISSUED = 100;
const ANONYMOUS_QUOTE_GLOBAL_SUBJECT = "global";
const ANONYMOUS_QUOTE_LIMIT_CLEANUP_BATCH = 100;

type Transaction = Prisma.TransactionClient;
type AnonymousQuoteLimitRow = {
  subject_hash: string;
  window_started_at: Date;
  window_expires_at: Date;
  issued_count: number;
};

export async function reserveAnonymousQuote(
  transaction: Transaction,
  subjectHash: string,
  namespace?: string,
): Promise<void> {
  const subjects = anonymousQuoteLimitSubjects(subjectHash, namespace);
  const observedAt = await databaseNow(transaction);
  const windowExpiresAt = new Date(
    observedAt.getTime() + ANONYMOUS_QUOTE_WINDOW_MILLISECONDS,
  );
  const global = await lockAnonymousQuoteLimit(
    transaction,
    subjects.global,
    observedAt,
    windowExpiresAt,
  );
  const subject = await lockAnonymousQuoteLimit(
    transaction,
    subjects.client,
    observedAt,
    windowExpiresAt,
  );
  const currentGlobal = await resetExpiredQuoteLimit(
    transaction,
    global,
    observedAt,
    windowExpiresAt,
  );
  const currentSubject = await resetExpiredQuoteLimit(
    transaction,
    subject,
    observedAt,
    windowExpiresAt,
  );
  if (
    currentGlobal.issued_count >= ANONYMOUS_QUOTE_GLOBAL_MAX_ISSUED ||
    currentSubject.issued_count >= ANONYMOUS_QUOTE_CLIENT_MAX_ISSUED
  ) {
    throw new HttpException(
      "Anonymous quote-submission limit is exhausted",
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  await transaction.anonymousQuoteLimit.update({
    where: { subjectHash: subjects.global },
    data: { issuedCount: { increment: 1 } },
  });
  await transaction.anonymousQuoteLimit.update({
    where: { subjectHash: subjects.client },
    data: { issuedCount: { increment: 1 } },
  });
  await transaction.$executeRaw`
    WITH expired AS (
      SELECT subject_hash
      FROM anonymous_quote_limits
      WHERE subject_hash <> ${ANONYMOUS_QUOTE_GLOBAL_SUBJECT}
        AND subject_hash NOT LIKE '%:global'
        AND window_expires_at <= ${observedAt}
      ORDER BY window_expires_at, subject_hash
      FOR UPDATE SKIP LOCKED
      LIMIT ${ANONYMOUS_QUOTE_LIMIT_CLEANUP_BATCH}
    )
    DELETE FROM anonymous_quote_limits limits
    USING expired
    WHERE limits.subject_hash = expired.subject_hash
  `;
}

function anonymousQuoteLimitSubjects(
  subjectHash: string,
  namespace: string | undefined,
): Readonly<{ global: string; client: string }> {
  if (!namespace) {
    return { global: ANONYMOUS_QUOTE_GLOBAL_SUBJECT, client: subjectHash };
  }
  if (!/^[a-z0-9-]{1,64}$/.test(namespace)) {
    throw new Error("Anonymous quote limit namespace is invalid");
  }
  return {
    global: `${namespace}:global`,
    client: `${namespace}:client:${subjectHash}`,
  };
}

async function lockAnonymousQuoteLimit(
  transaction: Transaction,
  subjectHash: string,
  windowStartedAt: Date,
  windowExpiresAt: Date,
): Promise<AnonymousQuoteLimitRow> {
  await transaction.$executeRaw`
    INSERT INTO anonymous_quote_limits (
      subject_hash, window_started_at, window_expires_at,
      issued_count, updated_at
    ) VALUES (
      ${subjectHash}, ${windowStartedAt}, ${windowExpiresAt}, 0,
      clock_timestamp()
    )
    ON CONFLICT (subject_hash) DO NOTHING
  `;
  const rows = await transaction.$queryRaw<AnonymousQuoteLimitRow[]>`
    SELECT subject_hash, window_started_at, window_expires_at, issued_count
    FROM anonymous_quote_limits
    WHERE subject_hash = ${subjectHash}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error("anonymous quote limit row is unavailable");
  return row;
}

async function resetExpiredQuoteLimit(
  transaction: Transaction,
  row: AnonymousQuoteLimitRow,
  observedAt: Date,
  windowExpiresAt: Date,
): Promise<AnonymousQuoteLimitRow> {
  if (row.window_expires_at.getTime() > observedAt.getTime()) return row;
  await transaction.anonymousQuoteLimit.update({
    where: { subjectHash: row.subject_hash },
    data: {
      windowStartedAt: observedAt,
      windowExpiresAt,
      issuedCount: 0,
    },
  });
  return {
    ...row,
    window_started_at: observedAt,
    window_expires_at: windowExpiresAt,
    issued_count: 0,
  };
}

async function databaseNow(transaction: Transaction): Promise<Date> {
  const rows = await transaction.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT clock_timestamp() AS observed_at
  `;
  if (!rows[0]) throw new Error("Database clock is unavailable");
  return rows[0].observed_at;
}
