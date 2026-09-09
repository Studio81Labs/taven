import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import { SlicerProfileSnapshotsModule } from "../slicing/slicer-profile-snapshots.module";
import { CandidateEstimateService } from "./candidate-estimate.service";
import { EligibilityPlanService } from "./eligibility-plan.service";
import { ResourceCatalogService } from "./resource-catalog.service";
import { OperatorCatalogController } from "./operator-catalog.controller";
import { OperatorCatalogService } from "./operator-catalog.service";
import { ResourceReservationExpiryService } from "./resource-reservation-expiry.service";
import { ResourceReservationService } from "./resource-reservation.service";

@Module({
  imports: [
    PrismaModule,
    SlicerProfileSnapshotsModule,
    AdminAccessModule,
    AuditModule,
  ],
  controllers: [OperatorCatalogController],
  providers: [
    ResourceCatalogService,
    OperatorCatalogService,
    CandidateEstimateService,
    EligibilityPlanService,
    ResourceReservationService,
    ResourceReservationExpiryService,
  ],
  exports: [
    ResourceCatalogService,
    CandidateEstimateService,
    EligibilityPlanService,
    ResourceReservationService,
    ResourceReservationExpiryService,
  ],
})
export class ResourcesModule {}
