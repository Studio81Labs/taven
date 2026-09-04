import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PAYMENT_PROVIDER,
  type PaymentProviderPort,
} from "./payment-provider.port";

const CLAIM_LEASE_MILLISECONDS = 5 * 60 * 1_000;
const MAX_LAST_ERROR_LENGTH = 1_000;

type ClaimedMessage = {
  id: string;
  attempts: number;
  message_type: "void_payment" | "refund_payment";
  aggregate_id: string;
  payload: Prisma.JsonValue;
};

type RefundDispatchClaim = {
  claimed_at: Date | null;
};

@Injectable()
export class PaymentOutboxDispatcherService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProviderPort,
  ) {}

  async runOnce(limit = 25): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("payment outbox limit must be 1 through 100");
    }
    const messages = await this.claim(limit);
    let delivered = 0;
    for (const message of messages) {
      try {
        if (message.message_type === "void_payment") {
          await this.voidPayment(message);
        } else {
          await this.refundPayment(message);
        }
        const updated = await this.prisma.outboxMessage.updateMany({
          where: {
            id: message.id,
            status: "PROCESSING",
            attempts: message.attempts,
          },
          data: {
            status: "DELIVERED",
            deliveredAt: new Date(),
            lockedAt: null,
            lastError: null,
          },
        });
        if (updated.count !== 1) {
          throw new Error("payment outbox claim was lost after dispatch");
        }
        delivered += 1;
      } catch (error) {
        await this.fail(message, error);
      }
    }
    return delivered;
  }

  private async voidPayment(message: ClaimedMessage): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: message.aggregate_id },
    });
    if (!payment) {
      throw new Error("void command no longer matches its Payment");
    }
    if (payment.status !== "VOIDED") return;
    const payload = messagePayload(message.payload);
    if (
      payload.paymentId !== payment.id ||
      payload.provider !== payment.provider ||
      payload.action !== "void_payment"
    ) {
      throw new Error("void command payload does not match its Payment");
    }
    const providerIntentId =
      payment.providerIntentId ?? payload.providerIntentId;
    if (!providerIntentId) {
      throw new Error("void command has no provider intent");
    }
    this.assertProvider(payment.provider);
    await this.provider.cancelIntent(providerIntentId);
  }

  private async refundPayment(message: ClaimedMessage): Promise<void> {
    const refund = await this.prisma.refundTransaction.findUnique({
      where: { id: message.aggregate_id },
      include: { payment: true },
    });
    if (!refund || refund.status === "SUCCEEDED") return;
    if (refund.status !== "PENDING") {
      throw new Error("refund command no longer matches its transaction");
    }
    const payload = messagePayload(message.payload);
    if (
      payload.refundTransactionId !== refund.id ||
      payload.paymentId !== refund.paymentId ||
      payload.provider !== refund.payment.provider ||
      payload.amountMinor !== refund.amountMinor.toString() ||
      payload.currency !== refund.payment.currency ||
      payload.idempotencyKey !== refund.idempotencyKey ||
      payload.action !== "refund_payment"
    ) {
      throw new Error("refund command payload does not match its transaction");
    }
    const providerIntentId =
      refund.payment.providerIntentId ?? payload.providerIntentId;
    if (!providerIntentId) {
      throw new Error("refund command has no provider intent");
    }
    this.assertProvider(refund.payment.provider);
    const claims = await this.prisma.$queryRaw<RefundDispatchClaim[]>`
      SELECT taven_claim_refund_dispatch(${refund.id}::uuid) AS claimed_at
    `;
    if (
      !claims[0]?.claimed_at &&
      this.provider.refundRetrySafety() === "MANUAL_RECONCILIATION"
    ) {
      throw new Error(
        "refund dispatch result is ambiguous; manual provider reconciliation required",
      );
    }
    const result = await this.provider.refund({
      paymentId: refund.paymentId,
      providerIntentId,
      amountMinor: refund.amountMinor,
      currency: refund.payment.currency,
      idempotencyKey: refund.idempotencyKey,
    });
    const providerRefundId = providerIdentifier(
      result.providerRefundId,
      "refund identifier",
    );
    const resultEventId = `refund-succeeded:${createHash("sha256")
      .update(
        `${refund.payment.provider}:${refund.id}:${providerRefundId}`,
        "utf8",
      )
      .digest("hex")}`;
    await this.prisma.$queryRaw`
      SELECT taven_apply_checkout_refund_success(
        ${refund.id}::uuid,
        ${providerRefundId},
        ${resultEventId},
        ${result.occurredAt},
        ${jsonInput(result.evidence)}::jsonb
      )
    `;
  }

  private assertProvider(provider: string): void {
    if (provider !== this.provider.capabilities().provider) {
      throw new Error("payment command targets an inactive provider");
    }
  }

  private claim(limit: number): Promise<ClaimedMessage[]> {
    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MILLISECONDS);
    return this.prisma.$transaction(
      (transaction) =>
        transaction.$queryRaw<ClaimedMessage[]>`
        WITH due AS (
          SELECT id
          FROM outbox_messages
          WHERE message_type IN ('void_payment', 'refund_payment')
            AND (
              (status IN ('PENDING', 'FAILED') AND available_at <= clock_timestamp())
              OR (status = 'PROCESSING' AND locked_at < ${staleBefore})
            )
          ORDER BY available_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT ${limit}
        )
        UPDATE outbox_messages message
        SET status = 'PROCESSING', attempts = message.attempts + 1,
            locked_at = clock_timestamp(), last_error = NULL,
            updated_at = clock_timestamp()
        FROM due
        WHERE message.id = due.id
        RETURNING message.id, message.attempts, message.message_type,
                  message.aggregate_id, message.payload
      `,
    );
  }

  private async fail(message: ClaimedMessage, error: unknown): Promise<void> {
    const delaySeconds = Math.min(300, 2 ** Math.min(message.attempts, 8));
    await this.prisma.outboxMessage.updateMany({
      where: {
        id: message.id,
        status: "PROCESSING",
        attempts: message.attempts,
      },
      data: {
        status: "FAILED",
        lockedAt: null,
        availableAt: new Date(Date.now() + delaySeconds * 1_000),
        lastError: safeLastError(error),
      },
    });
  }
}

function safeLastError(error: unknown): string {
  const value =
    error instanceof Error ? error.message : "unknown payment error";
  return value
    .replace(/(?:redis|rediss|https?):\/\/\S+/giu, "service endpoint")
    .replace(
      /\b(?:authorization|bearer|password|secret|token)\b/giu,
      "credential",
    )
    .slice(0, MAX_LAST_ERROR_LENGTH);
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function messagePayload(value: Prisma.JsonValue): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("payment command payload is invalid");
  }
  const result: Record<string, string> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (typeof nested === "string") result[key] = nested;
  }
  return result;
}

function providerIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new Error(`payment provider returned an invalid ${name}`);
  }
  return normalized;
}
