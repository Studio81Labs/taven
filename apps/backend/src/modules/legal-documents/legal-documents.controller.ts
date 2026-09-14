import { Controller, Get, Param, Res } from "@nestjs/common";
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
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
  @ApiParam({
    name: "key",
    description: "Legal document identifier key",
    schema: { type: "string", minLength: 1, maxLength: 50 },
  })
  @ApiParam({
    name: "revisionCode",
    description: "Immutable revision code",
    schema: {
      type: "string",
      maxLength: 100,
      pattern: "^[A-Za-z0-9_.-]{1,100}$",
    },
  })
  @ApiOkResponse({ type: PublicLegalRevisionDto })
  @ApiNotFoundResponse()
  @ApiServiceUnavailableResponse({
    description: "Legal document datastore is unavailable",
  })
  async getRevision(
    @Param("key") key: string,
    @Param("revisionCode") revisionCode: string,
    @Res({ passthrough: true }) response: ResponseLike,
  ): Promise<PublicLegalRevisionDto> {
    response.setHeader("Cache-Control", "no-store");
    const revision = await this.legalDocs.getPublicRevision(key, revisionCode);
    response.setHeader("Cache-Control", "public, max-age=3600, immutable");
    response.setHeader("ETag", `"${revision.contentHash}"`);
    return revision;
  }
}
