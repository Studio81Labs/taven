import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
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
  LegalPublicationSummaryDto,
  LegalRevisionDetailDto,
  PublishLegalRevisionDto,
  UpdateLegalDraftDto,
} from "./legal-documents.dto";
import { LegalDocumentsService } from "./legal-documents.service";

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
  async list(): Promise<LegalDocumentSummaryDto[]> {
    return await this.legalDocs.listDocuments();
  }

  @Get(":key")
  @ApiOperation({ summary: "Get legal document details and revisions" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_READ)
  @ApiOkResponse({ type: LegalDocumentDetailDto })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async detail(
    @Param("key") key: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<LegalDocumentDetailDto> {
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 25;
    return await this.legalDocs.getDocumentByKey(key, cursor, parsedLimit);
  }

  @Get(":key/audit-events")
  @ApiOperation({ summary: "Read audit events for a legal document" })
  @RequireOperatorPermissions(
    OPERATOR_PERMISSIONS.LEGAL_READ,
    OPERATOR_PERMISSIONS.AUDIT_READ,
  )
  @ApiOkResponse({ type: AuditEventPageDto })
  @ApiQuery({ name: "cursor", required: false, type: String })
  @ApiQuery({ name: "limit", required: false, type: Number })
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async auditEvents(
    @Param("key") key: string,
    @CurrentOperator() operator: OperatorContext,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<AuditEventPageDto> {
    const doc = await this.legalDocs.getDocumentByKey(key, undefined, 1);
    const parsedLimit = limit ? Number.parseInt(limit, 10) : 25;
    return await this.audit.listLegalDocumentAuditEvents(
      operator,
      doc.id,
      cursor,
      parsedLimit,
    );
  }

  @Post(":key/revisions")
  @HttpCode(200)
  @ApiOperation({ summary: "Create a new draft revision for a legal document" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiBody({ type: CreateLegalDraftDto })
  @ApiOkResponse({ type: LegalRevisionDetailDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async createDraft(
    @Param("key") key: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CreateLegalDraftDto,
  ): Promise<LegalRevisionDetailDto> {
    return await this.legalDocs.createDraft(operator, key, body);
  }

  @Put(":key/revisions/:revisionId")
  @ApiOperation({ summary: "Update an existing draft revision" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiBody({ type: UpdateLegalDraftDto })
  @ApiOkResponse({ type: LegalRevisionDetailDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async updateDraft(
    @Param("key") key: string,
    @Param("revisionId") revisionId: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: UpdateLegalDraftDto,
  ): Promise<LegalRevisionDetailDto> {
    return await this.legalDocs.updateDraft(operator, key, revisionId, body);
  }

  @Post(":key/revisions/:revisionId/approve")
  @HttpCode(200)
  @ApiOperation({ summary: "Approve a draft revision" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiBody({ type: ApproveLegalRevisionDto })
  @ApiOkResponse({ type: LegalRevisionDetailDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async approveRevision(
    @Param("key") key: string,
    @Param("revisionId") revisionId: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: ApproveLegalRevisionDto,
  ): Promise<LegalRevisionDetailDto> {
    return await this.legalDocs.approveRevision(
      operator,
      key,
      revisionId,
      body,
    );
  }

  @Post(":key/revisions/:revisionId/publish")
  @HttpCode(200)
  @ApiOperation({ summary: "Publish an approved legal revision" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiBody({ type: PublishLegalRevisionDto })
  @ApiOkResponse({ type: LegalPublicationSummaryDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async publishRevision(
    @Param("key") key: string,
    @Param("revisionId") revisionId: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: PublishLegalRevisionDto,
  ): Promise<LegalPublicationSummaryDto> {
    return await this.legalDocs.publishRevision(
      operator,
      key,
      revisionId,
      body,
    );
  }

  @Post(":key/publications/:publicationId/cancel")
  @HttpCode(200)
  @ApiOperation({ summary: "Cancel a pending scheduled publication" })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiBody({ type: CancelLegalPublicationDto })
  @ApiOkResponse({ type: LegalPublicationSummaryDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async cancelPublication(
    @Param("key") key: string,
    @Param("publicationId") publicationId: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CancelLegalPublicationDto,
  ): Promise<LegalPublicationSummaryDto> {
    return await this.legalDocs.cancelPublication(
      operator,
      key,
      publicationId,
      body,
    );
  }

  @Post(":key/publications/:publicationId/archive")
  @HttpCode(200)
  @ApiOperation({
    summary: "Archive an active publication without replacement",
  })
  @RequireOperatorPermissions(OPERATOR_PERMISSIONS.LEGAL_WRITE)
  @ApiHeader(OPERATOR_CSRF_HEADER)
  @ApiBody({ type: ArchiveLegalPublicationDto })
  @ApiOkResponse({ type: LegalPublicationSummaryDto })
  @ApiBadRequestResponse()
  @ApiConflictResponse()
  @ApiNotFoundResponse()
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse()
  async archivePublication(
    @Param("key") key: string,
    @Param("publicationId") publicationId: string,
    @CurrentOperator() operator: OperatorContext,
    @Body() body: ArchiveLegalPublicationDto,
  ): Promise<LegalPublicationSummaryDto> {
    return await this.legalDocs.archivePublication(
      operator,
      key,
      publicationId,
      body,
    );
  }
}
