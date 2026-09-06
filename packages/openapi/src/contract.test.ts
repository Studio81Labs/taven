import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("OpenAPI artifact", () => {
  it("contains the health endpoint", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as { paths?: Record<string, unknown> };

    expect(contract.paths).toHaveProperty("/health");
  });

  it("describes individual offer inputs as the service validates them", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as {
      components: {
        schemas: Record<
          string,
          {
            properties?: Record<string, unknown>;
            required?: string[];
          }
        >;
      };
    };
    const schemas = contract.components.schemas;
    const issueOffer = schemas.IssueOfferDto?.properties as Record<
      string,
      unknown
    >;
    expect(issueOffer.items).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/ModelOfferItemDto" },
    });
    expect(schemas.ModelOfferItemDto?.required).toEqual([
      "kind",
      "sourceModelFileId",
      "modelGeometryId",
      "printConfigRevisionId",
      "material",
    ]);
    expect(schemas.ModelOfferItemDto?.properties?.quantity).toMatchObject({
      type: "integer",
      maximum: 1_000,
    });
    expect(schemas.CreateQuoteRequestDto?.properties?.purpose).toMatchObject({
      pattern: "\\S",
    });
    expect(schemas.QuoteContactDto?.properties?.phone).toMatchObject({
      pattern: "\\S",
    });
    expect(schemas.ModelOfferItemDto?.properties?.color).toMatchObject({
      pattern: "\\S",
    });
    expect(schemas.RejectOfferDto?.properties?.reason).toMatchObject({
      pattern: "\\S",
    });
    expect(issueOffer.contractTotalMinor).toMatchObject({
      type: "integer",
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(issueOffer.depositMinor).toMatchObject({
      type: "integer",
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(
      schemas.OfferPriceComponentDto?.properties?.amountMinor,
    ).toMatchObject({
      type: "integer",
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(
      schemas.OfferPreviewPriceComponentDto?.properties?.amountMinor,
    ).toMatchObject({ maximum: Number.MAX_SAFE_INTEGER });
    expect(
      schemas.OfferPaymentScheduleDto?.properties?.grossAmountMinor,
    ).toMatchObject({ maximum: Number.MAX_SAFE_INTEGER });
    expect(
      schemas.OfferPaymentScheduleDto?.properties?.feeFixedMinor,
    ).toMatchObject({ maximum: Number.MAX_SAFE_INTEGER });
    expect(
      schemas.OfferPreviewDto?.properties?.contractTotalMinor,
    ).toMatchObject({ maximum: Number.MAX_SAFE_INTEGER });
    expect(
      schemas.OfferPriceComponentDto?.properties?.quoteItemOrdinal,
    ).toMatchObject({ type: "integer" });
  });

  it("declares the runtime bounds for every idempotency key", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as {
      paths: Record<
        string,
        Record<
          string,
          {
            parameters?: Array<{
              name: string;
              schema?: Record<string, unknown>;
            }>;
          }
        >
      >;
    };
    const idempotencyHeaders = Object.values(contract.paths).flatMap((path) =>
      Object.values(path).flatMap(
        (operation) =>
          operation.parameters?.filter(
            (parameter) => parameter.name === "Idempotency-Key",
          ) ?? [],
      ),
    );

    expect(idempotencyHeaders).toHaveLength(42);
    expect(idempotencyHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: {
            type: "string",
            minLength: 8,
            pattern: "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$",
          },
        }),
      ]),
    );
    for (const header of idempotencyHeaders) {
      expect(header.schema).toEqual({
        type: "string",
        minLength: 8,
        pattern: "^\\s*\\S[\\s\\S]{6,253}\\S\\s*$",
      });
    }
  });

  it("describes every fulfilment route input", async () => {
    type Parameter = {
      in?: string;
      name?: string;
      required?: boolean;
      schema?: Record<string, unknown>;
    };
    type Operation = {
      parameters?: Parameter[];
      requestBody?: {
        required?: boolean;
        content?: Record<string, { schema?: Record<string, unknown> }>;
      };
    };
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as { paths: Record<string, Record<string, Operation>> };
    const fulfilmentPrefix = "/admin/orders/{orderId}/fulfilment";

    for (const [path, pathItem] of Object.entries(contract.paths)) {
      if (!path.startsWith(fulfilmentPrefix)) continue;
      const parameterNames = [...path.matchAll(/\{([^}]+)\}/g)].map(
        ([, name]) => name,
      );
      for (const operation of Object.values(pathItem)) {
        for (const name of parameterNames) {
          expect(
            operation.parameters,
            `${path} path parameter ${name}`,
          ).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                in: "path",
                name,
                required: true,
                schema: { type: "string", format: "uuid" },
              }),
            ]),
          );
        }
      }
    }

    const requestBodies: Record<string, string> = {
      [`${fulfilmentPrefix}/jobs/{jobId}/printed`]: "JobPrintedDto",
      [`${fulfilmentPrefix}/jobs/{jobId}/qc-submission`]: "JobQcSubmissionDto",
      [`${fulfilmentPrefix}/jobs/{jobId}/failure`]: "JobFailureDto",
      [`${fulfilmentPrefix}/jobs/{jobId}/replacement`]: "CreateReplacementDto",
      [`${fulfilmentPrefix}/jobs/{jobId}/replacement-expiry`]:
        "ExpireReplacementDto",
      [`${fulfilmentPrefix}/jobs/{jobId}/packing`]: "PackJobDto",
      [`${fulfilmentPrefix}/shipments`]: "CreateShipmentDto",
      [`${fulfilmentPrefix}/shipments/{shipmentId}/label`]: "ShipmentLabelDto",
      [`${fulfilmentPrefix}/shipments/{shipmentId}/label-void`]:
        "ShipmentProviderEvidenceDto",
      [`${fulfilmentPrefix}/shipments/{shipmentId}/handoff`]:
        "ShipmentProviderEvidenceDto",
      [`${fulfilmentPrefix}/shipments/{shipmentId}/events`]: "ShipmentEventDto",
      [`${fulfilmentPrefix}/adjustments`]: "CreatePriceAdjustmentDto",
      [`${fulfilmentPrefix}/claims`]: "CreateClaimDto",
      [`${fulfilmentPrefix}/claims/{claimId}/rejection`]: "RejectClaimDto",
      [`${fulfilmentPrefix}/claims/{claimId}/withdrawal`]: "WithdrawClaimDto",
      [`${fulfilmentPrefix}/claims/{claimId}/reshipment-handoff`]:
        "HandoffReshipmentDto",
      [`${fulfilmentPrefix}/claims/{claimId}/reprint`]: "CreateClaimReprintDto",
      [`${fulfilmentPrefix}/cancel`]: "CancelOrderDto",
    };
    for (const [path, schemaName] of Object.entries(requestBodies)) {
      expect(
        contract.paths[path]?.post?.requestBody,
        `${path} request body`,
      ).toEqual({
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${schemaName}` },
          },
        },
      });
    }
  });
});
