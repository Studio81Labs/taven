import { Controller, Get, Header } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { LEGAL_DOCUMENT_KEYS } from "./legal-approvals.catalog";
import { LegalDocumentAvailabilityDto } from "./legal-approvals.dto";
import { LegalApprovalsService } from "./legal-approvals.service";

@ApiTags("legal documents")
@Controller("legal-documents")
export class LegalApprovalsController {
  constructor(private readonly approvals: LegalApprovalsService) {}

  @Get("availability")
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Read server-evaluated legal-document availability",
  })
  @ApiOkResponse({ type: LegalDocumentAvailabilityDto })
  @ApiServiceUnavailableResponse({
    description: "Legal approvals or trusted database time are unavailable",
  })
  async availability(): Promise<LegalDocumentAvailabilityDto> {
    const evaluated = await this.approvals.availability();
    return {
      schemaVersion: evaluated.schemaVersion,
      policyRevision: evaluated.policyRevision,
      evaluatedAt: evaluated.evaluatedAt,
      documents: Object.fromEntries(
        LEGAL_DOCUMENT_KEYS.map((key) => {
          const { revision, status, effectiveAt, contentHash, effective } =
            evaluated.documents[key];
          return [
            key,
            { revision, status, effectiveAt, contentHash, effective },
          ];
        }),
      ) as unknown as LegalDocumentAvailabilityDto["documents"],
    };
  }
}
