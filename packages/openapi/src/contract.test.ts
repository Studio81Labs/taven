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
});
