import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";

describe("backend HTTP boundary", () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
    await prisma.onModuleDestroy();
  });

  it("connects to the migrated PostgreSQL database", async () => {
    const rows = await prisma.$queryRaw<
      Array<{ value: number }>
    >`SELECT 1 AS value`;
    expect(rows).toEqual([{ value: 1 }]);
  });

  it("serves the health contract over HTTP", async () => {
    const response = await fetch(new URL("/health", await app.getUrl()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "taven-backend",
    });
  });
});
