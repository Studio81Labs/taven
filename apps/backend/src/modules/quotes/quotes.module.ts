import { Module } from "@nestjs/common";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { LegalApprovalsModule } from "../legal-approvals/legal-approvals.module";
import {
  OffersController,
  IndividualOrderPreparationController,
  OperatorQuoteRequestsController,
  QuoteRequestsController,
} from "./quotes.controller";
import { QuotesService } from "./quotes.service";
import { OperatorQuoteModelsService } from "./operator-quote-models.service";
import { AutomaticQuotesModule } from "../automatic-quotes/automatic-quotes.module";
import { ResourcesModule } from "../resources/resources.module";
import { IndividualResourcePreparationService } from "./individual-resource-preparation.service";

@Module({
  imports: [
    AdminAccessModule,
    AuditModule,
    StorageModule,
    LegalApprovalsModule,
    AutomaticQuotesModule,
    ResourcesModule,
  ],
  controllers: [
    QuoteRequestsController,
    OffersController,
    IndividualOrderPreparationController,
    OperatorQuoteRequestsController,
  ],
  providers: [
    QuotesService,
    OperatorQuoteModelsService,
    IndividualResourcePreparationService,
  ],
  exports: [QuotesService],
})
export class QuotesModule {}
