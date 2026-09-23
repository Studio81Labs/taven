import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { CurrentOperator } from "../admin-access/current-operator.decorator";
import { OperatorAccessGuard } from "../admin-access/operator-access.guard";
import { OPERATOR_CSRF_HEADER } from "../admin-access/operator-auth.openapi";
import type { OperatorContext } from "../admin-access/operator-context";
import { OPERATOR_PERMISSIONS } from "../admin-access/operator-permissions";
import { RequireOperatorPermissions } from "../admin-access/require-operator-permissions.decorator";
import {
  CatalogCommandResultDto,
  CatalogReasonDto,
  CreateInventoryDto,
  CreateMachineCapabilityDto,
  CreateMachineCalibrationDto,
  CreateMachineProfileDto,
  CreatePrintConfigRevisionDto,
  CreatePriceListDto,
  CreateReferenceProfileDto,
  InventoryStatusDto,
  InventoryAdjustmentDto,
  MachineStatusDto,
  RegisterMachineDto,
  ReferenceProfileActivationResultDto,
} from "./operator-catalog.dto";
import { OperatorCatalogService } from "./operator-catalog.service";

const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  required: true,
  schema: {
    type: "string",
    minLength: 8,
    pattern: "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$",
  },
};
const NODE_ID = { name: "nodeId", type: String, format: "uuid" };
const RESOURCE_ID = { name: "id", type: String, format: "uuid" };
const MACHINE_ID = { name: "machineId", type: String, format: "uuid" };
const INVENTORY_ID = { name: "inventoryId", type: String, format: "uuid" };
const CALIBRATION_ID = { name: "calibrationId", type: String, format: "uuid" };

@ApiTags("operator catalog")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.CATALOG_WRITE)
@Controller()
export class OperatorCatalogController {
  constructor(private readonly catalog: OperatorCatalogService) {}

  @Post("admin/catalog/machine-capabilities")
  @HttpCode(200)
  @ApiOperation({ summary: "Create an immutable machine capability" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateMachineCapabilityDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  createMachineCapability(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CreateMachineCapabilityDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.createMachineCapability(operator, body, key);
  }

  @Post("admin/catalog/print-config-revisions")
  @HttpCode(200)
  @ApiOperation({ summary: "Create an immutable print-config revision" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreatePrintConfigRevisionDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  createPrintConfigRevision(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CreatePrintConfigRevisionDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.createPrintConfigRevision(operator, body, key);
  }

  @Post("admin/catalog/price-lists")
  @HttpCode(200)
  @ApiOperation({
    summary: "Create an immutable, inactive price-list revision",
  })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreatePriceListDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  createPriceList(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CreatePriceListDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.createPriceList(operator, body, key);
  }

  @Post("admin/nodes/:nodeId/machines")
  @HttpCode(200)
  @ApiOperation({
    summary: "Register a node machine with an immutable capability",
  })
  @ApiParam(NODE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: RegisterMachineDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  registerMachine(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Body() body: RegisterMachineDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.registerMachine(operator, nodeId, body, key);
  }

  @Post("admin/catalog/reference-profiles")
  @HttpCode(200)
  @ApiOperation({ summary: "Create an immutable reference-profile revision" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateReferenceProfileDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  createReferenceProfile(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CreateReferenceProfileDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.createReferenceProfile(operator, body, key);
  }

  @Post("admin/catalog/machine-profiles")
  @HttpCode(200)
  @ApiOperation({ summary: "Create an immutable machine-profile revision" })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateMachineProfileDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  createMachineProfile(
    @CurrentOperator() operator: OperatorContext,
    @Body() body: CreateMachineProfileDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.createMachineProfile(operator, body, key);
  }

  @Post("admin/catalog/reference-profiles/:id/activate")
  @HttpCode(200)
  @ApiOperation({ summary: "Activate a reference-profile revision" })
  @ApiParam(RESOURCE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CatalogReasonDto })
  @ApiOkResponse({ type: ReferenceProfileActivationResultDto })
  @ApiConflictResponse({
    description:
      "Revision lifecycle, idempotency, or snapshot integrity conflicts",
  })
  @ApiServiceUnavailableResponse({
    description: "Snapshot verification storage is temporarily unavailable",
  })
  activateReferenceProfile(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
    @Body() body: CatalogReasonDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.activateReferenceProfile(operator, id, body, key);
  }

  @Post("admin/catalog/reference-profiles/:id/retire")
  @HttpCode(200)
  @ApiOperation({ summary: "Retire a reference-profile revision" })
  @ApiParam(RESOURCE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CatalogReasonDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  retireReferenceProfile(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
    @Body() body: CatalogReasonDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.retireReferenceProfile(operator, id, body, key);
  }

  @Post("admin/catalog/machine-profiles/:id/activate")
  @HttpCode(200)
  @ApiOperation({ summary: "Activate a machine-profile revision" })
  @ApiParam(RESOURCE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CatalogReasonDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  @ApiConflictResponse({
    description:
      "Revision lifecycle, idempotency, or snapshot integrity conflicts",
  })
  @ApiServiceUnavailableResponse({
    description: "Snapshot verification storage is temporarily unavailable",
  })
  activateMachineProfile(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
    @Body() body: CatalogReasonDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.activateMachineProfile(operator, id, body, key);
  }

  @Post("admin/catalog/machine-profiles/:id/retire")
  @HttpCode(200)
  @ApiOperation({ summary: "Retire a machine-profile revision" })
  @ApiParam(RESOURCE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CatalogReasonDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  retireMachineProfile(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
    @Body() body: CatalogReasonDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.retireMachineProfile(operator, id, body, key);
  }

  @Post("admin/nodes/:nodeId/calibrations")
  @HttpCode(200)
  @ApiOperation({ summary: "Create an immutable node machine calibration" })
  @ApiParam(NODE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateMachineCalibrationDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  createMachineCalibration(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Body() body: CreateMachineCalibrationDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.createMachineCalibration(operator, nodeId, body, key);
  }

  @Post("admin/nodes/:nodeId/calibrations/:calibrationId/activate")
  @HttpCode(200)
  @ApiOperation({ summary: "Activate a node machine calibration" })
  @ApiParam(NODE_ID)
  @ApiParam(CALIBRATION_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CatalogReasonDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  @ApiConflictResponse({
    description:
      "Revision lifecycle, idempotency, or snapshot integrity conflicts",
  })
  @ApiServiceUnavailableResponse({
    description: "Snapshot verification storage is temporarily unavailable",
  })
  activateMachineCalibration(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Param("calibrationId") calibrationId: string,
    @Body() body: CatalogReasonDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.activateMachineCalibration(
      operator,
      nodeId,
      calibrationId,
      body,
      key,
    );
  }

  @Post("admin/nodes/:nodeId/calibrations/:calibrationId/retire")
  @HttpCode(200)
  @ApiOperation({ summary: "Retire a node machine calibration" })
  @ApiParam(NODE_ID)
  @ApiParam(CALIBRATION_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CatalogReasonDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  retireMachineCalibration(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Param("calibrationId") calibrationId: string,
    @Body() body: CatalogReasonDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.retireMachineCalibration(
      operator,
      nodeId,
      calibrationId,
      body,
      key,
    );
  }

  @Post("admin/nodes/:nodeId/inventories")
  @HttpCode(200)
  @ApiOperation({ summary: "Register material inventory for a node machine" })
  @ApiParam(NODE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: CreateInventoryDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  createInventory(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Body() body: CreateInventoryDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.createInventory(operator, nodeId, body, key);
  }

  @Post("admin/nodes/:nodeId/machines/:machineId/status")
  @HttpCode(200)
  @ApiOperation({ summary: "Record a machine status correction" })
  @ApiParam(NODE_ID)
  @ApiParam(MACHINE_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: MachineStatusDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  updateMachineStatus(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Param("machineId") machineId: string,
    @Body() body: MachineStatusDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.updateMachineStatus(
      operator,
      nodeId,
      machineId,
      body,
      key,
    );
  }

  @Post("admin/nodes/:nodeId/inventories/:inventoryId/status")
  @HttpCode(200)
  @ApiOperation({ summary: "Record an inventory status correction" })
  @ApiParam(NODE_ID)
  @ApiParam(INVENTORY_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: InventoryStatusDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  updateInventoryStatus(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Param("inventoryId") inventoryId: string,
    @Body() body: InventoryStatusDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.updateInventoryStatus(
      operator,
      nodeId,
      inventoryId,
      body,
      key,
    );
  }

  @Post("admin/nodes/:nodeId/inventories/:inventoryId/adjustments")
  @HttpCode(200)
  @ApiOperation({ summary: "Record an audited inventory adjustment" })
  @ApiParam(NODE_ID)
  @ApiParam(INVENTORY_ID)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiBody({ type: InventoryAdjustmentDto })
  @ApiOkResponse({ type: CatalogCommandResultDto })
  adjustInventory(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Param("inventoryId") inventoryId: string,
    @Body() body: InventoryAdjustmentDto,
    @Headers("idempotency-key") key?: string,
  ) {
    return this.catalog.adjustInventory(
      operator,
      nodeId,
      inventoryId,
      body,
      key,
    );
  }
}
