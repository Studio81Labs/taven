import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import { LegalDocumentsAdminController } from "./legal-documents-admin.controller";
import { LegalDocumentsController } from "./legal-documents.controller";
import { LegalDocumentsService } from "./legal-documents.service";

@Module({
  imports: [PrismaModule, AdminAccessModule, AuditModule],
  controllers: [LegalDocumentsAdminController, LegalDocumentsController],
  providers: [LegalDocumentsService],
  exports: [LegalDocumentsService],
})
export class LegalDocumentsModule {}
