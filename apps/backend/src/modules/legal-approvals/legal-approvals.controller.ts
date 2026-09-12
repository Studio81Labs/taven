import { Controller, Get, Header } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
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
  availability(): Promise<LegalDocumentAvailabilityDto> {
    return this.approvals.availability();
  }
}
