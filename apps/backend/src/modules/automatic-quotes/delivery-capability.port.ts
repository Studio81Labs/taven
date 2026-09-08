import { BadRequestException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

export const DELIVERY_CAPABILITY = Symbol("DELIVERY_CAPABILITY");

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

export interface DeliveryCapabilityPort {
  list(): Promise<readonly DeliveryCapabilityOption[]>;

  resolve(input: {
    providerEndpointId: string;
    endpointType: string;
  }): Promise<ResolvedDeliveryCapability>;
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

/**
 * Provider-neutral adapter backed by deployment configuration. Production may
 * replace this provider with a carrier adapter without changing quote logic.
 */
@Injectable()
export class ConfiguredDeliveryCapabilityAdapter implements DeliveryCapabilityPort {
  private readonly endpoints = configuredEndpoints();

  async list(): Promise<readonly DeliveryCapabilityOption[]> {
    return this.endpoints.map((endpoint) => ({
      providerEndpointId: endpoint.providerEndpointId,
      endpointType: endpoint.endpointType,
      label: publicLabel(endpoint),
      supportedCategoryIds: endpoint.supportedCategoryIds,
    }));
  }

  async resolve(input: {
    providerEndpointId: string;
    endpointType: string;
  }): Promise<ResolvedDeliveryCapability> {
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
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "TAVEN_DELIVERY_ENDPOINTS_JSON is required in production",
      );
    }
    return freezeConfiguredEndpoints(DEFAULT_ENDPOINTS);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("TAVEN_DELIVERY_ENDPOINTS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("TAVEN_DELIVERY_ENDPOINTS_JSON must be a non-empty array");
  }
  return freezeConfiguredEndpoints(
    parsed.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Delivery endpoint ${index} must be an object`);
      }
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
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Delivery endpoint ${index} identity must not be blank`);
  }
  return value.trim();
}

function configuredJsonObject(
  value: unknown,
  index: number,
  name: string,
): Prisma.InputJsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Delivery endpoint ${index} ${name} must be an object`);
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) {
    throw new Error(`Delivery endpoint ${index} ${name} is too large`);
  }
  return JSON.parse(serialized) as Prisma.InputJsonObject;
}

function freezeJson(value: Prisma.InputJsonObject): Prisma.InputJsonObject {
  const copied = JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
  return deepFreeze(copied);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}
