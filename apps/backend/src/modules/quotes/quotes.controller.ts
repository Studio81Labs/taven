import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Ip,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import { CurrentOperator } from "../admin-access/current-operator.decorator";
import { OPERATOR_CSRF_HEADER } from "../admin-access/operator-auth.openapi";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { RequireOperatorPermissions } from "../admin-access/require-operator-permissions.decorator";
import {
  ConfirmedUploadResponseDto,
  InitiateOperatorModelUploadDto,
  SignedDownloadResponseDto,
  UploadIntentResponseDto,
} from "../storage/storage.dto";
import { UploadService } from "../storage/upload.service";
import {
  AcceptOfferDto,
  AcceptedOfferDto,
  CreateQuoteRequestDto,
  IssueOfferDto,
  OfferIssuedDto,
  OfferPreviewDto,
  OfferDraftPreviewDto,
  OperatorOfferDetailDto,
  OperatorQuoteRequestDetailDto,
  OperatorQuoteRequestPageDto,
  QuoteRequestCreatedDto,
  QuoteRequestDetailDto,
  QuoteRequestStatusDto,
  ReissueOfferDto,
  RejectOfferDto,
} from "./quotes.dto";
import { QuotesService } from "./quotes.service";
import {
  ImportQuoteRequestModelDto,
  QuoteRequestModelAttachedDto,
  QuoteRequestModelsDto,
  QuoteRequestModelSelectedDto,
  SelectQuoteRequestModelDto,
  PrepareQuoteRequestReferenceDto,
  QuoteRequestReferencePreparationDto,
  QuoteComposerChoicesDto,
} from "./operator-quote-models.dto";
import { OperatorQuoteModelsService } from "./operator-quote-models.service";

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
const OPERATOR_QUEUE_PAGE_FIELDS = new Set([
  "status",
  "sla",
  "cursor",
  "limit",
]);

@ApiTags("quote requests")
@Controller("quote-requests")
export class QuoteRequestsController {
  constructor(private readonly quotes: QuotesService) {}

  @Post()
  @ApiOperation({ summary: "Submit an individual quote request" })
  @ApiBody({ type: CreateQuoteRequestDto })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiCreatedResponse({ type: QuoteRequestCreatedDto })
  @ApiUnauthorizedResponse({
    description: "Automatic quote handoff capability is invalid or unavailable",
  })
  @ApiConflictResponse({ description: "Idempotency input changed" })
  @ApiTooManyRequestsResponse({
    description: "Anonymous quote-submission limit is exhausted",
  })
  @ApiServiceUnavailableResponse({
    description:
      "Effective privacy or optional photo-consent approval is unavailable",
  })
  create(
    @Body() body: CreateQuoteRequestDto,
    @Ip() clientAddress: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestCreatedDto> {
    return this.quotes.createRequest(body, clientAddress, idempotencyKey);
  }

  @Get(":requestId")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Resume one request with its scoped capability" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: QuoteRequestDetailDto })
  @ApiUnauthorizedResponse({ description: "Request capability is invalid" })
  get(
    @Param("requestId") requestId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<QuoteRequestDetailDto> {
    return this.quotes.getRequest(requestId, authorization);
  }
}

@ApiTags("individual offers")
@Controller("offers")
export class OffersController {
  constructor(private readonly quotes: QuotesService) {}

  @Get(":quoteId")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Preview one immutable individual offer" })
  @ApiParam({ name: "quoteId", type: String, format: "uuid" })
  @ApiOkResponse({ type: OfferPreviewDto })
  @ApiUnauthorizedResponse({ description: "Offer capability is invalid" })
  @ApiGoneResponse({ description: "Offer is closed or expired" })
  preview(
    @Param("quoteId") quoteId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<OfferPreviewDto> {
    return this.quotes.previewOffer(quoteId, authorization);
  }

  @Post(":quoteId/accept")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Accept an offer and create its draft order" })
  @ApiParam({ name: "quoteId", type: String, format: "uuid" })
  @ApiBody({ type: AcceptOfferDto })
  @ApiOkResponse({ type: AcceptedOfferDto })
  @ApiUnauthorizedResponse({ description: "Offer capability is invalid" })
  @ApiGoneResponse({ description: "Offer is closed or expired" })
  @ApiConflictResponse({ description: "Offer version or terms changed" })
  @ApiServiceUnavailableResponse({
    description: "Binding offer flows await launch approval",
  })
  accept(
    @Param("quoteId") quoteId: string,
    @Body() body: AcceptOfferDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<AcceptedOfferDto> {
    return this.quotes.acceptOffer(
      quoteId,
      body,
      authorization,
      idempotencyKey,
    );
  }

  @Post(":quoteId/reject")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Reject an individual offer" })
  @ApiParam({ name: "quoteId", type: String, format: "uuid" })
  @ApiBody({ type: RejectOfferDto })
  @ApiOkResponse({ type: QuoteRequestStatusDto })
  @ApiUnauthorizedResponse({ description: "Offer capability is invalid" })
  @ApiGoneResponse({ description: "Offer is closed or expired" })
  reject(
    @Param("quoteId") quoteId: string,
    @Body() body: RejectOfferDto,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestStatusDto> {
    return this.quotes.rejectOffer(
      quoteId,
      body,
      authorization,
      idempotencyKey,
    );
  }
}

@ApiTags("operator quote requests")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.QUOTES_WRITE)
@Controller("admin/quote-requests")
export class OperatorQuoteRequestsController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly uploads: UploadService,
    private readonly models: OperatorQuoteModelsService,
  ) {}

  @Get()
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
  @ApiOperation({ summary: "List the operator quote-request queue" })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["NEW", "IN_REVIEW", "QUOTED", "ACCEPTED", "REJECTED", "EXPIRED"],
    description:
      "Defaults to actionable NEW, IN_REVIEW, and QUOTED requests; select a terminal status explicitly to read history",
  })
  @ApiOkResponse({ type: OperatorQuoteRequestDetailDto, isArray: true })
  list(
    @CurrentOperator() operator: OperatorContext,
    @Query("status") status?: string,
  ): Promise<OperatorQuoteRequestDetailDto[]> {
    return this.quotes.listRequests(operator, status);
  }

  @Get("page")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
  @ApiOperation({ summary: "Page the operator quote-request queue" })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["NEW", "IN_REVIEW", "QUOTED", "ACCEPTED", "REJECTED", "EXPIRED"],
    description:
      "Defaults to actionable NEW, IN_REVIEW, and QUOTED requests; select a terminal status explicitly to read history",
  })
  @ApiQuery({
    name: "sla",
    required: false,
    enum: ["PENDING", "MET", "BREACHED"],
  })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({ type: OperatorQuoteRequestPageDto })
  page(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<OperatorQuoteRequestPageDto> {
    return this.quotes.listRequestsPage(
      operator,
      operatorQueuePageQuery(query),
    );
  }

  @Get(":requestId")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
  @ApiOperation({ summary: "Read one operator quote-request detail" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: OperatorQuoteRequestDetailDto })
  get(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
  ): Promise<OperatorQuoteRequestDetailDto> {
    return this.quotes.getOperatorRequest(operator, requestId);
  }

  @Get(":requestId/offers/:quoteId")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read one immutable offer without a customer capability",
  })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiParam({ name: "quoteId", type: String, format: "uuid" })
  @ApiOkResponse({ type: OperatorOfferDetailDto })
  operatorOffer(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Param("quoteId") quoteId: string,
  ): Promise<OperatorOfferDetailDto> {
    return this.quotes.getOperatorOffer(operator, requestId, quoteId);
  }

  @Get(":requestId/composer")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
  @ApiOperation({
    summary: "Read typed offer composer choices and current policy",
  })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: QuoteComposerChoicesDto })
  composerChoices(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
  ): Promise<QuoteComposerChoicesDto> {
    return this.models.composerChoices(operator, requestId);
  }

  @Post(":requestId/offers/preview")
  @HttpCode(200)
  @ApiOperation({
    summary: "Validate and preview exact offer price and payment schedule",
  })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: IssueOfferDto })
  @ApiOkResponse({ type: OfferDraftPreviewDto })
  previewDraftOffer(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Body() body: IssueOfferDto,
  ): Promise<OfferDraftPreviewDto> {
    return this.quotes.previewDraftOffer(operator, requestId, body);
  }

  @Post(":requestId/model-uploads")
  @ApiOperation({ summary: "Initiate a request-scoped operator model upload" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: InitiateOperatorModelUploadDto })
  @ApiCreatedResponse({ type: UploadIntentResponseDto })
  initiateModelUpload(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Body() body: InitiateOperatorModelUploadDto,
  ): Promise<UploadIntentResponseDto> {
    return this.uploads.initiateOperatorModelUpload(operator, requestId, body);
  }

  @Post(":requestId/model-uploads/:uploadId/confirm")
  @HttpCode(200)
  @ApiOperation({ summary: "Confirm and attach a verified operator model" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiParam({ name: "uploadId", type: String, format: "uuid" })
  @ApiHeader({
    name: "Authorization",
    description: "Bearer token returned by request-scoped upload initiation",
    required: true,
  })
  @ApiOkResponse({ type: ConfirmedUploadResponseDto })
  confirmModelUpload(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Param("uploadId") uploadId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<ConfirmedUploadResponseDto> {
    return this.uploads.confirmOperatorModelUpload(
      operator,
      requestId,
      uploadId,
      authorization,
    );
  }

  @Post(":requestId/models/:modelFileId/download")
  @HttpCode(200)
  @ApiOperation({ summary: "Download an attached retained model source" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiParam({ name: "modelFileId", type: String, format: "uuid" })
  @ApiOkResponse({ type: SignedDownloadResponseDto })
  downloadModel(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Param("modelFileId") modelFileId: string,
  ): Promise<SignedDownloadResponseDto> {
    return this.uploads.createOperatorQuoteModelDownload(
      operator,
      requestId,
      modelFileId,
    );
  }

  @Get(":requestId/models")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
  @ApiOperation({ summary: "List attached models and preparation evidence" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: QuoteRequestModelsDto })
  modelsForRequest(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
  ): Promise<QuoteRequestModelsDto> {
    return this.models.list(operator, requestId);
  }

  @Post(":requestId/models/import")
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: "Attach a retained handoff model or retry an attached inspection",
  })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: ImportQuoteRequestModelDto })
  @ApiCreatedResponse({ type: QuoteRequestModelAttachedDto })
  importHandoffModel(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Body() body: ImportQuoteRequestModelDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestModelAttachedDto> {
    return this.models.importHandoffModel(
      operator,
      requestId,
      body.modelFileId,
      idempotencyKey,
    );
  }

  @Post(":requestId/models/select")
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: "Select inspected bodies for an immutable request model",
  })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: SelectQuoteRequestModelDto })
  @ApiCreatedResponse({ type: QuoteRequestModelSelectedDto })
  selectModelBodies(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Body() body: SelectQuoteRequestModelDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestModelSelectedDto> {
    return this.models.selectBodies(operator, requestId, body, idempotencyKey);
  }

  @Post(":requestId/references/prepare")
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({
    summary: "Prepare selected model reference slices with worker v2",
  })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: PrepareQuoteRequestReferenceDto })
  @ApiCreatedResponse({ type: QuoteRequestReferencePreparationDto })
  prepareReference(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Body() body: PrepareQuoteRequestReferenceDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestReferencePreparationDto> {
    return this.models.prepareReference(
      operator,
      requestId,
      body,
      idempotencyKey,
    );
  }

  @Get(":requestId/references/status")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
  @ApiOperation({ summary: "Read selected model reference preparation status" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiQuery({ name: "selectionId", type: String, format: "uuid" })
  @ApiQuery({ name: "printConfigRevisionId", type: String, format: "uuid" })
  @ApiQuery({ name: "referenceProfileId", type: String, format: "uuid" })
  @ApiQuery({ name: "quantity", type: "integer", minimum: 1, maximum: 1_000 })
  @ApiQuery({
    name: "partsPerPlate",
    type: "integer",
    minimum: 1,
    maximum: 1_000,
  })
  @ApiOkResponse({ type: QuoteRequestReferencePreparationDto })
  referenceStatus(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Query() query: Record<string, string | undefined>,
  ): Promise<QuoteRequestReferencePreparationDto> {
    return this.models.referenceStatus(operator, requestId, {
      selectionId: query.selectionId!,
      printConfigRevisionId: query.printConfigRevisionId!,
      referenceProfileId: query.referenceProfileId!,
      quantity: Number(query.quantity),
      partsPerPlate: Number(query.partsPerPlate),
    });
  }

  @Post(":requestId/attachments/:photoAssetId/download")
  @HttpCode(200)
  @ApiOperation({ summary: "Create an operator quote-attachment download URL" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiParam({ name: "photoAssetId", type: String, format: "uuid" })
  @ApiOkResponse({ type: SignedDownloadResponseDto })
  @ApiNotFoundResponse({
    description: "The attachment does not belong to this quote request",
  })
  @ApiGoneResponse({ description: "Quote attachment is expired or deleted" })
  downloadAttachment(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Param("photoAssetId") photoAssetId: string,
  ): Promise<SignedDownloadResponseDto> {
    return this.uploads.createOperatorQuotePhotoDownload(
      operator,
      requestId,
      photoAssetId,
    );
  }

  @Post(":requestId/review")
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Move a new request into operator review" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: QuoteRequestStatusDto })
  review(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestStatusDto> {
    return this.quotes.beginReview(operator, requestId, idempotencyKey);
  }

  @Post(":requestId/offers")
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Issue an immutable tokenized individual offer" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: IssueOfferDto })
  @ApiCreatedResponse({ type: OfferIssuedDto })
  @ApiConflictResponse({ description: "Request is not in review" })
  @ApiServiceUnavailableResponse({
    description: "Binding offer flows await launch approval",
  })
  issue(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Body() body: IssueOfferDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<OfferIssuedDto> {
    return this.quotes.issueOffer(operator, requestId, body, idempotencyKey);
  }

  @Post(":requestId/offers/reissue")
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Reissue the current immutable individual offer" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: ReissueOfferDto })
  @ApiCreatedResponse({ type: OfferIssuedDto })
  reissue(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Body() body: ReissueOfferDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<OfferIssuedDto> {
    return this.quotes.reissueOffer(operator, requestId, body, idempotencyKey);
  }

  @Post(":requestId/expire")
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Expire an overdue individual offer" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: QuoteRequestStatusDto })
  @ApiConflictResponse({ description: "Offer is not overdue" })
  expire(
    @CurrentOperator() operator: OperatorContext,
    @Param("requestId") requestId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestStatusDto> {
    return this.quotes.expireOffer(operator, requestId, idempotencyKey);
  }
}

function operatorQueuePageQuery(
  query: Readonly<Record<string, string | string[] | undefined>>,
): Readonly<{
  status?: string;
  sla?: string;
  cursor?: string;
  limit?: number;
}> {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!OPERATOR_QUEUE_PAGE_FIELDS.has(key) || typeof value !== "string") {
      throw new BadRequestException(`${key} is invalid`);
    }
    values[key] = value;
  }
  if (values.limit === undefined) return values;
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit)) {
    throw new BadRequestException("limit is invalid");
  }
  return { ...values, limit };
}
