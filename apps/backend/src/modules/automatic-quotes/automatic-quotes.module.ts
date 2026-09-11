import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ResourcesModule } from "../resources/resources.module";
import { AutomaticQuoteEstimatesController } from "./automatic-quote-estimates.controller";
import { AutomaticQuotesController } from "./automatic-quotes.controller";
import { AutomaticQuotesService } from "./automatic-quotes.service";
import {
  ConfiguredDeliveryCapabilityAdapter,
  DELIVERY_CAPABILITY,
} from "./delivery-capability.port";

@Module({
  imports: [PrismaModule, ResourcesModule],
  controllers: [AutomaticQuotesController, AutomaticQuoteEstimatesController],
  providers: [
    AutomaticQuotesService,
    ConfiguredDeliveryCapabilityAdapter,
    {
      provide: DELIVERY_CAPABILITY,
      useExisting: ConfiguredDeliveryCapabilityAdapter,
    },
  ],
  exports: [AutomaticQuotesService, DELIVERY_CAPABILITY],
})
export class AutomaticQuotesModule {}
