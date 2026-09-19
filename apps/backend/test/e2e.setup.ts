import { beforeAll, expect } from "vitest";
import { publishE2eLegalFixturesForDatabase } from "./support/publish-e2e-legal-fixtures";

process.env.TAVEN_CLAIM_WINDOW_DAYS ??= "30";

beforeAll(async () => {
  if (expect.getState().testPath?.endsWith("legal-documents.e2e.test.ts")) {
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required for E2E fixtures");
  await publishE2eLegalFixturesForDatabase(databaseUrl);
});
