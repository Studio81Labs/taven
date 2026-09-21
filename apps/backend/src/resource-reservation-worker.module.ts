import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { ResourceReservationExpiryService } from "./modules/resources/resource-reservation-expiry.service";

@Module({
  imports: [PrismaModule],
  providers: [ResourceReservationExpiryService],
})
export class ResourceReservationWorkerModule {}
