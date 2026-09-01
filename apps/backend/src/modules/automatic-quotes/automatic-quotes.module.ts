import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ResourcesModule } from "../resources/resources.module";
import { AutomaticQuotesController } from "./automatic-quotes.controller";
import { AutomaticQuotesService } from "./automatic-quotes.service";
import {
  ConfiguredDeliveryCapabilityAdapter,
  DELIVERY_CAPABILITY,
} from "./delivery-capability.port";

@Module({
  imports: [PrismaModule, ResourcesModule],
  controllers: [AutomaticQuotesController],
  providers: [
    AutomaticQuotesService,
    ConfiguredDeliveryCapabilityAdapter,
    {
      provide: DELIVERY_CAPABILITY,
      useExisting: ConfiguredDeliveryCapabilityAdapter,
    },
  ],
  exports: [AutomaticQuotesService],
})
export class AutomaticQuotesModule {}
