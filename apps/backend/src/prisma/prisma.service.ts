import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString && process.env.TAVEN_OPENAPI_EXPORT !== "true") {
      throw new Error("DATABASE_URL is required when PrismaModule is active");
    }
    super({
      adapter: new PrismaPg({
        connectionString:
          connectionString ??
          "postgresql://contract:contract@127.0.0.1:1/contract",
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.TAVEN_OPENAPI_EXPORT === "true") return;
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    if (process.env.TAVEN_OPENAPI_EXPORT === "true") return;
    await this.$disconnect();
  }
}
