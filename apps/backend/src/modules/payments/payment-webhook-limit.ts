import { createHash } from "node:crypto";
import { HttpException, HttpStatus } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const PAYMENT_WEBHOOK_WINDOW_MILLISECONDS = 60 * 1_000;
const PAYMENT_WEBHOOK_GLOBAL_MAX_VERIFICATIONS = 300;
const PAYMENT_WEBHOOK_SOURCE_MAX_VERIFICATIONS = 120;
const PAYMENT_WEBHOOK_PAYMENT_MAX_VERIFICATIONS = 12;
const PAYMENT_WEBHOOK_LIMIT_CLEANUP_BATCH = 100;

type Transaction = Prisma.TransactionClient;
type PaymentWebhookLimitRow = {
  subject_hash: string;
  window_started_at: Date;
  window_expires_at: Date;
  issued_count: number;
};

export async function reservePaymentWebhookVerification(
  transaction: Transaction,
  input: Readonly<{
    provider: string;
    clientAddress: string;
    paymentId: string;
  }>,
): Promise<void> {
  const observedAt = await databaseNow(transaction);
  const windowExpiresAt = new Date(
    observedAt.getTime() + PAYMENT_WEBHOOK_WINDOW_MILLISECONDS,
  );
  const limits = [
    {
      subjectHash: webhookSubjectHash("global", input.provider),
      maximum: PAYMENT_WEBHOOK_GLOBAL_MAX_VERIFICATIONS,
    },
    {
      subjectHash: webhookSubjectHash(
        "source",
        input.provider,
        input.clientAddress,
      ),
      maximum: PAYMENT_WEBHOOK_SOURCE_MAX_VERIFICATIONS,
    },
    {
      subjectHash: webhookSubjectHash(
        "payment",
        input.provider,
        input.paymentId,
      ),
      maximum: PAYMENT_WEBHOOK_PAYMENT_MAX_VERIFICATIONS,
    },
  ].sort((left, right) => left.subjectHash.localeCompare(right.subjectHash));
  const current: Array<
    (typeof limits)[number] & { row: PaymentWebhookLimitRow }
  > = [];
  for (const limit of limits) {
    const locked = await lockPaymentWebhookLimit(
      transaction,
      limit.subjectHash,
      observedAt,
      windowExpiresAt,
    );
    current.push({
      ...limit,
      row: await resetExpiredPaymentWebhookLimit(
        transaction,
        locked,
        observedAt,
        windowExpiresAt,
      ),
    });
  }
  if (current.some(({ maximum, row }) => row.issued_count >= maximum)) {
    throw new HttpException(
      "Payment webhook verification limit is exhausted",
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  for (const { subjectHash } of limits) {
    await transaction.paymentWebhookLimit.update({
      where: { subjectHash },
      data: { issuedCount: { increment: 1 } },
    });
  }
  await transaction.$executeRaw`
    WITH expired AS (
      SELECT subject_hash
      FROM payment_webhook_limits
      WHERE window_expires_at <= ${observedAt}
      ORDER BY window_expires_at, subject_hash
      FOR UPDATE SKIP LOCKED
      LIMIT ${PAYMENT_WEBHOOK_LIMIT_CLEANUP_BATCH}
    )
    DELETE FROM payment_webhook_limits limits
    USING expired
    WHERE limits.subject_hash = expired.subject_hash
  `;
}

async function lockPaymentWebhookLimit(
  transaction: Transaction,
  subjectHash: string,
  windowStartedAt: Date,
  windowExpiresAt: Date,
): Promise<PaymentWebhookLimitRow> {
  await transaction.$executeRaw`
    INSERT INTO payment_webhook_limits (
      subject_hash, window_started_at, window_expires_at,
      issued_count, updated_at
    ) VALUES (
      ${subjectHash}, ${windowStartedAt}, ${windowExpiresAt}, 0,
      clock_timestamp()
    )
    ON CONFLICT (subject_hash) DO NOTHING
  `;
  const rows = await transaction.$queryRaw<PaymentWebhookLimitRow[]>`
    SELECT subject_hash, window_started_at, window_expires_at, issued_count
    FROM payment_webhook_limits
    WHERE subject_hash = ${subjectHash}
    FOR UPDATE
  `;
  const row = rows[0];
  if (!row) throw new Error("Payment webhook limit row is unavailable");
  return row;
}

async function resetExpiredPaymentWebhookLimit(
  transaction: Transaction,
  row: PaymentWebhookLimitRow,
  observedAt: Date,
  windowExpiresAt: Date,
): Promise<PaymentWebhookLimitRow> {
  if (row.window_expires_at.getTime() > observedAt.getTime()) return row;
  await transaction.paymentWebhookLimit.update({
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

function webhookSubjectHash(scope: string, ...values: string[]): string {
  return createHash("sha256")
    .update(["payment-webhook-limit-v1", scope, ...values].join("\0"))
    .digest("hex");
}
