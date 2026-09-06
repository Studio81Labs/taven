import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { AdminAccessModule } from "./modules/admin-access/admin-access.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AutomaticQuotesModule } from "./modules/automatic-quotes/automatic-quotes.module";
import { OrdersModule } from "./modules/orders/orders.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { PricingModule } from "./modules/pricing/pricing.module";
import { QuotesModule } from "./modules/quotes/quotes.module";
import { SlicingModule } from "./modules/slicing/slicing.module";
import { StorageModule } from "./modules/storage/storage.module";
import { ResourcesModule } from "./modules/resources/resources.module";

@Module({
  imports: [
    HealthModule,
    AutomaticQuotesModule,
    OrdersModule,
    QuotesModule,
    SlicingModule,
    PricingModule,
    ResourcesModule,
    StorageModule,
    PaymentsModule,
    AdminAccessModule,
    AuditModule,
  ],
})
export class AppModule {}
