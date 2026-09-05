import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

const MAX_BATCH_LIMIT = 1_000;

@Injectable()
export class CheckoutPaymentDeadlineService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async runOnce(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) {
      throw new Error(
        `checkout payment deadline worker limit must be 1 through ${MAX_BATCH_LIMIT}`,
      );
    }
    const closed = await this.prisma.$queryRaw<Array<{ payment_id: string }>>`
      SELECT payment_id
      FROM taven_close_expired_checkout_payments(${limit})
    `;
    return closed.length;
  }
}
