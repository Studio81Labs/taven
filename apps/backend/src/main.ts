import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureHttpBodyParsers } from "./http-body.config";
import { readAdminAccessConfig } from "./modules/admin-access/admin-access.config";
import { configureTrustedProxies } from "./trusted-proxy.config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  configureHttpBodyParsers(app);
  configureTrustedProxies(app);
  const publicOrigins = (
    process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:3002"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const adminAccess = readAdminAccessConfig();
  app.enableCors((request, callback) => {
    const origin = request.headers.origin;
    if (!origin) {
      callback(null, { origin: false });
      return;
    }
    if (adminAccess.adminOrigins.includes(origin)) {
      callback(null, { origin, credentials: true });
      return;
    }
    callback(null, {
      origin: publicOrigins.includes(origin) ? origin : false,
      credentials: false,
    });
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}

void bootstrap();
