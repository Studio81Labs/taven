import { describe, expect, it } from "vitest";
import {
  assertStorageObjectKey,
  canonicalGeometryObjectKey,
  modelSourceObjectKey,
  photoThumbnailObjectKey,
  quarantineObjectKey,
  slicerRevisionObjectKey,
} from "./storage-keys";

const id = "123e4567-e89b-42d3-a456-426614174000";

describe("storage object keys", () => {
  it("uses opaque server-owned namespaces", () => {
    expect(quarantineObjectKey(id)).toBe(`quarantine/${id}`);
    expect(modelSourceObjectKey(id)).toBe(`models/${id}/source`);
    expect(photoThumbnailObjectKey(id)).toBe(`photos/${id}/thumbnail`);
    expect(canonicalGeometryObjectKey(id)).toBe(`geometries/${id}/canonical`);
    expect(slicerRevisionObjectKey("a".repeat(64))).toBe(
      `slicer-revisions/${"a".repeat(64)}/settings.json`,
    );
  });

  it("rejects traversal and non-generated keys", () => {
    expect(() => assertStorageObjectKey("models/../../secret")).toThrow(
      "server-generated",
    );
    expect(() => assertStorageObjectKey("models/file name/source")).toThrow(
      "server-generated",
    );
    expect(() => modelSourceObjectKey("../not-an-id")).toThrow(
      "lowercase UUID",
    );
  });

  it("accepts persisted canonical and slice artifact namespaces", () => {
    expect(() => assertStorageObjectKey(`qc/${id}`)).not.toThrow();
    expect(() => assertStorageObjectKey(`quote-reference/${id}`)).not.toThrow();
    expect(() =>
      assertStorageObjectKey(
        "canonical/123e4567-e89b-42d3-a456-426614174000/canonical",
      ),
    ).not.toThrow();
    expect(() =>
      assertStorageObjectKey(
        "reference-slices/123e4567-e89b-42d3-a456-426614174000/toolpath.gcode",
      ),
    ).not.toThrow();
    expect(() =>
      assertStorageObjectKey("slices/commerce-foundations:fixture/part/0"),
    ).not.toThrow();
    expect(() => assertStorageObjectKey(`qc/${id}/../../secret`)).toThrow(
      "server-generated",
    );
    expect(() =>
      assertStorageObjectKey(`quote-reference/${id}/../../secret`),
    ).toThrow("server-generated");
  });
});
