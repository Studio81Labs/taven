import "dotenv/config";
import { defineConfig } from "prisma/config";

const isGenerate = process.argv.includes("generate");
const databaseUrl =
  process.env.DATABASE_URL ??
  (isGenerate
    ? "postgresql://generate:generate@localhost:5432/taven"
    : undefined);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for Prisma migration commands");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx scripts/seed.ts" },
  datasource: { url: databaseUrl },
});
