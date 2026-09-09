import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("OpenAPI artifact", () => {
  it("contains the health endpoint", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as { paths?: Record<string, unknown> };

    expect(contract.paths).toHaveProperty("/health");
  });

  it("describes the GitHub callback redirect", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              { description?: string; headers?: Record<string, unknown> }
            >;
          }
        >
      >;
    };

    expect(
      contract.paths["/admin/auth/github/callback"]?.get?.responses?.["302"],
    ).toMatchObject({
      description: "Redirects the browser after the GitHub callback is handled",
      headers: {
        Location: {
          schema: { type: "string", format: "uri" },
        },
      },
    });
  });

  it("requires the operator payload in authenticated sessions", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as {
      components: {
        schemas: Record<string, { required?: string[] }>;
      };
    };

    expect(contract.components.schemas.OperatorSessionDto?.required).toEqual([
      "operator",
      "csrfToken",
    ]);
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

    expect(idempotencyHeaders).toHaveLength(62);
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

  it("describes catalog command boundary constraints", async () => {
    const contract = JSON.parse(
      await readFile(new URL("../openapi.json", import.meta.url), "utf8"),
    ) as {
      components: {
        schemas: Record<
          string,
          { properties?: Record<string, Record<string, unknown>> }
        >;
      };
    };
    const schemas = contract.components.schemas;
    const nonBlankTextPattern =
      "^(?=[\\s\\S]*\\S)[\\u0001-\\uD7FF\\uE000-\\u{10FFFF}]*$";

    expect(
      schemas.CreateReferenceProfileDto?.properties?.material,
    ).toMatchObject({ enum: ["PLA", "PETG"] });
    expect(
      schemas.CreateMachineProfileDto?.properties?.nozzleDiameterMicrometers,
    ).toMatchObject({ type: "integer", minimum: 1, maximum: 2_147_483_647 });
    expect(
      schemas.CreateMachineCalibrationDto?.properties?.flowRatioPartsPerMillion,
    ).toMatchObject({ type: "integer", minimum: 1, maximum: 2_147_483_647 });
    const inventoryProperties = schemas.CreateInventoryDto?.properties;
    const textProperties = [
      schemas.CatalogReasonDto?.properties?.reason,
      schemas.CreateReferenceProfileDto?.properties?.slicerEngine,
      schemas.CreateReferenceProfileDto?.properties?.slicerVersion,
      inventoryProperties?.sku,
      inventoryProperties?.vendor,
      inventoryProperties?.color,
      inventoryProperties?.lotCode,
    ];
    for (const property of textProperties) {
      expect(property?.pattern).toBe(nonBlankTextPattern);
      const unicodePattern = new RegExp(property?.pattern as string, "u");
      expect("valid catalog text").toMatch(unicodePattern);
      expect("valid 🧵 catalog text").toMatch(unicodePattern);
      expect("invalid\u0000catalog text").not.toMatch(unicodePattern);
      expect("invalid\ud800catalog text").not.toMatch(unicodePattern);
    }
    for (const property of [
      schemas.CreateReferenceProfileDto?.properties?.settings,
      schemas.CreateMachineProfileDto?.properties?.settings,
      schemas.CreateMachineCalibrationDto?.properties?.settings,
    ]) {
      expect(property).toMatchObject({
        description:
          "Settings must not exceed 64 nested object or array levels. String keys and values must not contain U+0000 or unpaired UTF-16 surrogates.",
      });
    }
    const numerator = inventoryProperties?.priceMinorUnitsNumerator;
    const denominator = inventoryProperties?.priceMinorUnitsDenominator;
    const remaining = inventoryProperties?.remainingMilligrams;
    const adjustment =
      schemas.InventoryAdjustmentDto?.properties?.deltaMilligrams;

    expect(numerator).toMatchObject({ format: "int64" });
    expect(denominator).toMatchObject({ format: "int64" });
    expect(remaining).toMatchObject({ format: "int64" });
    expect(adjustment).toMatchObject({ format: "int64" });

    for (const schema of [numerator, denominator, remaining, adjustment]) {
      expect(schema?.pattern).toEqual(expect.any(String));
      expect("9223372036854775808").not.toMatch(
        new RegExp(schema?.pattern as string),
      );
    }
    expect("9223372036854775807").toMatch(
      new RegExp(numerator?.pattern as string),
    );
    expect("9223372036854775807").toMatch(
      new RegExp(denominator?.pattern as string),
    );
    expect("0").not.toMatch(new RegExp(denominator?.pattern as string));
    expect("0").toMatch(new RegExp(remaining?.pattern as string));
    expect("-9223372036854775808").toMatch(
      new RegExp(adjustment?.pattern as string),
    );
    expect("-9223372036854775809").not.toMatch(
      new RegExp(adjustment?.pattern as string),
    );
    expect("0").not.toMatch(new RegExp(adjustment?.pattern as string));
    expect("-0").not.toMatch(new RegExp(adjustment?.pattern as string));
    expect(schemas.MachineStatusDto?.properties?.status).toMatchObject({
      enum: ["ACTIVE", "MAINTENANCE", "DISABLED"],
    });
    expect(schemas.InventoryStatusDto?.properties?.status).toMatchObject({
      enum: ["AVAILABLE", "DEPLETED", "RETIRED"],
    });
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
