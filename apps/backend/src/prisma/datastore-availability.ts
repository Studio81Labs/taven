import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const PRISMA_DATASTORE_UNAVAILABLE_CODES = new Set([
  "P1000",
  "P1001",
  "P1002",
  "P1008",
  "P1009",
  "P1017",
  "P2037",
  "P2024",
]);
const POSTGRES_DATASTORE_UNAVAILABLE_CODES = new Set([
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
  "57P01",
  "57P02",
  "57P03",
  "53300",
]);

export function isDatastoreUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (!error || typeof error !== "object") return false;
  const { code, message, meta } = error as {
    code?: unknown;
    message?: unknown;
    meta?: { code?: unknown };
  };
  const databaseCode = meta?.code;
  return (
    message === "Database clock is unavailable" ||
    [code, databaseCode].some(
      (candidate) =>
        typeof candidate === "string" &&
        (PRISMA_DATASTORE_UNAVAILABLE_CODES.has(candidate) ||
          POSTGRES_DATASTORE_UNAVAILABLE_CODES.has(candidate)),
    )
  );
}

export async function withDatastoreAvailability<T>(
  operation: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isDatastoreUnavailable(error)) {
      throw new ServiceUnavailableException(message);
    }
    throw error;
  }
}
