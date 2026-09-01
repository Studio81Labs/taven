import { describe, expect, it } from "vitest";
import {
  MAX_MODEL_FILE_BYTES,
  formatFileSize,
  sha256Hex,
  validateModelFile,
} from "./model-file";

const candidate = (name: string, size = 1) => ({ name, size });

describe("model file validation", () => {
  it("maps supported extensions to canonical upload metadata", () => {
    expect(validateModelFile(candidate("Držák.STL", 42))).toEqual({
      contentType: "model/stl",
      format: "STL",
      originalFilename: "Držák.STL",
      sizeBytes: 42,
    });
    expect(validateModelFile(candidate("sestava.3mf", 84))).toMatchObject({
      contentType: "model/3mf",
      format: "3MF",
    });
  });

  it("distinguishes individual STEP handoff from unsupported formats", () => {
    expect(() => validateModelFile(candidate("part.step"))).toThrowError(
      expect.objectContaining({
        code: "INDIVIDUAL_QUOTE_REQUIRED",
      }),
    );
    expect(() => validateModelFile(candidate("part.obj"))).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_FORMAT",
      }),
    );
  });

  it("rejects empty, oversized, and unsafe files before issuing an upload", () => {
    expect(() => validateModelFile(candidate("part.stl", 0))).toThrowError(
      expect.objectContaining({ code: "EMPTY_FILE" }),
    );
    expect(() =>
      validateModelFile(candidate("part.stl", MAX_MODEL_FILE_BYTES + 1)),
    ).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
    expect(() => validateModelFile(candidate("../part.stl"))).toThrowError(
      expect.objectContaining({ code: "UNSAFE_FILENAME" }),
    );
  });
});

describe("model file helpers", () => {
  it("calculates a lower-case SHA-256 digest", async () => {
    const buffer = new TextEncoder().encode("abc").buffer;
    await expect(sha256Hex(buffer)).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("formats file sizes without using decimal megabytes", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1_536)).toBe("1.5 KiB");
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe("1.5 MiB");
  });
});
