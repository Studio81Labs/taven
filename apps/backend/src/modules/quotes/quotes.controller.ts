import {
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
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import { SignedDownloadResponseDto } from "../storage/storage.dto";
import { UploadService } from "../storage/upload.service";
import {
  AcceptOfferDto,
  AcceptedOfferDto,
  CreateQuoteRequestDto,
  IssueOfferDto,
  OfferIssuedDto,
  OfferPreviewDto,
  QuoteRequestCreatedDto,
  QuoteRequestDetailDto,
  QuoteRequestStatusDto,
  RejectOfferDto,
} from "./quotes.dto";
import { QuotesService } from "./quotes.service";

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  description: "Stable command key; replaying altered input returns 409",
};

@ApiTags("quote requests")
@Controller("quote-requests")
export class QuoteRequestsController {
  constructor(private readonly quotes: QuotesService) {}

  @Post()
  @ApiOperation({ summary: "Submit an individual quote request" })
  @ApiBody({ type: CreateQuoteRequestDto })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiCreatedResponse({ type: QuoteRequestCreatedDto })
  @ApiConflictResponse({ description: "Idempotency input changed" })
  @ApiTooManyRequestsResponse({
    description: "Anonymous quote-submission limit is exhausted",
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
@ApiBearerAuth()
@UseGuards(OperatorAccessGuard)
@Controller("admin/quote-requests")
export class OperatorQuoteRequestsController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly uploads: UploadService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the operator quote-request queue" })
  @ApiQuery({
    name: "status",
    required: false,
    enum: ["NEW", "IN_REVIEW", "QUOTED", "ACCEPTED", "REJECTED", "EXPIRED"],
    description:
      "Defaults to actionable NEW, IN_REVIEW, and QUOTED requests; select a terminal status explicitly to read history",
  })
  @ApiOkResponse({ type: QuoteRequestDetailDto, isArray: true })
  list(@Query("status") status?: string): Promise<QuoteRequestDetailDto[]> {
    return this.quotes.listRequests(status);
  }

  @Get(":requestId")
  @ApiOperation({ summary: "Read one operator quote-request detail" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: QuoteRequestDetailDto })
  get(@Param("requestId") requestId: string): Promise<QuoteRequestDetailDto> {
    return this.quotes.getOperatorRequest(requestId);
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
    @Param("requestId") requestId: string,
    @Param("photoAssetId") photoAssetId: string,
  ): Promise<SignedDownloadResponseDto> {
    return this.uploads.createOperatorQuotePhotoDownload(
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
    @Param("requestId") requestId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestStatusDto> {
    return this.quotes.beginReview(requestId, idempotencyKey);
  }

  @Post(":requestId/offers")
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Issue an immutable tokenized individual offer" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiBody({ type: IssueOfferDto })
  @ApiCreatedResponse({ type: OfferIssuedDto })
  @ApiConflictResponse({ description: "Request is not in review" })
  issue(
    @Param("requestId") requestId: string,
    @Body() body: IssueOfferDto,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<OfferIssuedDto> {
    return this.quotes.issueOffer(requestId, body, idempotencyKey);
  }

  @Post(":requestId/expire")
  @HttpCode(200)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOperation({ summary: "Expire an overdue individual offer" })
  @ApiParam({ name: "requestId", type: String, format: "uuid" })
  @ApiOkResponse({ type: QuoteRequestStatusDto })
  @ApiConflictResponse({ description: "Offer is not overdue" })
  expire(
    @Param("requestId") requestId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<QuoteRequestStatusDto> {
    return this.quotes.expireOffer(requestId, idempotencyKey);
  }
}
