import { Module } from "@nestjs/common";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import {
  OffersController,
  OperatorQuoteRequestsController,
  QuoteRequestsController,
} from "./quotes.controller";
import { QuotesService } from "./quotes.service";

@Module({
  imports: [AdminAccessModule, AuditModule, StorageModule],
  controllers: [
    QuoteRequestsController,
    OffersController,
    OperatorQuoteRequestsController,
  ],
  providers: [QuotesService],
  exports: [QuotesService],
})
export class QuotesModule {}
