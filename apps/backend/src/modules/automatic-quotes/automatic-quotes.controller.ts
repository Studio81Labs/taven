import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import {
  AttachAutomaticQuoteModelFileDto,
  AutomaticQuoteRiskDecisionDto,
  AutomaticQuoteSessionCreatedDto,
  AutomaticQuoteSessionDto,
  ConfigureAutomaticQuoteItemDto,
  CreateAutomaticQuoteSessionDto,
  SelectAutomaticQuoteDestinationDto,
  SetAutomaticQuoteExpressDto,
} from "./automatic-quotes.dto";
import { AutomaticQuotesService } from "./automatic-quotes.service";

const TRIMMED_IDEMPOTENCY_KEY_PATTERN = "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$";
const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  description: "Stable command key; replaying altered input returns 409",
  schema: {
    type: "string",
    minLength: 8,
    pattern: TRIMMED_IDEMPOTENCY_KEY_PATTERN,
  },
};

@ApiTags("automatic quotes")
@Controller("automatic-quote-sessions")
export class AutomaticQuotesController {
  constructor(private readonly automaticQuotes: AutomaticQuotesService) {}

  @Post()
  @ApiOperation({ summary: "Start a resumable direct quote" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateAutomaticQuoteSessionDto })
  @ApiCreatedResponse({ type: AutomaticQuoteSessionCreatedDto })
  @ApiConflictResponse({ description: "Idempotency input changed" })
  @ApiTooManyRequestsResponse({
    description: "Anonymous quote-submission limit is exhausted",
  })
  create(
    @Body() body: CreateAutomaticQuoteSessionDto,
    @Ip() clientAddress: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionCreatedDto> {
    return this.automaticQuotes.createSession(
      body,
      clientAddress,
      idempotencyKey,
    );
  }

  @Get(":sessionId")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Resume or poll one direct quote" })
  @ApiParam({ name: "sessionId", type: String, format: "uuid" })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiUnauthorizedResponse({ description: "Session capability is invalid" })
  get(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.getSession(sessionId, authorization);
  }

  @Post(":sessionId/model-files")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Attach a confirmed model and request inspection" })
  @ApiBody({ type: AttachAutomaticQuoteModelFileDto })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiUnauthorizedResponse({
    description: "Session or upload capability is invalid",
  })
  @ApiGoneResponse({ description: "Session or source expired" })
  attach(
    @Param("sessionId") sessionId: string,
    @Body() body: AttachAutomaticQuoteModelFileDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.attachModelFile(
      sessionId,
      body,
      authorization,
      idempotencyKey,
    );
  }

  @Put(":sessionId/items/:ordinal/configuration")
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Configure one selected body group" })
  @ApiParam({ name: "ordinal", type: "integer" })
  @ApiBody({ type: ConfigureAutomaticQuoteItemDto })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiConflictResponse({
    description: "Inspection is pending or configuration is frozen",
  })
  configure(
    @Param("sessionId") sessionId: string,
    @Param("ordinal") ordinal: string,
    @Body() body: ConfigureAutomaticQuoteItemDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.configureItem(
      sessionId,
      ordinal,
      body,
      authorization,
      idempotencyKey,
    );
  }

  @Post(":sessionId/risk-decisions")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: "Acknowledge or decline one current preflight risk",
  })
  @ApiBody({ type: AutomaticQuoteRiskDecisionDto })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  decideRisk(
    @Param("sessionId") sessionId: string,
    @Body() body: AutomaticQuoteRiskDecisionDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.decideRisk(
      sessionId,
      body,
      authorization,
      idempotencyKey,
    );
  }

  @Put(":sessionId/delivery-destination")
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Select a provider-verified order destination" })
  @ApiBody({ type: SelectAutomaticQuoteDestinationDto })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  selectDestination(
    @Param("sessionId") sessionId: string,
    @Body() body: SelectAutomaticQuoteDestinationDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.selectDestination(
      sessionId,
      body,
      authorization,
      idempotencyKey,
    );
  }

  @Put(":sessionId/express")
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Set the whole-order express preference" })
  @ApiBody({ type: SetAutomaticQuoteExpressDto })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  setExpress(
    @Param("sessionId") sessionId: string,
    @Body() body: SetAutomaticQuoteExpressDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.setExpress(
      sessionId,
      body.requested,
      authorization,
      idempotencyKey,
    );
  }

  @Post(":sessionId/prepare")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: "Advance slicing, binding price, and eligibility preparation",
  })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  prepare(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.prepare(
      sessionId,
      authorization,
      idempotencyKey,
    );
  }
}
