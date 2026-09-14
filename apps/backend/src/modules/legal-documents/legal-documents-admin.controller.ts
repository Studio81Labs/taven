import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { AllowNodeFreeAdmin } from "../admin-access/allow-node-free-admin.decorator";
import { CurrentOperator } from "../admin-access/current-operator.decorator";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import { OPERATOR_CSRF_HEADER } from "../admin-access/operator-auth.openapi";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { RequireOperatorPermissions } from "../admin-access/require-operator-permissions.decorator";
import { AuditEventPageDto } from "../audit/audit.dto";
import { AuditService } from "../audit/audit.service";
import {
  ApproveLegalRevisionDto,
  ArchiveLegalPublicationDto,
  CancelLegalPublicationDto,
  CreateLegalDraftDto,
  LegalDocumentDetailDto,
  LegalDocumentSummaryDto,
  LegalPublicationPageDto,
  LegalPublicationSummaryDto,
  LegalRevisionDetailDto,
  PublishLegalRevisionDto,
  UpdateLegalDraftDto,
} from "./legal-documents.dto";
import { LegalDocumentsService } from "./legal-documents.service";

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

function scalarQueryValue(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new BadRequestException(`${name} is invalid`);
  }
  if (value.includes("\u0000")) {
    throw new BadRequestException(`${name} must not contain NUL characters`);
  }
  return value;
}

function positiveIntegerQueryValue(name: string, value?: string): number {
  if (value === undefined) return 25;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException(`${name} is invalid`);
  }
  return parsed;
}

@ApiTags("legal documents admin")
@ApiSecurity("operatorSession")
@UseGuards(OperatorAccessGuard)
@AllowNodeFreeAdmin()
@Controller("admin/legal-documents")
export class LegalDocumentsAdminController {
  constructor(
    private readonly legalDocs: LegalDocumentsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List all managed legal documents" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_READ)
  @ApiOkResponse({ type: [LegalDocumentSummaryDto] })
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async list(
    @CurrentOperator() operator: OperatorContext,
  ): Promise<LegalDocumentSummaryDto[]> {
    return await this.legalDocs.listDocuments(operator);
  }

  @Get(":key")
  @ApiOperation({ summary: "Get legal document details and revisions" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_READ)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiOkResponse({ type: LegalDocumentDetailDto })
  @ApiQuery({
    name: "cursor",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  @ApiQuery({ name: "publicationCursor", required: false, type: String })
  @ApiQuery({
    name: "publicationLimit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async detail(
    @CurrentOperator() operator: OperatorContext,
    @Param("key") key: string,
    @Query("cursor") cursor?: unknown,
    @Query("limit") limit?: unknown,
    @Query("publicationCursor") publicationCursor?: unknown,
    @Query("publicationLimit") publicationLimit?: unknown,
  ): Promise<LegalDocumentDetailDto> {
    const scalarKey = scalarQueryValue("key", key) ?? key;
    const scalarCursor = scalarQueryValue("cursor", cursor);
    const scalarLimit = scalarQueryValue("limit", limit);
    const scalarPubCursor = scalarQueryValue(
      "publicationCursor",
      publicationCursor,
    );
    const scalarPubLimit = scalarQueryValue(
      "publicationLimit",
      publicationLimit,
    );
    const parsedLimit = positiveIntegerQueryValue("limit", scalarLimit);
    const parsedPubLimit = positiveIntegerQueryValue(
      "publicationLimit",
      scalarPubLimit,
    );
    return await this.legalDocs.getDocumentByKey(
      operator,
      scalarKey,
      scalarCursor,
      parsedLimit,
      scalarPubCursor,
      parsedPubLimit,
    );
  }

  @Get(":key/publications")
  @ApiOperation({ summary: "List publication history for a legal document" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_READ)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiOkResponse({ type: LegalPublicationPageDto })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async publications(
    @Param("key") key: string,
    @CurrentOperator() operator: OperatorContext,
    @Query("cursor") cursor?: unknown,
    @Query("limit") limit?: unknown,
  ): Promise<LegalPublicationPageDto> {
    const scalarKey = scalarQueryValue("key", key) ?? key;
    const scalarCursor = scalarQueryValue("cursor", cursor);
    const scalarLimit = scalarQueryValue("limit", limit);
    const parsedLimit = positiveIntegerQueryValue("limit", scalarLimit);
    return await this.legalDocs.listPublications(
      operator,
      scalarKey,
      scalarCursor,
      parsedLimit,
    );
  }

  @Get(":key/audit-events")
  @ApiOperation({ summary: "Read audit events for a legal document" })
  @RequireOperatorPermissions(
    OPERATOR_PERMISSIONS.LEGAL_READ,
    OPERATOR_PERMISSIONS.AUDIT_READ,
  )
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiOkResponse({ type: AuditEventPageDto })
  @ApiQuery({ name: "eventType", required: false, type: String })
  @ApiQuery({
    name: "operatorIdentityId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async auditEvents(
    @Param("key") key: string,
    @CurrentOperator() operator: OperatorContext,
    @Query("eventType") eventType?: unknown,
    @Query("operatorIdentityId") operatorIdentityId?: unknown,
    @Query("cursor") cursor?: unknown,
    @Query("limit") limit?: unknown,
  ): Promise<AuditEventPageDto> {
    const scalarKey = scalarQueryValue("key", key) ?? key;
    const scalarEventType = scalarQueryValue("eventType", eventType);
    const scalarOperatorId = scalarQueryValue(
      "operatorIdentityId",
      operatorIdentityId,
    );
    const scalarCursor = scalarQueryValue("cursor", cursor);
    const scalarLimit = scalarQueryValue("limit", limit);
    const parsedLimit = positiveIntegerQueryValue("limit", scalarLimit);

    const doc = await this.legalDocs.getDocumentByKey(
      operator,
      scalarKey,
      undefined,
      1,
      undefined,
      1,
    );
    return await this.audit.listLegalDocumentAuditEvents(
      operator,
      doc.id,
      {
        ...(scalarEventType ? { eventType: scalarEventType } : {}),
        ...(scalarOperatorId ? { operatorIdentityId: scalarOperatorId } : {}),
      },
      scalarCursor,
      parsedLimit,
    );
  }

  @Post(":key/revisions")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a new draft revision for a legal document" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiBody({ type: CreateLegalDraftDto })
  @ApiOkResponse({ type: LegalRevisionDetailDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async createDraft(
    @Param("key") key: string,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CreateLegalDraftDto,
  ): Promise<LegalRevisionDetailDto> {
    return await this.legalDocs.createDraft(
      operator,
      key,
      body,
      idempotencyKey,
    );
  }

  @Put(":key/revisions/:revisionId")
  @ApiOperation({ summary: "Update an existing draft revision" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiParam({
    name: "revisionId",
    type: String,
    format: "uuid",
    description: "Draft revision UUID",
  })
  @ApiBody({ type: UpdateLegalDraftDto })
  @ApiOkResponse({ type: LegalRevisionDetailDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async updateDraft(
    @Param("key") key: string,
    @Param(
      "revisionId",
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    revisionId: string,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: UpdateLegalDraftDto,
  ): Promise<LegalRevisionDetailDto> {
    return await this.legalDocs.updateDraft(
      operator,
      key,
      revisionId,
      body,
      idempotencyKey,
    );
  }

  @Post(":key/revisions/:revisionId/approve")
  @HttpCode(200)
  @ApiOperation({ summary: "Approve a draft revision" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiParam({
    name: "revisionId",
    type: String,
    format: "uuid",
    description: "Draft revision UUID",
  })
  @ApiBody({ type: ApproveLegalRevisionDto })
  @ApiOkResponse({ type: LegalRevisionDetailDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async approveRevision(
    @Param("key") key: string,
    @Param(
      "revisionId",
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    revisionId: string,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: ApproveLegalRevisionDto,
  ): Promise<LegalRevisionDetailDto> {
    return await this.legalDocs.approveRevision(
      operator,
      key,
      revisionId,
      body,
      idempotencyKey,
    );
  }

  @Post(":key/revisions/:revisionId/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish an approved legal revision" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiParam({
    name: "revisionId",
    type: String,
    format: "uuid",
    description: "Approved revision UUID",
  })
  @ApiBody({ type: PublishLegalRevisionDto })
  @ApiOkResponse({ type: LegalPublicationSummaryDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async publishRevision(
    @Param("key") key: string,
    @Param(
      "revisionId",
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    revisionId: string,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: PublishLegalRevisionDto,
  ): Promise<LegalPublicationSummaryDto> {
    return await this.legalDocs.publishRevision(
      operator,
      key,
      revisionId,
      body,
      idempotencyKey,
    );
  }

  @Post(":key/publications/:publicationId/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel a pending scheduled publication" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiParam({
    name: "publicationId",
    type: String,
    format: "uuid",
    description: "Publication UUID",
  })
  @ApiBody({ type: CancelLegalPublicationDto })
  @ApiOkResponse({ type: LegalPublicationSummaryDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async cancelPublication(
    @Param("key") key: string,
    @Param(
      "publicationId",
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    publicationId: string,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CancelLegalPublicationDto,
  ): Promise<LegalPublicationSummaryDto> {
    return await this.legalDocs.cancelPublication(
      operator,
      key,
      publicationId,
      body,
      idempotencyKey,
    );
  }

  @Post(":key/publications/:publicationId/archive")
  @HttpCode(200)
  @ApiOperation({
    summary: "Archive an active publication without replacement",
  })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiParam({
    name: "key",
    type: String,
    description: "Legal document identifier key",
  })
  @ApiParam({
    name: "publicationId",
    type: String,
    format: "uuid",
    description: "Publication UUID",
  })
  @ApiBody({ type: ArchiveLegalPublicationDto })
  @ApiOkResponse({ type: LegalPublicationSummaryDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async archivePublication(
    @Param("key") key: string,
    @Param(
      "publicationId",
      new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.BAD_REQUEST }),
    )
    publicationId: string,
    @Headers("idempotency-key") idempotencyKey: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: ArchiveLegalPublicationDto,
  ): Promise<LegalPublicationSummaryDto> {
    return await this.legalDocs.archivePublication(
      operator,
      key,
      publicationId,
      body,
      idempotencyKey,
    );
  }
}
