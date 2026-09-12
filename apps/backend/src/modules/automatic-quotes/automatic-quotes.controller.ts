import {
  Body,
  Controller,
  Delete,
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
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import {
  AttachAutomaticQuoteModelFileDto,
  AutomaticQuoteHandoffCapabilityDto,
  AutomaticQuoteRiskDecisionDto,
  AutomaticQuoteSessionCreatedDto,
  AutomaticQuoteSessionDto,
  ConfigureAutomaticQuoteItemDto,
  CreateAutomaticQuoteSessionDto,
  RecordAutomaticQuoteObservationDto,
  ReplaceAutomaticQuoteConfigurationDto,
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
const SESSION_ID_PARAM = { name: "sessionId", type: String, format: "uuid" };

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
  @ApiParam(SESSION_ID_PARAM)
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiUnauthorizedResponse({ description: "Session capability is invalid" })
  get(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.getSession(sessionId, authorization);
  }

  @Post(":sessionId/observations")
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiParam(SESSION_ID_PARAM)
  @ApiOperation({
    summary: "Record one deduplicated quote or checkout observation",
  })
  @ApiBody({ type: RecordAutomaticQuoteObservationDto })
  @ApiNoContentResponse({ description: "Observation was recorded or replayed" })
  @ApiUnauthorizedResponse({ description: "Session capability is invalid" })
  @ApiGoneResponse({ description: "Session is no longer available" })
  observe(
    @Param("sessionId") sessionId: string,
    @Body() body: RecordAutomaticQuoteObservationDto,
    @Headers("authorization") authorization?: string,
  ): Promise<void> {
    return this.automaticQuotes.recordObservation(
      sessionId,
      body,
      authorization,
    );
  }

  @Post(":sessionId/handoff-capabilities")
  @ApiBearerAuth()
  @ApiParam(SESSION_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary:
      "Mint one single-use assisted quote-request handoff capability with a canonical issuance key",
  })
  @ApiCreatedResponse({ type: AutomaticQuoteHandoffCapabilityDto })
  @ApiConflictResponse({
    description:
      "Only the original issuance key may replay the stored response for seven days. Alternate keys, changed input, expired replay windows, and exhausted legacy issuance conflict.",
  })
  @ApiUnauthorizedResponse({ description: "Session capability is invalid" })
  @ApiGoneResponse({
    description:
      "The source capability/session is no longer authorized; this takes precedence over an otherwise replayable issuance response",
  })
  createHandoffCapability(
    @Param("sessionId") sessionId: string,
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteHandoffCapabilityDto> {
    return this.automaticQuotes.createHandoffCapability(
      sessionId,
      authorization,
      idempotencyKey,
    );
  }

  @Post(":sessionId/model-files")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiParam(SESSION_ID_PARAM)
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
  @ApiParam(SESSION_ID_PARAM)
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

  @Put(":sessionId/configuration")
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Atomically replace all selected body groups" })
  @ApiParam(SESSION_ID_PARAM)
  @ApiBody({ type: ReplaceAutomaticQuoteConfigurationDto })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiConflictResponse({
    description: "Inspection is pending or configuration is frozen",
  })
  replaceConfiguration(
    @Param("sessionId") sessionId: string,
    @Body() body: ReplaceAutomaticQuoteConfigurationDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.replaceConfiguration(
      sessionId,
      body,
      authorization,
      idempotencyKey,
    );
  }

  @Delete(":sessionId/items/:ordinal/configuration")
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Remove one selected body group" })
  @ApiParam(SESSION_ID_PARAM)
  @ApiParam({ name: "ordinal", type: "integer" })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiConflictResponse({ description: "Configuration is frozen" })
  removeConfiguration(
    @Param("sessionId") sessionId: string,
    @Param("ordinal") ordinal: string,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AutomaticQuoteSessionDto> {
    return this.automaticQuotes.removeItem(
      sessionId,
      ordinal,
      authorization,
      idempotencyKey,
    );
  }

  @Post(":sessionId/risk-decisions")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiParam(SESSION_ID_PARAM)
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
  @ApiParam(SESSION_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Select a provider-verified order destination" })
  @ApiBody({ type: SelectAutomaticQuoteDestinationDto })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiBadRequestResponse({
    description: "Destination is invalid, unavailable, or incompatible",
  })
  @ApiConflictResponse({
    description:
      "Configuration changed, destination is frozen, or idempotency input changed",
  })
  @ApiServiceUnavailableResponse({
    description: "Carrier metadata or validation is temporarily unavailable",
  })
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
  @ApiParam(SESSION_ID_PARAM)
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
  @ApiParam(SESSION_ID_PARAM)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: "Advance slicing, binding price, and eligibility preparation",
  })
  @ApiOkResponse({ type: AutomaticQuoteSessionDto })
  @ApiServiceUnavailableResponse({
    description: "Binding quote flows await launch approval",
  })
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
