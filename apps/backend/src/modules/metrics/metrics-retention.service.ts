import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

const MAX_LIMIT = 1_000;

/** Deletes expired, privacy-minimized raw BusinessEvent observations in bounded batches. */
@Injectable()
export class MetricsRetentionService {
  constructor(private readonly prisma: PrismaService) {}

  async runOnce(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit must be between 1 and ${MAX_LIMIT}`);
    }
    return this.prisma.$transaction(async (transaction) => {
      const due = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "business_events"
        WHERE "expires_at" <= clock_timestamp()
        ORDER BY "expires_at" ASC, "id" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
      if (due.length === 0) return 0;
      const deleted = await transaction.businessEvent.deleteMany({
        where: {
          id: { in: due.map(({ id }) => id) },
        },
      });
      return deleted.count;
    });
  }
}
