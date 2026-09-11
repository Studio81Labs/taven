import { Body, Controller, HttpCode, Ip, Post } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from "@nestjs/swagger";
import {
  AutomaticQuoteEstimateDto,
  CreateAutomaticQuoteEstimateDto,
} from "./automatic-quotes.dto";
import { AutomaticQuotesService } from "./automatic-quotes.service";

@ApiTags("automatic quotes")
@Controller("automatic-quote-estimates")
export class AutomaticQuoteEstimatesController {
  constructor(private readonly automaticQuotes: AutomaticQuotesService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Calculate an immediate non-binding estimate from local geometry only",
  })
  @ApiBody({ type: CreateAutomaticQuoteEstimateDto })
  @ApiOkResponse({ type: AutomaticQuoteEstimateDto })
  @ApiBadRequestResponse({
    description:
      "Geometry, STANDARD-only quality, or public monetary result is outside safe bounds",
  })
  @ApiTooManyRequestsResponse({
    description: "Anonymous estimate limit is exhausted",
  })
  @ApiServiceUnavailableResponse({
    description:
      "Estimate publication awaits launch approval or its default configuration is unavailable",
  })
  estimate(
    @Body() body: CreateAutomaticQuoteEstimateDto,
    @Ip() clientAddress: string,
  ): Promise<AutomaticQuoteEstimateDto> {
    return this.automaticQuotes.estimate(body, clientAddress);
  }
}
