import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureHttpBodyParsers } from "./http-body.config";
import { configureTrustedProxies } from "./trusted-proxy.config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureHttpBodyParsers(app);
  configureTrustedProxies(app);
  const allowedOrigins = (
    process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:3002"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({ origin: allowedOrigins });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
