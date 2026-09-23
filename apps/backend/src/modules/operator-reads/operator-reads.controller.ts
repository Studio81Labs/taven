import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
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
  CapacityReservationPageDto,
  InventoryPageDto,
  InventoryDetailDto,
  MachineCalibrationPageDto,
  MachineCapabilityPageDto,
  MachinePageDto,
  MachineProfilePageDto,
  MachineProfileDetailDto,
  OperatorJobPageDto,
  OperatorJobDetailDto,
  OperatorJobArtifactDownloadDto,
  OperatorOrderDetailDto,
  OperatorOrderPageDto,
  PriceListPageDto,
  PriceListDetailDto,
  ReferenceProfileActivationNoticePageDto,
  PrintConfigRevisionPageDto,
  PrintConfigRevisionDetailDto,
  ReferenceProfilePageDto,
  ReferenceProfileDetailDto,
  MachineCapabilityReadDto,
} from "./operator-reads.dto";
import { OperatorJobArtifactsService } from "./operator-job-artifacts.service";
import { OperatorReadsService } from "./operator-reads.service";

const PAGE_FIELDS = new Set(["cursor", "limit"]);
const ORDER_FIELDS = new Set([...PAGE_FIELDS, "status"]);
const JOB_FIELDS = new Set([...PAGE_FIELDS, "status", "machineId"]);
const NODE_FIELDS = new Set([...PAGE_FIELDS, "machineId"]);
const CAPACITY_FIELDS = new Set([...NODE_FIELDS, "from", "to", "status"]);

type PageQuery = Readonly<{
  cursor?: string;
  limit?: number;
  status?: string;
  machineId?: string;
  from?: string;
  to?: string;
}>;

@ApiTags("operator reads")
@ApiSecurity("operatorSession")
@ApiHeader(OPERATOR_CSRF_HEADER)
@UseGuards(OperatorAccessGuard)
@RequireOperatorPermissions(OPERATOR_PERMISSIONS.OPERATIONS_READ)
@Controller()
export class OperatorReadsController {
  constructor(
    private readonly reads: OperatorReadsService,
    private readonly jobArtifacts: OperatorJobArtifactsService,
  ) {}

  @Get("admin/orders")
  @ApiOperation({ summary: "List node-scoped orders" })
  @ApiOkResponse({ type: OperatorOrderPageDto })
  @ApiQuery({ name: "status", required: false, type: String })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  orders(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<OperatorOrderPageDto> {
    return this.reads.ordersPage(operator, pageQuery(query, ORDER_FIELDS));
  }

  @Get("admin/orders/:orderId")
  @ApiOperation({
    summary:
      "Read one node-scoped order and its authoritative fulfilment projection",
  })
  @ApiParam({ name: "orderId", type: String, format: "uuid" })
  @ApiOkResponse({ type: OperatorOrderDetailDto })
  order(
    @CurrentOperator() operator: OperatorContext,
    @Param("orderId") orderId: string,
  ): Promise<OperatorOrderDetailDto> {
    return this.reads.orderDetail(operator, orderId);
  }

  @Get("admin/jobs")
  @ApiOperation({ summary: "List node-scoped production jobs" })
  @ApiOkResponse({ type: OperatorJobPageDto })
  @ApiQuery({ name: "status", required: false, type: String })
  @ApiQuery({
    name: "machineId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  jobs(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<OperatorJobPageDto> {
    return this.reads.jobsPage(operator, pageQuery(query, JOB_FIELDS));
  }

  @Get("admin/jobs/:jobId")
  @ApiOperation({ summary: "Read one node-scoped production job" })
  @ApiParam({ name: "jobId", type: String, format: "uuid" })
  @ApiOkResponse({ type: OperatorJobDetailDto })
  job(
    @CurrentOperator() operator: OperatorContext,
    @Param("jobId") jobId: string,
  ): Promise<OperatorJobDetailDto> {
    return this.jobArtifacts.detail(operator, jobId);
  }

  @Post("admin/jobs/:jobId/artifacts/:kind/download")
  @HttpCode(200)
  @ApiOperation({ summary: "Issue a scoped, audited job artifact download" })
  @ApiParam({ name: "jobId", type: String, format: "uuid" })
  @ApiParam({
    name: "kind",
    type: String,
    enum: ["SOURCE_MODEL", "PREVIEW", "PRODUCTION"],
  })
  @ApiOkResponse({ type: OperatorJobArtifactDownloadDto })
  jobArtifactDownload(
    @CurrentOperator() operator: OperatorContext,
    @Param("jobId") jobId: string,
    @Param("kind") kind: string,
  ): Promise<OperatorJobArtifactDownloadDto> {
    return this.jobArtifacts.download(operator, jobId, kind);
  }

  @Get("admin/catalog/reference-profiles")
  @ApiOperation({ summary: "List immutable reference-profile revisions" })
  @ApiOkResponse({ type: ReferenceProfilePageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  referenceProfiles(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ReferenceProfilePageDto> {
    return this.reads.referenceProfiles(
      operator,
      pageQuery(query, PAGE_FIELDS),
    );
  }

  @Get("admin/catalog/reference-profiles/:id")
  @ApiOperation({ summary: "Read an immutable reference-profile revision" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: ReferenceProfileDetailDto })
  referenceProfileDetail(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
  ): Promise<ReferenceProfileDetailDto> {
    return this.reads.referenceProfileDetail(operator, id);
  }

  @Get("admin/catalog/reference-profile-activation-notices")
  @ApiOperation({
    summary: "List durable notices for committed reference-profile activations",
  })
  @ApiOkResponse({ type: ReferenceProfileActivationNoticePageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  referenceProfileActivationNotices(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<ReferenceProfileActivationNoticePageDto> {
    return this.reads.referenceProfileActivationNotices(
      operator,
      pageQuery(query, PAGE_FIELDS),
    );
  }

  @Get("admin/catalog/machine-profiles")
  @ApiOperation({ summary: "List immutable machine-profile revisions" })
  @ApiOkResponse({ type: MachineProfilePageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  machineProfiles(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<MachineProfilePageDto> {
    return this.reads.machineProfiles(operator, pageQuery(query, PAGE_FIELDS));
  }

  @Get("admin/catalog/machine-profiles/:id")
  @ApiOperation({ summary: "Read an immutable machine-profile revision" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: MachineProfileDetailDto })
  machineProfileDetail(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
  ): Promise<MachineProfileDetailDto> {
    return this.reads.machineProfileDetail(operator, id);
  }

  @Get("admin/catalog/print-config-revisions")
  @ApiOperation({ summary: "List immutable print-config revisions" })
  @ApiOkResponse({ type: PrintConfigRevisionPageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  printConfigRevisions(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<PrintConfigRevisionPageDto> {
    return this.reads.printConfigRevisions(
      operator,
      pageQuery(query, PAGE_FIELDS),
    );
  }

  @Get("admin/catalog/print-config-revisions/:id")
  @ApiOperation({ summary: "Read an immutable print-config revision" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PrintConfigRevisionDetailDto })
  printConfigRevisionDetail(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
  ): Promise<PrintConfigRevisionDetailDto> {
    return this.reads.printConfigRevisionDetail(operator, id);
  }

  @Get("admin/catalog/price-lists")
  @ApiOperation({ summary: "List global immutable price lists" })
  @ApiOkResponse({ type: PriceListPageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  priceLists(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<PriceListPageDto> {
    return this.reads.priceLists(operator, pageQuery(query, PAGE_FIELDS));
  }

  @Get("admin/catalog/price-lists/:id")
  @ApiOperation({ summary: "Read immutable price-list parameters" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: PriceListDetailDto })
  priceListDetail(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
  ): Promise<PriceListDetailDto> {
    return this.reads.priceListDetail(operator, id);
  }

  @Get("admin/catalog/machine-capabilities")
  @ApiOperation({ summary: "List global machine capabilities" })
  @ApiOkResponse({ type: MachineCapabilityPageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  machineCapabilities(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<MachineCapabilityPageDto> {
    return this.reads.machineCapabilities(
      operator,
      pageQuery(query, PAGE_FIELDS),
    );
  }

  @Get("admin/catalog/machine-capabilities/:id")
  @ApiOperation({ summary: "Read an immutable machine capability" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: MachineCapabilityReadDto })
  machineCapabilityDetail(
    @CurrentOperator() operator: OperatorContext,
    @Param("id") id: string,
  ): Promise<MachineCapabilityReadDto> {
    return this.reads.machineCapabilityDetail(operator, id);
  }

  @Get("admin/nodes/:nodeId/machines")
  @ApiOperation({ summary: "List machines in the granted node" })
  @ApiParam({ name: "nodeId", type: String, format: "uuid" })
  @ApiOkResponse({ type: MachinePageDto })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  machines(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<MachinePageDto> {
    return this.reads.machines(operator, nodeId, pageQuery(query, PAGE_FIELDS));
  }

  @Get("admin/nodes/:nodeId/inventories")
  @ApiOperation({ summary: "List inventory in the granted node" })
  @ApiParam({ name: "nodeId", type: String, format: "uuid" })
  @ApiOkResponse({ type: InventoryPageDto })
  @ApiQuery({
    name: "machineId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  inventories(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<InventoryPageDto> {
    return this.reads.inventories(
      operator,
      nodeId,
      pageQuery(query, NODE_FIELDS),
    );
  }

  @Get("admin/nodes/:nodeId/inventories/:id")
  @ApiOperation({ summary: "Read scoped inventory and its purchase rate" })
  @ApiParam({ name: "nodeId", type: String, format: "uuid" })
  @ApiParam({ name: "id", type: String, format: "uuid" })
  @ApiOkResponse({ type: InventoryDetailDto })
  inventoryDetail(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Param("id") id: string,
  ): Promise<InventoryDetailDto> {
    return this.reads.inventoryDetail(operator, nodeId, id);
  }

  @Get("admin/nodes/:nodeId/calibrations")
  @ApiOperation({ summary: "List calibration revisions in the granted node" })
  @ApiParam({ name: "nodeId", type: String, format: "uuid" })
  @ApiOkResponse({ type: MachineCalibrationPageDto })
  @ApiQuery({
    name: "machineId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  calibrations(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<MachineCalibrationPageDto> {
    return this.reads.calibrations(
      operator,
      nodeId,
      pageQuery(query, NODE_FIELDS),
    );
  }

  @Get("admin/nodes/:nodeId/capacity-reservations")
  @ApiOperation({
    summary: "List bounded capacity intervals in the granted node",
  })
  @ApiParam({ name: "nodeId", type: String, format: "uuid" })
  @ApiOkResponse({ type: CapacityReservationPageDto })
  @ApiQuery({ name: "from", required: true, type: String, format: "date-time" })
  @ApiQuery({ name: "to", required: true, type: String, format: "date-time" })
  @ApiQuery({ name: "status", required: false, type: String })
  @ApiQuery({
    name: "machineId",
    required: false,
    type: String,
    format: "uuid",
  })
  @ApiQuery({ name: "cursor", required: false, type: String, minLength: 1 })
  @ApiQuery({
    name: "limit",
    required: false,
    type: "integer",
    minimum: 1,
    maximum: 100,
  })
  capacityReservations(
    @CurrentOperator() operator: OperatorContext,
    @Param("nodeId") nodeId: string,
    @Query() query: Record<string, string | string[] | undefined>,
  ): Promise<CapacityReservationPageDto> {
    const values = pageQuery(query, CAPACITY_FIELDS);
    if (!values.from || !values.to)
      throw new BadRequestException("from and to are required");
    return this.reads.capacityReservations(
      operator,
      nodeId,
      values as {
        from: string;
        to: string;
        cursor?: string;
        limit?: number;
        machineId?: string;
        status?: string;
      },
    );
  }
}

function pageQuery(
  query: Readonly<Record<string, string | string[] | undefined>>,
  allowed: ReadonlySet<string>,
): PageQuery {
  const values: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!allowed.has(key) || typeof value !== "string") {
      throw new BadRequestException(`${key} is invalid`);
    }
    values[key] = value;
  }
  if (values.limit === undefined) return values as PageQuery;
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit))
    throw new BadRequestException("limit is invalid");
  return { ...values, limit } as PageQuery;
}
