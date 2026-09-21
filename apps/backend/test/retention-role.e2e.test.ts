import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ObjectStorage } from "../src/modules/storage/object-storage.port";
import { RetentionService } from "../src/modules/storage/retention.service";
import { PrismaService } from "../src/prisma/prisma.service";

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function prismaFor(connectionString: string): PrismaService {
  const previous = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = connectionString;
    return new PrismaService();
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
}

describe("dedicated retention database role", () => {
  const suffix = randomUUID().replaceAll("-", "");
  const database = `retention_test_${suffix}`;
  const role = `retention_${suffix}`;
  let admin: Client;
  let owner: Client;
  let fixtures: PrismaService;
  let restricted: PrismaService;
  let retention: RetentionService;
  const deleteObjects = vi
    .fn<ObjectStorage["deleteObjects"]>()
    .mockResolvedValue();
  const objects: ObjectStorage = {
    deleteObjects,
    listObjects: async () => ({ objects: [], isTruncated: false }),
    headObject: async () => null,
    putImmutableObject: vi.fn(),
    createUploadUrl: vi.fn(),
    createDownloadUrl: vi.fn(),
    readObjectRange: vi.fn(),
    copyObject: vi.fn(),
  };

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.delete("schema");
    url.pathname = "/postgres";
    admin = new Client({ connectionString: url.toString() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${identifier(database)}`);
    url.pathname = `/${database}`;
    owner = new Client({ connectionString: url.toString() });
    await owner.connect();
    fixtures = prismaFor(url.toString());

    // Fresh schema: no inherited owner grants or pre-existing retention jobs.
    const migrationsRoot = join(process.cwd(), "prisma/migrations");
    for (const name of (await readdir(migrationsRoot))
      .filter((x) => /^20/.test(x))
      .sort()) {
      const sql = await readFile(
        join(migrationsRoot, name, "migration.sql"),
        "utf8",
      );
      // New enum values must commit before the rest of each migration uses them.
      const enums = /^ALTER TYPE .+ ADD VALUE(?: IF NOT EXISTS)? .+;$/gmu;
      for (const statement of sql.match(enums) ?? [])
        await owner.query(statement);
      await owner.query(sql.replace(enums, ""));
    }
    const password = randomUUID();
    await admin.query(
      `CREATE ROLE ${identifier(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    const grants = (
      await readFile(
        join(process.cwd(), "../../infra/coolify/retention-grants.sql"),
        "utf8",
      )
    )
      .replaceAll(':"DBNAME"', identifier(database))
      .replaceAll(':"retention_role"', identifier(role));
    await owner.query(grants);
    await owner.query(grants); // Safe to reapply to an existing dedicated role.
    url.username = role;
    url.password = password;
    restricted = prismaFor(url.toString());
    expect(await restricted.$queryRaw`SELECT current_user AS role`).toEqual([
      { role },
    ]);
    retention = new RetentionService(restricted, objects);
  }, 60_000);

  afterAll(async () => {
    await restricted?.$disconnect();
    await fixtures?.$disconnect();
    await owner?.end();
    if (admin) {
      try {
        await admin.query(
          `DROP DATABASE IF EXISTS ${identifier(database)} WITH (FORCE)`,
        );
        await admin.query(`DROP ROLE IF EXISTS ${identifier(role)}`);
      } finally {
        await admin.end();
      }
    }
  });

  it("completes model deletion and propagates its deletion marker to geometry", async () => {
    const id = randomUUID();
    const geometryId = randomUUID();
    const sourceKey = `models/${id}/source.stl`;
    const geometryKey = `canonical/${geometryId}`;
    await fixtures.modelFile.create({
      data: {
        id,
        format: "STL",
        originalFilename: "retention.stl",
        storageObjectKey: sourceKey,
        contentHash: "a".repeat(64),
        sizeBytes: 1n,
        uploadedAt: new Date(Date.now() - 172_800_000),
        sourceDeleteAfter: new Date(Date.now() - 86_400_000),
        retentionHold: "LEGAL",
      },
    });
    await fixtures.modelGeometry.create({
      data: {
        id: geometryId,
        sourceModelFileId: id,
        canonicalObjectKey: geometryKey,
        geometryHash: "b".repeat(64),
        canonicalizerRevision: "retention-role-test",
        volumeCubicMicrometers: 1n,
        boundsXMicrometers: 1n,
        boundsYMicrometers: 1n,
        boundsZMicrometers: 1n,
        triangleCount: 1,
      },
    });
    await fixtures.modelFile.update({
      where: { id },
      data: { retentionHold: "NONE" },
    });
    expect(await retention.runOnce()).toBe(1);
    const source = await fixtures.modelFile.findUniqueOrThrow({
      where: { id },
    });
    expect(source.deletedAt).not.toBeNull();
    expect(
      (
        await fixtures.modelGeometry.findUniqueOrThrow({
          where: { id: geometryId },
        })
      ).deletedAt,
    ).toEqual(source.deletedAt);
    expect(
      await fixtures.retentionDeletionJob.findFirstOrThrow({
        where: { assetId: id },
      }),
    ).toMatchObject({ status: "SUCCEEDED", lastError: null });
    expect(deleteObjects).toHaveBeenCalledWith([geometryKey, sourceKey].sort());
  });

  it.each([
    { kind: "QUOTE_REFERENCE", scopeKind: "QUOTE_REQUEST" },
    { kind: "QC", scopeKind: "JOB" },
  ] as const)(
    "completes $kind photo deletion through the active-order and claim guards",
    async ({ kind, scopeKind }) => {
      const id = randomUUID();
      await fixtures.photoAsset.create({
        data: {
          id,
          kind,
          scopeKind,
          scopeId: randomUUID(),
          storageObjectKey: `photos/${id}/original`,
          contentHash: "c".repeat(64),
          mediaType: "image/png",
          sizeBytes: 1n,
          uploadedAt: new Date(Date.now() - 172_800_000),
          photoDeleteAfter: new Date(Date.now() - 86_400_000),
          retentionHold: "LEGAL",
        },
      });
      await fixtures.photoAsset.update({
        where: { id },
        data: { retentionHold: "NONE" },
      });
      expect(await retention.runOnce()).toBe(1);
      expect(
        (await fixtures.photoAsset.findUniqueOrThrow({ where: { id } }))
          .deletedAt,
      ).not.toBeNull();
      expect(
        await fixtures.retentionDeletionJob.findFirstOrThrow({
          where: { assetId: id },
        }),
      ).toMatchObject({ status: "SUCCEEDED", lastError: null });
    },
  );

  it("does not grant operator session access, reservation writes or geometry payload writes", async () => {
    for (const sql of [
      "SELECT * FROM operator_sessions LIMIT 0",
      "SELECT * FROM orders LIMIT 0",
      "SELECT * FROM payments LIMIT 0",
      "SELECT * FROM claims LIMIT 0",
      "UPDATE production_reservations SET status = status WHERE false",
      "UPDATE capacity_reservations SET status = status WHERE false",
      "UPDATE model_geometries SET geometry_hash = geometry_hash WHERE false",
    ]) {
      await expect(restricted.$executeRawUnsafe(sql)).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
