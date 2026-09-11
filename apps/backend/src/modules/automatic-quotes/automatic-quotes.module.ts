import { Module } from "@nestjs/common";
import { PrismaModule } from "../../prisma/prisma.module";
import { ResourcesModule } from "../resources/resources.module";
import { AutomaticQuoteEstimatesController } from "./automatic-quote-estimates.controller";
import { AutomaticQuotesController } from "./automatic-quotes.controller";
import { AutomaticQuotesService } from "./automatic-quotes.service";
import {
  DELIVERY_CAPABILITY,
  deliveryCapabilityFromEnvironment,
} from "./delivery-capability.port";

@Module({
  imports: [PrismaModule, ResourcesModule],
  controllers: [AutomaticQuotesController, AutomaticQuoteEstimatesController],
  providers: [
    AutomaticQuotesService,
    {
      provide: DELIVERY_CAPABILITY,
      useFactory: deliveryCapabilityFromEnvironment,
    },
  ],
  exports: [AutomaticQuotesService, DELIVERY_CAPABILITY],
})
export class AutomaticQuotesModule {}
