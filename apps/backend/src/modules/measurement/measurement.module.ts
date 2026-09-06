import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import { MeasurementController } from "./measurement.controller";
import { MeasurementService } from "./measurement.service";

@Module({
  imports: [PrismaModule, AdminAccessModule, AuditModule],
  controllers: [MeasurementController],
  providers: [MeasurementService],
})
export class MeasurementModule {}
