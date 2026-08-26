import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "../src/app.module";

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortObject(nested)]),
    );
  }
  return value;
}

async function exportContract(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  const config = new DocumentBuilder()
    .setTitle("Taven API")
    .setDescription("Canonical HTTP contract for Taven clients")
    .setVersion("0.0.0")
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const outputPath = path.resolve("../../packages/openapi/openapi.json");

  await writeFile(
    outputPath,
    `${JSON.stringify(sortObject(document), null, 2)}\n`,
  );
  await app.close();
}

void exportContract();
