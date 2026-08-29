import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import {
  ConfirmedUploadResponseDto,
  InitiateModelUploadDto,
  InitiatePhotoUploadDto,
  ReorderEligibilityResponseDto,
  SignedDownloadResponseDto,
  UploadIntentResponseDto,
} from "./storage.dto";
import { UploadService } from "./upload.service";

@ApiTags("storage")
@Controller("storage")
export class StorageController {
  constructor(@Inject(UploadService) private readonly uploads: UploadService) {}

  @Post("uploads/model-files")
  @ApiOperation({ summary: "Create a direct model-file upload intent" })
  @ApiBody({ type: InitiateModelUploadDto })
  @ApiCreatedResponse({ type: UploadIntentResponseDto })
  initiateModelUpload(
    @Body() body: InitiateModelUploadDto,
  ): Promise<UploadIntentResponseDto> {
    return this.uploads.initiateModelUpload(body);
  }

  @Post("uploads/photos")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Create a direct quote-reference photo upload intent",
  })
  @ApiBody({ type: InitiatePhotoUploadDto })
  @ApiCreatedResponse({ type: UploadIntentResponseDto })
  initiatePhotoUpload(
    @Body() body: InitiatePhotoUploadDto,
    @Headers("authorization") authorization?: string,
  ): Promise<UploadIntentResponseDto> {
    return this.uploads.initiatePhotoUpload(body, authorization);
  }

  @Post("uploads/:uploadId/confirm")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Verify and promote a quarantined upload" })
  @ApiParam({ name: "uploadId", type: String, format: "uuid" })
  @ApiOkResponse({ type: ConfirmedUploadResponseDto })
  @ApiUnauthorizedResponse({ description: "Capability token is invalid" })
  @ApiGoneResponse({ description: "Upload intent or signed URL expired" })
  @ApiConflictResponse({
    description: "Stored bytes do not match the declared upload contract",
  })
  confirmUpload(
    @Param("uploadId") uploadId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<ConfirmedUploadResponseDto> {
    return this.uploads.confirmUpload(uploadId, authorization);
  }

  @Post("model-files/:modelFileId/download")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a short-lived source-file download URL" })
  @ApiParam({ name: "modelFileId", type: String, format: "uuid" })
  @ApiOkResponse({ type: SignedDownloadResponseDto })
  @ApiUnauthorizedResponse({ description: "Capability token is invalid" })
  @ApiGoneResponse({ description: "Model source is expired or deleted" })
  createModelDownload(
    @Param("modelFileId") modelFileId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<SignedDownloadResponseDto> {
    return this.uploads.createModelDownload(modelFileId, authorization);
  }

  @Get("model-files/:modelFileId/reorder-eligibility")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Report whether the retained source can support a fresh reorder",
  })
  @ApiParam({ name: "modelFileId", type: String, format: "uuid" })
  @ApiOkResponse({ type: ReorderEligibilityResponseDto })
  @ApiUnauthorizedResponse({ description: "Capability token is invalid" })
  reorderEligibility(
    @Param("modelFileId") modelFileId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<ReorderEligibilityResponseDto> {
    return this.uploads.getReorderEligibility(modelFileId, authorization);
  }

  @Post("photos/:photoAssetId/download")
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create a short-lived photo download URL" })
  @ApiParam({ name: "photoAssetId", type: String, format: "uuid" })
  @ApiOkResponse({ type: SignedDownloadResponseDto })
  @ApiUnauthorizedResponse({ description: "Capability token is invalid" })
  @ApiGoneResponse({ description: "Photo is expired or deleted" })
  createPhotoDownload(
    @Param("photoAssetId") photoAssetId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<SignedDownloadResponseDto> {
    return this.uploads.createPhotoDownload(photoAssetId, authorization);
  }
}
