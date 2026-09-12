import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { LegalApprovalsController } from "./legal-approvals.controller";
import { LegalApprovalsService } from "./legal-approvals.service";

@Module({
  imports: [PrismaModule],
  controllers: [LegalApprovalsController],
  providers: [LegalApprovalsService],
  exports: [LegalApprovalsService],
})
export class LegalApprovalsModule {}
