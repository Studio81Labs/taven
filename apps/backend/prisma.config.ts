import "dotenv/config";
import { defineConfig } from "prisma/config";

const isGenerate = process.argv.includes("generate");
const legacyAutomaticPriceRevision =
  process.env.TAVEN_AUTOMATIC_PRICE_LIST_REVISION?.trim();
if (
  legacyAutomaticPriceRevision &&
  legacyAutomaticPriceRevision !== "automatic-v0-czk"
) {
  throw new Error(
    "Commercial selector bootstrap requires the exact automatic-v0-czk legacy revision; resolve the custom TAVEN_AUTOMATIC_PRICE_LIST_REVISION before migration",
  );
}
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
