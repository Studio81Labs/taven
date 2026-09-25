import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentOperator } from "../admin-access/current-operator.decorator";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import { OPERATOR_CSRF_HEADER } from "../admin-access/operator-auth.openapi";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { RequireOperatorPermissions } from "../admin-access/require-operator-permissions.decorator";
import {
  PrepareClaimReprintDto,
  PrepareJobReplacementDto,
  RecoveryCandidatePreparationAcceptedDto,
  RecoveryCandidatePreparationPageDto,
  RecoveryCandidatePreparationDetailDto,
  RecoveryCandidateChoicePageDto,
} from "./recovery-candidate.dto";
import { RecoveryCandidatePreparationService } from "./recovery-candidate-preparation.service";

const UUID = { name: "orderId", type: String, format: "uuid" };
const KEY = {
  name: "Idempotency-Key",
  required: true,
  description: "Stable command key; replaying altered input returns 409",
  schema: {
    type: "string",
    minLength: 8,
    pattern: "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$",
  },
};

@ApiTags("operator recovery candidates")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
@Controller("admin/orders/:orderId/fulfilment")
export class RecoveryCandidateController {
  constructor(private readonly recovery: RecoveryCandidatePreparationService) {}

  @Post("jobs/:jobId/replacement-preparations")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_WRITE)
  @HttpCode(202)
  @ApiOperation({
    summary: "Prepare fresh candidates for one failed Job replacement",
  })
  @ApiParam(UUID)
  @ApiParam({ name: "jobId", type: String, format: "uuid" })
  @ApiHeader(KEY)
  @ApiBody({ type: PrepareJobReplacementDto })
  @ApiAcceptedResponse({ type: RecoveryCandidatePreparationAcceptedDto })
  prepareReplacement(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Body() body: PrepareJobReplacementDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<RecoveryCandidatePreparationAcceptedDto> {
    return this.recovery.prepareReplacement(
      operator,
      orderId,
      jobId,
      body,
      key,
    );
  }

  @Post("claims/:claimId/reprint-preparations")
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.FINANCIAL_EXCEPTION)
  @HttpCode(202)
  @ApiOperation({
    summary: "Prepare fresh candidates for a whole LOST parcel reprint",
  })
  @ApiParam(UUID)
  @ApiParam({ name: "claimId", type: String, format: "uuid" })
  @ApiHeader(KEY)
  @ApiBody({ type: PrepareClaimReprintDto })
  @ApiAcceptedResponse({ type: RecoveryCandidatePreparationAcceptedDto })
  prepareReprint(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Body() body: PrepareClaimReprintDto,
    @Headers("idempotency-key") key?: string,
  ): Promise<RecoveryCandidatePreparationAcceptedDto> {
    return this.recovery.prepareReprint(operator, orderId, claimId, body, key);
  }

  @Get("jobs/:jobId/replacement-preparations")
  @ApiOperation({ summary: "List bounded failed-Job preparation history" })
  @ApiParam(UUID)
  @ApiParam({ name: "jobId", type: String, format: "uuid" })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({ type: RecoveryCandidatePreparationPageDto })
  jobPreparations(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<RecoveryCandidatePreparationPageDto> {
    return this.recovery.list(
      operator,
      orderId,
      "JOB_REPLACEMENT",
      jobId,
      pageQuery(query),
    );
  }

  @Get("jobs/:jobId/replacement-preparations/:preparationId")
  @ApiOperation({ summary: "Read failed-Job preparation progress" })
  @ApiParam(UUID)
  @ApiParam({ name: "jobId", type: String, format: "uuid" })
  @ApiParam({ name: "preparationId", type: String, format: "uuid" })
  @ApiOkResponse({ type: RecoveryCandidatePreparationDetailDto })
  jobPreparation(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Param("preparationId") preparationId: string,
  ): Promise<RecoveryCandidatePreparationDetailDto> {
    return this.recovery.detail(
      operator,
      orderId,
      "JOB_REPLACEMENT",
      jobId,
      preparationId,
    );
  }

  @Get("jobs/:jobId/replacement-preparations/:preparationId/candidates")
  @ApiOperation({ summary: "Read typed candidates for one failed Job" })
  @ApiParam(UUID)
  @ApiParam({ name: "jobId", type: String, format: "uuid" })
  @ApiParam({ name: "preparationId", type: String, format: "uuid" })
  @ApiQuery({
    name: "sourceJobId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({ type: RecoveryCandidateChoicePageDto })
  jobCandidates(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("jobId") jobId: string,
    @Param("preparationId") preparationId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<RecoveryCandidateChoicePageDto> {
    return this.recovery.choices(
      operator,
      orderId,
      "JOB_REPLACEMENT",
      jobId,
      preparationId,
      pageQuery(query, true),
    );
  }

  @Get("claims/:claimId/reprint-preparations")
  @ApiOperation({ summary: "List bounded LOST-claim preparation history" })
  @ApiParam(UUID)
  @ApiParam({ name: "claimId", type: String, format: "uuid" })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({ type: RecoveryCandidatePreparationPageDto })
  claimPreparations(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<RecoveryCandidatePreparationPageDto> {
    return this.recovery.list(
      operator,
      orderId,
      "LOST_CLAIM_REPRINT",
      claimId,
      pageQuery(query),
    );
  }

  @Get("claims/:claimId/reprint-preparations/:preparationId")
  @ApiOperation({ summary: "Read LOST-claim preparation progress" })
  @ApiParam(UUID)
  @ApiParam({ name: "claimId", type: String, format: "uuid" })
  @ApiParam({ name: "preparationId", type: String, format: "uuid" })
  @ApiOkResponse({ type: RecoveryCandidatePreparationDetailDto })
  claimPreparation(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Param("preparationId") preparationId: string,
  ): Promise<RecoveryCandidatePreparationDetailDto> {
    return this.recovery.detail(
      operator,
      orderId,
      "LOST_CLAIM_REPRINT",
      claimId,
      preparationId,
    );
  }

  @Get("claims/:claimId/reprint-preparations/:preparationId/candidates")
  @ApiOperation({
    summary: "Read typed candidates for every source Job in a LOST parcel",
  })
  @ApiParam(UUID)
  @ApiParam({ name: "claimId", type: String, format: "uuid" })
  @ApiParam({ name: "preparationId", type: String, format: "uuid" })
  @ApiQuery({
    name: "sourceJobId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiOkResponse({ type: RecoveryCandidateChoicePageDto })
  claimCandidates(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
    @Param("claimId") claimId: string,
    @Param("preparationId") preparationId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<RecoveryCandidateChoicePageDto> {
    return this.recovery.choices(
      operator,
      orderId,
      "LOST_CLAIM_REPRINT",
      claimId,
      preparationId,
      pageQuery(query, true),
    );
  }
}

function pageQuery(
  query: Record<string, string | string[] | undefined>,
  candidate = false,
): { limit?: string; cursor?: string; sourceJobId?: string } {
  const allowed = new Set(
    candidate ? ["cursor", "limit", "sourceJobId"] : ["cursor", "limit"],
  );
  if (
    Object.keys(query).some(
      (key) => !allowed.has(key) || Array.isArray(query[key]),
    )
  )
    throw new BadRequestException("Invalid recovery page query");
  return {
    ...(query.limit ? { limit: query.limit as string } : {}),
    ...(query.cursor ? { cursor: query.cursor as string } : {}),
    ...(query.sourceJobId ? { sourceJobId: query.sourceJobId as string } : {}),
  };
}
