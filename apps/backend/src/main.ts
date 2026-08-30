import "dotenv/config";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { configureTrustedProxies } from "./trusted-proxy.config";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
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
