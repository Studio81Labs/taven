import type { NestExpressApplication } from "@nestjs/platform-express";

export const HTTP_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

export function configureHttpBodyParsers(app: NestExpressApplication): void {
  app.useBodyParser("json", { limit: HTTP_BODY_LIMIT_BYTES });
  app.useBodyParser("urlencoded", {
    extended: true,
    limit: HTTP_BODY_LIMIT_BYTES,
  });
}
