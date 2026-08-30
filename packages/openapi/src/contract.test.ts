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
    const items = issueOffer.items as {
      items: {
        discriminator: { propertyName: string };
        oneOf: Array<{ $ref: string }>;
      };
    };

    expect(items.items).toMatchObject({
      discriminator: { propertyName: "kind" },
      oneOf: [
        { $ref: "#/components/schemas/CustomServiceOfferItemDto" },
        { $ref: "#/components/schemas/ModelOfferItemDto" },
      ],
    });
    expect(schemas.CustomServiceOfferItemDto?.required).toEqual([
      "kind",
      "serviceDescription",
    ]);
    expect(schemas.ModelOfferItemDto?.required).toEqual([
      "kind",
      "sourceModelFileId",
      "modelGeometryId",
      "printConfigRevisionId",
      "material",
    ]);
    expect(schemas.ModelOfferItemDto?.properties?.quantity).toMatchObject({
      type: "integer",
      maximum: 2_147_483_647,
    });
    expect(issueOffer.contractTotalMinor).toMatchObject({ type: "integer" });
    expect(issueOffer.depositMinor).toMatchObject({ type: "integer" });
    expect(
      schemas.OfferPriceComponentDto?.properties?.amountMinor,
    ).toMatchObject({ type: "integer" });
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

    expect(idempotencyHeaders).toHaveLength(6);
    expect(idempotencyHeaders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schema: {
            type: "string",
            minLength: 8,
            maxLength: 255,
          },
        }),
      ]),
    );
    for (const header of idempotencyHeaders) {
      expect(header.schema).toEqual({
        type: "string",
        minLength: 8,
        maxLength: 255,
      });
    }
  });
});
