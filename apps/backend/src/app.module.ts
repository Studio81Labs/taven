import { Module } from "@nestjs/common";
import { HealthModule } from "./health/health.module";
import { AdminAccessModule } from "./modules/admin-access/admin-access.module";
import { AuditModule } from "./modules/audit/audit.module";
import { MeasurementModule } from "./modules/measurement/measurement.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { AutomaticQuotesModule } from "./modules/automatic-quotes/automatic-quotes.module";
import { OrdersModule } from "./modules/orders/orders.module";
import { OperatorReadsModule } from "./modules/operator-reads/operator-reads.module";
import { PaymentsModule } from "./modules/payments/payments.module";
import { PricingModule } from "./modules/pricing/pricing.module";
import { QuotesModule } from "./modules/quotes/quotes.module";
import { SlicingModule } from "./modules/slicing/slicing.module";
import { StorageModule } from "./modules/storage/storage.module";
import { ResourcesModule } from "./modules/resources/resources.module";
import { LegalApprovalsModule } from "./modules/legal-approvals/legal-approvals.module";

@Module({
  imports: [
    HealthModule,
    AutomaticQuotesModule,
    OrdersModule,
    OperatorReadsModule,
    QuotesModule,
    SlicingModule,
    PricingModule,
    ResourcesModule,
    LegalApprovalsModule,
    StorageModule,
    PaymentsModule,
    AdminAccessModule,
    AuditModule,
    MeasurementModule,
    MetricsModule,
  ],
})
export class AppModule {}
