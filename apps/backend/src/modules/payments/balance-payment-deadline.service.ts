import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

const MAX_BATCH_LIMIT = 1_000;

type ClosedBalancePayment = {
  payment_id: string;
  settlement_id: string;
};

/**
 * Closes post-QC balance payments whose immutable business deadline elapsed.
 *
 * The database function owns candidate claiming, row locking, void outbox
 * creation, settlement, and the terminal order transition. Keeping that
 * complete lifecycle in one SQL statement prevents this worker from
 * duplicating or partially applying financial state changes.
 */
@Injectable()
export class BalancePaymentDeadlineService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Process at most `limit` expired balance payments; safe for concurrent workers. */
  async runOnce(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) {
      throw new Error(
        `balance payment deadline worker limit must be 1 through ${MAX_BATCH_LIMIT}`,
      );
    }

    const closed = await this.prisma.$queryRaw<ClosedBalancePayment[]>`
      SELECT payment_id, settlement_id
      FROM taven_close_expired_balance_payments(${limit})
    `;
    return closed.length;
  }
}
