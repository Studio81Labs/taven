import { describe, expect, it } from "vitest";
import {
  MAX_MODEL_SIZE_BYTES,
  MAX_PHOTO_SIZE_BYTES,
  UploadValidationError,
  inspect3mfCentralDirectory,
  inspect3mfEndRecord,
  inspect3mfArchive,
  validateDisplayFilename,
  validateFileSignature,
  validateModelUploadMetadata,
  validatePhotoUploadMetadata,
} from "./upload-validation.js";

const scopeId = "123e4567-e89b-12d3-a456-426614174000";
const hash = "a".repeat(64);
const metadata = (extension: string, contentType: string, sizeBytes = 4) => ({
  scopeId,
  extension,
  contentType,
  sha256: hash,
  sizeBytes,
  displayFilename: `part.${extension}`,
});

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as UploadValidationError).code;
  }
  return "none";
}

describe("upload metadata validation", () => {
  it("normalizes valid model and photo metadata", () => {
    expect(
      validateModelUploadMetadata(metadata(".STL", "model/stl")),
    ).toMatchObject({ format: "STL", extension: "stl", kind: "model" });
    expect(
      validatePhotoUploadMetadata(metadata("jpeg", "image/jpeg")),
    ).toMatchObject({ format: "JPEG", kind: "photo" });
  });

  it("enforces UUID, lower-case SHA-256, supported types, sizes, and filenames", () => {
    expect(
      errorCode(() =>
        validateModelUploadMetadata({
          ...metadata("stl", "model/stl"),
          scopeId: "not-a-uuid",
        }),
      ),
    ).toBe("INVALID_SCOPE_ID");
    expect(
      errorCode(() =>
        validateModelUploadMetadata({
          ...metadata("stl", "model/stl"),
          sha256: hash.toUpperCase(),
        }),
      ),
    ).toBe("INVALID_SHA256");
    expect(
      errorCode(() =>
        validateModelUploadMetadata({
          ...metadata("exe", "application/octet-stream"),
        }),
      ),
    ).toBe("UNSUPPORTED_FORMAT");
    expect(
      errorCode(() =>
        validatePhotoUploadMetadata({ ...metadata("png", "image/jpeg") }),
      ),
    ).toBe("CONTENT_TYPE_MISMATCH");
    expect(
      errorCode(() =>
        validateModelUploadMetadata({
          ...metadata("stl", "model/stl"),
          sizeBytes: MAX_MODEL_SIZE_BYTES + 1,
        }),
      ),
    ).toBe("SIZE_LIMIT_EXCEEDED");
    expect(
      errorCode(() =>
        validatePhotoUploadMetadata({
          ...metadata("png", "image/png"),
          sizeBytes: 0,
        }),
      ),
    ).toBe("INVALID_SIZE");
    expect(
      errorCode(() =>
        validateModelUploadMetadata({
          ...metadata("stl", "model/stl"),
          displayFilename: "../part.stl",
        }),
      ),
    ).toBe("UNSAFE_FILENAME");
    expect(MAX_PHOTO_SIZE_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("byte signatures", () => {
  it("accepts the supported magic bytes", () => {
    validateFileSignature("JPEG", Uint8Array.from([0xff, 0xd8, 0xff, 0]));
    validateFileSignature(
      "PNG",
      Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    validateFileSignature(
      "WEBP",
      Uint8Array.from([...Buffer.from("RIFFxxxxWEBP")]),
    );
    validateFileSignature("STEP", new TextEncoder().encode("ISO-10303-21;\n"));
    const stl = new Uint8Array(84);
    new DataView(stl.buffer).setUint32(80, 0, true);
    validateFileSignature("STL", stl);
  });

  it("rejects signatures that do not match", () => {
    expect(
      errorCode(() => validateFileSignature("PNG", new Uint8Array(8))),
    ).toBe("INVALID_SIGNATURE");
  });
});

describe("bounded 3MF ZIP inspection", () => {
  it("accepts required 3MF entries through bounded directory inspection", () => {
    const directory = concatBytes(
      centralEntry("[Content_Types].xml"),
      centralEntry("3D/3dmodel.model"),
    );
    const archive = concatBytes(directory, endRecord(2, directory.byteLength));

    expect(inspect3mfEndRecord(archive)).toEqual({
      entries: 2,
      centralDirectoryOffset: 0,
      centralDirectorySize: directory.byteLength,
    });
    expect(inspect3mfCentralDirectory(directory, 2)).toEqual({
      entries: 2,
      expandedBytes: 0,
    });
    expect(inspect3mfArchive(archive)).toEqual({
      entries: 2,
      expandedBytes: 0,
    });
  });

  it("ignores an EOCD signature embedded in a valid ZIP comment", () => {
    const directory = concatBytes(
      centralEntry("[Content_Types].xml"),
      centralEntry("3D/3dmodel.model"),
    );
    const record = new Uint8Array(52);
    const view = new DataView(record.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, 2, true);
    view.setUint16(10, 2, true);
    view.setUint32(12, directory.byteLength, true);
    view.setUint32(16, 0, true);
    view.setUint16(20, 30, true);
    view.setUint32(22, 0x06054b50, true);

    expect(inspect3mfArchive(concatBytes(directory, record))).toEqual({
      entries: 2,
      expandedBytes: 0,
    });
  });

  it("rejects truncated and unsafe archives", () => {
    expect(errorCode(() => inspect3mfArchive(new Uint8Array(3)))).toBe(
      "MALFORMED_ARCHIVE",
    );
  });

  it("rejects empty archives and inconsistent central-directory sizes", () => {
    const empty = new Uint8Array(22);
    new DataView(empty.buffer).setUint32(0, 0x06054b50, true);
    expect(errorCode(() => inspect3mfArchive(empty))).toBe("MALFORMED_ARCHIVE");

    const archive = new Uint8Array(72);
    const view = new DataView(archive.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(28, 4, true);
    archive.set(new TextEncoder().encode("file"), 46);
    view.setUint32(50, 0x06054b50, true);
    view.setUint16(58, 1, true);
    view.setUint16(60, 1, true);
    view.setUint32(62, 51, true);
    expect(errorCode(() => inspect3mfArchive(archive))).toBe(
      "MALFORMED_ARCHIVE",
    );
  });

  it("rejects encrypted central-directory entries", () => {
    const zip = new Uint8Array(72);
    const view = new DataView(zip.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(8, 1, true);
    view.setUint16(28, 4, true);
    zip.set(new TextEncoder().encode("file"), 46);
    view.setUint32(50, 0x06054b50, true);
    view.setUint16(58, 1, true);
    view.setUint16(60, 1, true);
    view.setUint32(62, 50, true);
    view.setUint32(66, 0, true);
    expect(errorCode(() => inspect3mfArchive(zip))).toBe(
      "ARCHIVE_LIMIT_EXCEEDED",
    );
  });
});

function centralEntry(name: string): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const entry = new Uint8Array(46 + encoded.byteLength);
  const view = new DataView(entry.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(28, encoded.byteLength, true);
  entry.set(encoded, 46);
  return entry;
}

function endRecord(entries: number, directorySize: number): Uint8Array {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, entries, true);
  view.setUint16(10, entries, true);
  view.setUint32(12, directorySize, true);
  view.setUint32(16, 0, true);
  return record;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

describe("safe display filenames", () => {
  it("accepts ordinary names and rejects control characters", () => {
    expect(validateDisplayFilename("my part (final).stl")).toBe(
      "my part (final).stl",
    );
    expect(errorCode(() => validateDisplayFilename("part\u0000.stl"))).toBe(
      "UNSAFE_FILENAME",
    );
  });
});
