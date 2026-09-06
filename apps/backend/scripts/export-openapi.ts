import "reflect-metadata";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import {
  DocumentBuilder,
  SwaggerModule,
  type OperationObject,
  type OpenAPIObject,
} from "@nestjs/swagger";

const UNSAFE_HTTP_METHODS = new Set(["delete", "patch", "post", "put"]);

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

function requireOperatorCsrfHeader(document: OpenAPIObject): void {
  for (const pathItem of Object.values(document.paths)) {
    for (const method of UNSAFE_HTTP_METHODS) {
      const operation = pathItem[method as keyof typeof pathItem];
      if (
        !operation ||
        !(operation as OperationObject).security?.some(
          (security) => "operatorSession" in security,
        )
      ) {
        continue;
      }
      const parameters = (operation as OperationObject).parameters;
      const headerIndex = parameters?.findIndex(
        (parameter) =>
          "in" in parameter &&
          parameter.in === "header" &&
          parameter.name === "x-csrf-token",
      );
      if (headerIndex === undefined || headerIndex < 0 || !parameters) continue;
      const header = parameters[headerIndex];
      if (header && "in" in header) {
        parameters[headerIndex] = { ...header, required: true };
      }
    }
  }
}

async function exportContract(): Promise<void> {
  process.env.TAVEN_OPENAPI_EXPORT = "true";
  process.env.TAVEN_REDIS_URL ??= "redis://127.0.0.1:6379";
  process.env.TAVEN_S3_ENDPOINT ??= "http://127.0.0.1:9010";
  process.env.TAVEN_S3_REGION ??= "us-east-1";
  process.env.TAVEN_S3_BUCKET ??= "taven-contract";
  process.env.TAVEN_S3_ACCESS_KEY_ID ??= "contract";
  process.env.TAVEN_S3_SECRET_ACCESS_KEY ??= "contract-only-placeholder";
  process.env.TAVEN_S3_FORCE_PATH_STYLE ??= "true";
  process.env.TAVEN_UPLOAD_CLIENT_HASH_KEY ??=
    "contract-only-upload-client-hash-key";
  const { AppModule } = await import("../src/app.module.js");
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  const config = new DocumentBuilder()
    .setTitle("Taven API")
    .setDescription("Canonical HTTP contract for Taven clients")
    .setVersion("0.0.0")
    .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "opaque" })
    .addSecurity("operatorSession", {
      type: "apiKey",
      in: "cookie",
      name: "__Host-taven_admin",
      description:
        "Environment-specific HttpOnly operator session cookie; development uses a local cookie name.",
    })
    .build();
  const document = SwaggerModule.createDocument(app, config);
  requireOperatorCsrfHeader(document);
  const outputPath = path.resolve("../../packages/openapi/openapi.json");

  await writeFile(
    outputPath,
    `${JSON.stringify(sortObject(document), null, 2)}\n`,
  );
  await app.close();
}

void exportContract().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
