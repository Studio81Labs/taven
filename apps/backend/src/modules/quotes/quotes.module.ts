import { Module } from "@nestjs/common";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { LegalApprovalsModule } from "../legal-approvals/legal-approvals.module";
import {
  OffersController,
  OperatorQuoteRequestsController,
  QuoteRequestsController,
} from "./quotes.controller";
import { QuotesService } from "./quotes.service";
import { OperatorQuoteModelsService } from "./operator-quote-models.service";
import { AutomaticQuotesModule } from "../automatic-quotes/automatic-quotes.module";

@Module({
  imports: [
    AdminAccessModule,
    AuditModule,
    StorageModule,
    LegalApprovalsModule,
    AutomaticQuotesModule,
  ],
  controllers: [
    QuoteRequestsController,
    OffersController,
    OperatorQuoteRequestsController,
  ],
  providers: [QuotesService, OperatorQuoteModelsService],
  exports: [QuotesService],
})
export class QuotesModule {}
