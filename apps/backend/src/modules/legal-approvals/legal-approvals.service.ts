import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  activeLegalApprovalCatalog,
  evaluateLegalApprovals,
  type EvaluatedLegalApprovals,
  type LegalApprovalCatalog,
} from "./legal-approvals.catalog";

@Injectable()
export class LegalApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  async availability(): Promise<EvaluatedLegalApprovals> {
    return this.evaluateAt(await databaseNow(this.prisma));
  }

  evaluateAt(
    observedAt: Date,
    catalog: LegalApprovalCatalog = activeLegalApprovalCatalog(),
  ): EvaluatedLegalApprovals {
    try {
      return evaluateLegalApprovals(observedAt, catalog);
    } catch {
      throw new ServiceUnavailableException({
        code: "LAUNCH_APPROVAL_REQUIRED",
        message: "Legal approval metadata is unavailable",
      });
    }
  }
}

async function databaseNow(
  client: Pick<PrismaService, "$queryRaw">,
): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ observed_at: Date }>>`
    SELECT clock_timestamp() AS observed_at
  `;
  const observedAt = rows[0]?.observed_at;
  if (!observedAt)
    throw new ServiceUnavailableException({
      code: "LAUNCH_APPROVAL_REQUIRED",
      message: "Legal approval time is unavailable",
    });
  return observedAt;
}
