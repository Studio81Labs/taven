import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

const MAX_BATCH_LIMIT = 1_000;

/** Claims and expires bounded RESERVED sets using database row locks. */
@Injectable()
export class ResourceReservationExpiryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async runOnce(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIMIT) {
      throw new Error(
        `resource reservation expiry worker limit must be 1 through ${MAX_BATCH_LIMIT}`,
      );
    }
    const expired = await this.prisma.$queryRaw<
      Array<{ phase_reservation_set_id: string }>
    >`
      SELECT phase_reservation_set_id
      FROM taven_expire_reserved_phase_reservation_sets(${limit})
    `;
    return expired.length;
  }
}
