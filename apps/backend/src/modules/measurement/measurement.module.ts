import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { AdminAccessModule } from "../admin-access/admin-access.module";
import { AuditModule } from "../audit/audit.module";
import {
  HandlingSessionReadController,
  MeasurementController,
  MeasurementReadController,
} from "./measurement.controller";
import { MeasurementService } from "./measurement.service";

@Module({
  imports: [PrismaModule, AdminAccessModule, AuditModule],
  controllers: [
    MeasurementController,
    MeasurementReadController,
    HandlingSessionReadController,
  ],
  providers: [MeasurementService],
})
export class MeasurementModule {}
