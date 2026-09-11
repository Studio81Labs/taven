import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

export const DELIVERY_CAPABILITY = Symbol("DELIVERY_CAPABILITY");

const PACKETA_FEED_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const PACKETA_FEED_REFRESH_MS = 60 * 60 * 1_000;
const PACKETA_FEED_RETRY_DELAY_MS = 60_000;
const PACKETA_REQUEST_TIMEOUT_MS = 5_000;
const PACKETA_RESPONSE_LIMIT_BYTES = 10 * 1_024 * 1_024;

export type ResolvedDeliveryCapability = Readonly<{
  providerEndpointId: string;
  endpointType: string;
  addressSnapshot: Prisma.InputJsonObject;
  capabilitySnapshot: Prisma.InputJsonObject;
  supportedCategoryIds: readonly string[];
}>;

export type DeliveryCapabilityOption = Readonly<{
  providerEndpointId: string;
  endpointType: string;
  label: string;
  supportedCategoryIds: readonly string[];
}>;

export type DeliverySelectorProjection = Readonly<{
  mode: "CONFIGURED" | "PACKETA";
  available: boolean;
  allowedEndpointTypes: readonly string[];
  widget?: Readonly<{
    accountId: string;
    options: Prisma.InputJsonObject;
  }>;
}>;

export type DeliveryValidationParcel = Readonly<{
  weightMilligrams: bigint;
  xMicrometers: bigint;
  yMicrometers: bigint;
  zMicrometers: bigint;
}>;

export type CommittedDeliveryCapability = Readonly<{
  providerEndpointId: string;
  endpointType: string;
  addressSnapshot: Prisma.JsonValue | Prisma.InputJsonValue;
  capabilitySnapshot: Prisma.JsonValue | Prisma.InputJsonValue;
}>;

/**
 * `selectionPolicy` and `configuredOptions` are process-local reads used by
 * snapshots/handoff. Only `validateSelection` may perform provider I/O, and
 * callers invoke it before entering a database transaction.
 */
export interface DeliveryCapabilityPort {
  selectionPolicy(): DeliverySelectorProjection;
  configuredOptions(): readonly DeliveryCapabilityOption[];
  prepareSelection(input: {
    providerEndpointId: string;
    endpointType: string;
  }): Promise<ResolvedDeliveryCapability>;
  validateSelection(input: {
    providerEndpointId: string;
    endpointType: string;
    parcels: readonly DeliveryValidationParcel[];
  }): Promise<ResolvedDeliveryCapability>;
  readCommittedCapability(
    input: CommittedDeliveryCapability,
  ): ResolvedDeliveryCapability;
}

type ConfiguredEndpoint = Readonly<{
  providerEndpointId: string;
  endpointType: string;
  addressSnapshot: Prisma.InputJsonObject;
  supportedCategoryIds: readonly string[];
  provider?: string;
}>;

const DEFAULT_ENDPOINTS: readonly ConfiguredEndpoint[] = [
  {
    providerEndpointId: "local-zbox",
    endpointType: "pickup_point",
    addressSnapshot: {
      country: "CZ",
      city: "Praha",
      label: "Local development Z-BOX",
    },
    supportedCategoryIds: ["zbox"],
    provider: "local-development",
  },
  {
    providerEndpointId: "local-pickup",
    endpointType: "pickup_point",
    addressSnapshot: {
      country: "CZ",
      city: "Praha",
      label: "Local development pickup point",
    },
    supportedCategoryIds: ["pickup", "oversize"],
    provider: "local-development",
  },
];

/** Process-local legacy/test adapter. It never accesses a carrier. */
@Injectable()
export class ConfiguredDeliveryCapabilityAdapter implements DeliveryCapabilityPort {
  private readonly endpoints = configuredEndpoints();

  selectionPolicy(): DeliverySelectorProjection {
    return {
      mode: "CONFIGURED",
      available: this.endpoints.length > 0,
      allowedEndpointTypes: Object.freeze(
        [
          ...new Set(this.endpoints.map((endpoint) => endpoint.endpointType)),
        ].sort(),
      ),
    };
  }

  configuredOptions(): readonly DeliveryCapabilityOption[] {
    return this.endpoints.map((endpoint) => ({
      providerEndpointId: endpoint.providerEndpointId,
      endpointType: endpoint.endpointType,
      label: publicLabel(endpoint),
      supportedCategoryIds: endpoint.supportedCategoryIds,
    }));
  }

  async prepareSelection(input: {
    providerEndpointId: string;
    endpointType: string;
  }): Promise<ResolvedDeliveryCapability> {
    return this.resolveConfigured(input);
  }

  async validateSelection(input: {
    providerEndpointId: string;
    endpointType: string;
    parcels: readonly DeliveryValidationParcel[];
  }): Promise<ResolvedDeliveryCapability> {
    void input.parcels;
    return this.prepareSelection(input);
  }

  readCommittedCapability(
    input: CommittedDeliveryCapability,
  ): ResolvedDeliveryCapability {
    return readCommittedDeliveryCapability(input);
  }

  private resolveConfigured(input: {
    providerEndpointId: string;
    endpointType: string;
  }): ResolvedDeliveryCapability {
    const endpoint = this.endpoints.find(
      (candidate) =>
        candidate.providerEndpointId === input.providerEndpointId &&
        candidate.endpointType === input.endpointType,
    );
    if (!endpoint) {
      throw new BadRequestException(
        "Delivery endpoint is unavailable or incompatible",
      );
    }
    return resolvedConfiguredEndpoint(endpoint);
  }
}

type PacketaConfiguration = Readonly<{
  accountId: string;
  widgetOptions: Prisma.InputJsonObject;
}>;

type PacketaPoint = Readonly<{
  id: string;
  kind: "pickup" | "zbox";
  name: string;
  address: Prisma.InputJsonObject;
  maxWeightMilligrams?: bigint;
}>;

type PacketaFeedSnapshot = Readonly<{
  fetchedAt: number;
  points: ReadonlyMap<string, PacketaPoint>;
}>;

type FetchLike = typeof fetch;

/** Opt-in network adapter. It accepts no carrier service password. */
export class PacketaDeliveryCapabilityAdapter implements DeliveryCapabilityPort {
  private snapshot?: PacketaFeedSnapshot;
  private inFlight: Promise<PacketaFeedSnapshot> | undefined;
  private retryAfter: number | undefined;

  constructor(
    private readonly configuration: PacketaConfiguration,
    private readonly fetchImplementation: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  selectionPolicy(): DeliverySelectorProjection {
    return {
      mode: "PACKETA",
      available: true,
      allowedEndpointTypes: ["pickup_point"],
      widget: {
        accountId: this.configuration.accountId,
        options: this.configuration.widgetOptions,
      },
    };
  }

  configuredOptions(): readonly DeliveryCapabilityOption[] {
    return [];
  }

  async prepareSelection(input: {
    providerEndpointId: string;
    endpointType: string;
  }): Promise<ResolvedDeliveryCapability> {
    return packetaResolved(await this.pointForSelection(input));
  }

  async validateSelection(input: {
    providerEndpointId: string;
    endpointType: string;
    parcels: readonly DeliveryValidationParcel[];
  }): Promise<ResolvedDeliveryCapability> {
    if (input.parcels.length === 0) {
      throw new BadRequestException(
        "Delivery selection has no planned parcels",
      );
    }
    const point = await this.pointForSelection(input);
    for (const parcel of input.parcels)
      await this.validateParcel(point, parcel);
    return packetaResolved(point);
  }

  readCommittedCapability(
    input: CommittedDeliveryCapability,
  ): ResolvedDeliveryCapability {
    return readCommittedDeliveryCapability(input);
  }

  private async validateParcel(
    point: PacketaPoint,
    parcel: DeliveryValidationParcel,
  ): Promise<void> {
    assertParcel(parcel);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PACKETA_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImplementation(
        "https://widget.packeta.com/v6/pps/api/widget/v1/validate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Language": "cs" },
          body: JSON.stringify({
            apiKey: this.configuration.accountId,
            point: { id: point.id },
            options: {
              ...this.configuration.widgetOptions,
              country: "cz",
              carriers: "packeta",
              cashOnDelivery: false,
              vendors: [{ country: "cz" }, { country: "cz", group: "zbox" }],
              weight: Number(parcel.weightMilligrams) / 1_000_000,
              width: micrometersToCentimeters(parcel.xMicrometers),
              length: micrometersToCentimeters(parcel.yMicrometers),
              depth: micrometersToCentimeters(parcel.zMicrometers),
            },
          }),
          signal: controller.signal,
        },
      );
      const body = await boundedJson(response);
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          throw new BadRequestException(
            "Delivery endpoint is unavailable or incompatible",
          );
        }
        throw new ServiceUnavailableException(
          "Delivery provider is unavailable",
        );
      }
      if (!jsonRecord(body)?.isValid) {
        throw new BadRequestException(
          "Delivery endpoint is unavailable or incompatible",
        );
      }
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ServiceUnavailableException
      )
        throw error;
      throw new ServiceUnavailableException("Delivery provider is unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async currentSnapshot(): Promise<PacketaFeedSnapshot> {
    const current = this.snapshot;
    const now = this.now();
    const age = current ? now - current.fetchedAt : Number.POSITIVE_INFINITY;
    if (current && age < PACKETA_FEED_REFRESH_MS) return current;
    if (current && this.retryAfter && now < this.retryAfter) return current;
    if (this.inFlight)
      return this.withStaleFallback(this.inFlight, current, age);
    this.inFlight = this.fetchSnapshot().finally(() => {
      this.inFlight = undefined;
    });
    return this.withStaleFallback(this.inFlight, current, age);
  }

  private async withStaleFallback(
    refresh: Promise<PacketaFeedSnapshot>,
    current: PacketaFeedSnapshot | undefined,
    age: number,
  ): Promise<PacketaFeedSnapshot> {
    try {
      return await refresh;
    } catch (error) {
      if (current && age <= PACKETA_FEED_MAX_AGE_MS) {
        this.retryAfter = this.now() + PACKETA_FEED_RETRY_DELAY_MS;
        return current;
      }
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Delivery provider is unavailable");
    }
  }

  private async fetchSnapshot(): Promise<PacketaFeedSnapshot> {
    const key = encodeURIComponent(this.configuration.accountId);
    const [branches, boxes] = await Promise.all([
      this.fetchFeed(
        `https://pickup-point.api.packeta.com/v5/${key}/branch.json?lang=cs`,
      ),
      this.fetchFeed(
        `https://pickup-point.api.packeta.com/v5/${key}/box.json?lang=cs`,
      ),
    ]);
    const points = new Map<string, PacketaPoint>();
    for (const record of branches)
      insertPoint(points, parsePacketaPoint(record, "pickup"));
    for (const record of boxes)
      insertPoint(points, parsePacketaPoint(record, "zbox"));
    if (points.size === 0)
      throw new ServiceUnavailableException("Delivery provider is unavailable");
    const snapshot = { fetchedAt: this.now(), points };
    this.snapshot = snapshot;
    this.retryAfter = undefined;
    return snapshot;
  }

  private async pointForSelection(input: {
    providerEndpointId: string;
    endpointType: string;
  }): Promise<PacketaPoint> {
    if (
      input.endpointType !== "pickup_point" ||
      !nonBlankText(input.providerEndpointId)
    ) {
      throw new BadRequestException(
        "Delivery endpoint is unavailable or incompatible",
      );
    }
    const point = (await this.currentSnapshot()).points.get(
      input.providerEndpointId,
    );
    if (!point)
      throw new BadRequestException(
        "Delivery endpoint is unavailable or incompatible",
      );
    return point;
  }

  private async fetchFeed(url: string): Promise<readonly unknown[]> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      PACKETA_REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await this.fetchImplementation(url, {
        signal: controller.signal,
      });
      const body = await boundedJson(response);
      if (!response.ok || !Array.isArray(body)) {
        throw new ServiceUnavailableException(
          "Delivery provider is unavailable",
        );
      }
      return body;
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException("Delivery provider is unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function deliveryCapabilityFromEnvironment(): DeliveryCapabilityPort {
  const mode = process.env.TAVEN_DELIVERY_SELECTOR_MODE?.trim().toUpperCase();
  if (!mode || mode === "CONFIGURED")
    return new ConfiguredDeliveryCapabilityAdapter();
  if (mode !== "PACKETA")
    throw new Error(
      "TAVEN_DELIVERY_SELECTOR_MODE must be CONFIGURED or PACKETA",
    );
  const accountId = process.env.TAVEN_PACKETA_WIDGET_ACCOUNT_ID?.trim();
  if (!accountId || accountId.length > 128) {
    throw new Error("TAVEN_PACKETA_WIDGET_ACCOUNT_ID is required for PACKETA");
  }
  return new PacketaDeliveryCapabilityAdapter({
    accountId,
    widgetOptions: packetaWidgetOptions(
      process.env.TAVEN_PACKETA_WIDGET_OPTIONS_JSON,
    ),
  });
}

function resolvedConfiguredEndpoint(
  endpoint: ConfiguredEndpoint,
): ResolvedDeliveryCapability {
  return {
    providerEndpointId: endpoint.providerEndpointId,
    endpointType: endpoint.endpointType,
    addressSnapshot: endpoint.addressSnapshot,
    capabilitySnapshot: {
      provider: endpoint.provider ?? "configured",
      supportedCategoryIds: [...endpoint.supportedCategoryIds],
    },
    supportedCategoryIds: endpoint.supportedCategoryIds,
  };
}

function packetaResolved(point: PacketaPoint): ResolvedDeliveryCapability {
  const supportedCategoryIds = point.kind === "zbox" ? ["zbox"] : ["pickup"];
  const endpointConstraints = point.maxWeightMilligrams
    ? { maxWeightMilligrams: point.maxWeightMilligrams.toString() }
    : {};
  return {
    providerEndpointId: point.id,
    endpointType: "pickup_point",
    addressSnapshot: freezeJson({
      ...point.address,
      label: point.name,
      provider: "packeta",
    }),
    capabilitySnapshot: freezeJson({
      version: 1,
      provider: "packeta",
      endpointKind: point.kind,
      supportedCategoryIds,
      endpointConstraints,
    }),
    supportedCategoryIds,
  };
}

function parsePacketaPoint(
  value: unknown,
  kind: "pickup" | "zbox",
): PacketaPoint | undefined {
  const record = jsonRecord(value);
  if (!record) return undefined;
  const id = text(record.id);
  const name = text(record.name);
  const street = text(record.street);
  const city = text(record.city);
  const postalCode = text(record.zip);
  const country = text(record.country)?.toUpperCase();
  if (!id || !name || !street || !city || !postalCode || country !== "CZ")
    return undefined;
  if (record.displayFrontend === 0 || record.displayFrontend === "0")
    return undefined;
  const maxWeightKilograms = positiveNumber(record.maxWeight);
  return {
    id,
    kind,
    name,
    address: { country, city, street, postalCode },
    ...(maxWeightKilograms
      ? {
          maxWeightMilligrams: BigInt(
            Math.floor(maxWeightKilograms * 1_000_000),
          ),
        }
      : {}),
  };
}

function insertPoint(
  points: Map<string, PacketaPoint>,
  point: PacketaPoint | undefined,
): void {
  if (!point || points.has(point.id)) return;
  points.set(point.id, point);
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (
    length &&
    (!/^\d+$/.test(length) || Number(length) > PACKETA_RESPONSE_LIMIT_BYTES)
  ) {
    await response.body?.cancel();
    throw new ServiceUnavailableException("Delivery provider is unavailable");
  }
  const body = await boundedResponseText(response);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ServiceUnavailableException("Delivery provider is unavailable");
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > PACKETA_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new ServiceUnavailableException("Delivery provider is unavailable");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function readCommittedDeliveryCapability(
  input: CommittedDeliveryCapability,
): ResolvedDeliveryCapability {
  const capability = jsonRecord(input.capabilitySnapshot);
  const address = jsonRecord(input.addressSnapshot);
  const supportedCategoryIds = stringArray(capability?.supportedCategoryIds);
  const isPacketa = capability?.provider === "packeta";
  if (
    !nonBlankText(input.providerEndpointId) ||
    !nonBlankText(input.endpointType) ||
    supportedCategoryIds.length === 0 ||
    (isPacketa &&
      (input.endpointType !== "pickup_point" ||
        capability?.version !== 1 ||
        !nonBlankText(address?.label) ||
        !nonBlankText(address?.country) ||
        supportedCategoryIds.some(
          (category) => category !== "pickup" && category !== "zbox",
        )))
  ) {
    throw new BadRequestException("Committed delivery destination is stale");
  }
  return {
    providerEndpointId: input.providerEndpointId,
    endpointType: input.endpointType,
    addressSnapshot: freezeJson(
      input.addressSnapshot as Prisma.InputJsonObject,
    ),
    capabilitySnapshot: freezeJson(
      input.capabilitySnapshot as Prisma.InputJsonObject,
    ),
    supportedCategoryIds,
  };
}

function assertParcel(parcel: DeliveryValidationParcel): void {
  for (const value of [
    parcel.weightMilligrams,
    parcel.xMicrometers,
    parcel.yMicrometers,
    parcel.zMicrometers,
  ]) {
    if (value <= 0n)
      throw new BadRequestException(
        "Delivery selection has invalid parcel dimensions",
      );
  }
}

function micrometersToCentimeters(value: bigint): number {
  return Number((value + 9_999n) / 10_000n);
}

function packetaWidgetOptions(
  serialized: string | undefined,
): Prisma.InputJsonObject {
  if (!serialized) return {};
  if (serialized.length > 4_096)
    throw new Error("TAVEN_PACKETA_WIDGET_OPTIONS_JSON is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("TAVEN_PACKETA_WIDGET_OPTIONS_JSON must be valid JSON");
  }
  if (!jsonRecord(parsed))
    throw new Error("TAVEN_PACKETA_WIDGET_OPTIONS_JSON must be an object");
  return freezeJson(parsed as Prisma.InputJsonObject);
}

function publicLabel(endpoint: ConfiguredEndpoint): string {
  const label = endpoint.addressSnapshot.label;
  return typeof label === "string" && label.trim()
    ? label.trim()
    : endpoint.providerEndpointId;
}

function configuredEndpoints(): readonly ConfiguredEndpoint[] {
  const serialized = process.env.TAVEN_DELIVERY_ENDPOINTS_JSON;
  if (!serialized) {
    if (process.env.NODE_ENV === "production")
      throw new Error(
        "TAVEN_DELIVERY_ENDPOINTS_JSON is required in production",
      );
    return freezeConfiguredEndpoints(DEFAULT_ENDPOINTS);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("TAVEN_DELIVERY_ENDPOINTS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("TAVEN_DELIVERY_ENDPOINTS_JSON must be a non-empty array");
  return freezeConfiguredEndpoints(
    parsed.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Delivery endpoint ${index} must be an object`);
      const record = value as Record<string, unknown>;
      const providerEndpointId = nonBlank(record.providerEndpointId, index);
      const endpointType = nonBlank(record.endpointType, index);
      const addressSnapshot = configuredJsonObject(
        record.addressSnapshot,
        index,
        "addressSnapshot",
      );
      const supportedCategoryIds = record.supportedCategoryIds;
      if (
        !Array.isArray(supportedCategoryIds) ||
        supportedCategoryIds.length === 0 ||
        supportedCategoryIds.some(
          (category) => typeof category !== "string" || !category.trim(),
        )
      ) {
        throw new Error(
          `Delivery endpoint ${index} supportedCategoryIds must be non-empty strings`,
        );
      }
      return Object.freeze({
        providerEndpointId,
        endpointType,
        addressSnapshot,
        supportedCategoryIds: [...new Set(supportedCategoryIds)].sort(),
        ...(typeof record.provider === "string" && record.provider.trim()
          ? { provider: record.provider.trim() }
          : {}),
      });
    }),
  );
}

function freezeConfiguredEndpoints(
  endpoints: readonly ConfiguredEndpoint[],
): readonly ConfiguredEndpoint[] {
  return Object.freeze(
    endpoints.map((endpoint) =>
      Object.freeze({
        ...endpoint,
        addressSnapshot: freezeJson(endpoint.addressSnapshot),
        supportedCategoryIds: Object.freeze([...endpoint.supportedCategoryIds]),
      }),
    ),
  );
}

function nonBlank(value: unknown, index: number): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Delivery endpoint ${index} identity must not be blank`);
  return value.trim();
}

function configuredJsonObject(
  value: unknown,
  index: number,
  name: string,
): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Delivery endpoint ${index} ${name} must be an object`);
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384)
    throw new Error(`Delivery endpoint ${index} ${name} is too large`);
  return JSON.parse(serialized) as Prisma.InputJsonObject;
}

function freezeJson(value: Prisma.InputJsonObject): Prisma.InputJsonObject {
  return deepFreeze(
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject,
  );
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>))
      deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => nonBlankText(entry))
    ? [...new Set(value)].sort()
    : [];
}

function nonBlankText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function text(value: unknown): string | undefined {
  return nonBlankText(value) ? value.trim() : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
