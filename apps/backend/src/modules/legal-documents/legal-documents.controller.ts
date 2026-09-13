import { Controller, Get, Header, Param, Res } from "@nestjs/common";
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
type ResponseLike = {
  setHeader(name: string, value: string): void;
};
import { PublicLegalRevisionDto } from "./legal-documents.dto";
import { LegalDocumentsService } from "./legal-documents.service";

@ApiTags("legal documents")
@Controller("legal-documents")
export class LegalDocumentsController {
  constructor(private readonly legalDocs: LegalDocumentsService) {}

  @Get(":key/revisions/:revisionCode")
  @ApiOperation({
    summary:
      "Public exact-version reader for published legal document revisions",
  })
  @Header("Cache-Control", "public, max-age=3600, immutable")
  @ApiOkResponse({ type: PublicLegalRevisionDto })
  @ApiNotFoundResponse()
  async getRevision(
    @Param("key") key: string,
    @Param("revisionCode") revisionCode: string,
    @Res({ passthrough: true }) response: ResponseLike,
  ): Promise<PublicLegalRevisionDto> {
    const revision = await this.legalDocs.getPublicRevision(key, revisionCode);
    response.setHeader("ETag", `"${revision.contentHash}"`);
    return revision;
  }
}
