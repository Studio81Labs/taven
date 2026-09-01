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

    expect(idempotencyHeaders).toHaveLength(14);
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
});
