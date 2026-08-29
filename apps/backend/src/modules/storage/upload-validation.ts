import { Buffer } from "node:buffer";

export const MAX_MODEL_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_PHOTO_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_3MF_ENTRIES = 1_024;
const MAX_3MF_TOTAL_SIZE = 512 * 1024 * 1024;
const MAX_3MF_ENTRY_SIZE = 128 * 1024 * 1024;
export const MAX_3MF_CENTRAL_DIRECTORY_SIZE = 8 * 1024 * 1024;
export const MAX_ZIP_END_RECORD_SIZE = 65_557;

export type UploadKind = "model" | "photo";
export type ModelFormat = "STL" | "STEP" | "3MF";
export type PhotoFormat = "JPEG" | "PNG" | "WEBP";
export type UploadFormat = ModelFormat | PhotoFormat;

export interface UploadMetadataInput {
  scopeId: string;
  extension: string;
  format?: string;
  contentType: string;
  sha256: string;
  sizeBytes: number;
  displayFilename: string;
}

export interface ValidatedUploadMetadata extends Omit<
  UploadMetadataInput,
  "extension" | "format" | "contentType" | "sha256"
> {
  extension: string;
  format: UploadFormat;
  contentType: string;
  sha256: string;
  kind: UploadKind;
  maxSizeBytes: number;
}

export type UploadValidationCode =
  | "INVALID_SCOPE_ID"
  | "UNSUPPORTED_FORMAT"
  | "CONTENT_TYPE_MISMATCH"
  | "INVALID_SHA256"
  | "INVALID_SIZE"
  | "SIZE_LIMIT_EXCEEDED"
  | "UNSAFE_FILENAME"
  | "INVALID_SIGNATURE"
  | "MALFORMED_ARCHIVE"
  | "ARCHIVE_LIMIT_EXCEEDED"
  | "ARCHIVE_UNSAFE_PATH";

export class UploadValidationError extends Error {
  readonly code: UploadValidationCode;
  readonly field: string | undefined;

  constructor(code: UploadValidationCode, message: string, field?: string) {
    super(message);
    this.name = "UploadValidationError";
    this.code = code;
    this.field = field;
  }
}

const MODEL_FORMATS: Record<
  string,
  { format: ModelFormat; contentTypes: readonly string[] }
> = {
  stl: {
    format: "STL",
    contentTypes: ["model/stl", "application/sla", "application/octet-stream"],
  },
  step: {
    format: "STEP",
    contentTypes: [
      "model/step",
      "application/step",
      "application/octet-stream",
    ],
  },
  stp: {
    format: "STEP",
    contentTypes: [
      "model/step",
      "application/step",
      "application/octet-stream",
    ],
  },
  "3mf": {
    format: "3MF",
    contentTypes: [
      "model/3mf",
      "model/3mf+zip",
      "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
      "application/zip",
    ],
  },
};
const PHOTO_FORMATS: Record<
  string,
  { format: PhotoFormat; contentTypes: readonly string[] }
> = {
  jpg: { format: "JPEG", contentTypes: ["image/jpeg"] },
  jpeg: { format: "JPEG", contentTypes: ["image/jpeg"] },
  png: { format: "PNG", contentTypes: ["image/png"] },
  webp: { format: "WEBP", contentTypes: ["image/webp"] },
};

function fail(
  code: UploadValidationCode,
  message: string,
  field?: string,
): never {
  throw new UploadValidationError(code, message, field);
}

function normalizeExtension(extension: string): string {
  return extension.trim().toLowerCase().replace(/^\./, "");
}

export function validateScopeId(scopeId: unknown): string {
  if (
    typeof scopeId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      scopeId,
    )
  ) {
    fail("INVALID_SCOPE_ID", "scopeId must be a UUID", "scopeId");
  }
  return scopeId.toLowerCase();
}

export function validateDisplayFilename(filename: unknown): string {
  if (
    typeof filename !== "string" ||
    filename.length === 0 ||
    filename.length > 255 ||
    filename === "." ||
    filename === ".."
  ) {
    fail(
      "UNSAFE_FILENAME",
      "displayFilename must be a non-empty safe filename",
      "displayFilename",
    );
  }
  const hasControlCharacter = [...filename].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
  if (
    /[\\/]/u.test(filename) ||
    hasControlCharacter ||
    filename.split(/[\\/]/u).some((part) => part === "..")
  ) {
    fail(
      "UNSAFE_FILENAME",
      "displayFilename contains an unsafe path or control character",
      "displayFilename",
    );
  }
  return filename;
}

export function validateUploadMetadata(
  input: UploadMetadataInput,
  kind: UploadKind,
): ValidatedUploadMetadata {
  const scopeId = validateScopeId(input.scopeId);
  const extension = normalizeExtension(input.extension);
  const spec = (kind === "model" ? MODEL_FORMATS : PHOTO_FORMATS)[extension];
  if (!spec)
    fail("UNSUPPORTED_FORMAT", `Unsupported ${kind} file format`, "extension");
  const contentType =
    input.contentType.trim().toLowerCase().split(";", 1)[0] ?? "";
  if (!spec.contentTypes.includes(contentType))
    fail(
      "CONTENT_TYPE_MISMATCH",
      "contentType does not match the file format",
      "contentType",
    );
  const sha256 = typeof input.sha256 === "string" ? input.sha256 : "";
  if (!/^[0-9a-f]{64}$/.test(sha256))
    fail(
      "INVALID_SHA256",
      "sha256 must be a lower-case 64-character hexadecimal SHA-256",
      "sha256",
    );
  const maxSizeBytes =
    kind === "model" ? MAX_MODEL_SIZE_BYTES : MAX_PHOTO_SIZE_BYTES;
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0)
    fail("INVALID_SIZE", "sizeBytes must be a positive integer", "sizeBytes");
  if (input.sizeBytes > maxSizeBytes)
    fail(
      "SIZE_LIMIT_EXCEEDED",
      `sizeBytes exceeds the ${kind} limit`,
      "sizeBytes",
    );
  const displayFilename = validateDisplayFilename(input.displayFilename);
  if (
    input.format !== undefined &&
    normalizeExtension(input.format) !== extension &&
    input.format.toUpperCase() !== spec.format
  ) {
    fail("UNSUPPORTED_FORMAT", "format does not match extension", "format");
  }
  return {
    ...input,
    scopeId,
    extension,
    format: spec.format,
    contentType,
    sha256,
    displayFilename,
    kind,
    maxSizeBytes,
  };
}

export function validateModelUploadMetadata(
  input: UploadMetadataInput,
): ValidatedUploadMetadata {
  return validateUploadMetadata(input, "model");
}

export function validatePhotoUploadMetadata(
  input: UploadMetadataInput,
): ValidatedUploadMetadata {
  return validateUploadMetadata(input, "photo");
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}
function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) * 0x1000000)) >>>
    0
  );
}

export interface ThreeMfInspection {
  entries: number;
  expandedBytes: number;
}

export interface ThreeMfEndRecord {
  entries: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
}

export function inspect3mfEndRecord(
  input: Uint8Array,
  archiveSize = input.byteLength,
  inputOffset = 0,
): ThreeMfEndRecord {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (archiveSize < 22 || bytes.length < 22)
    fail("MALFORMED_ARCHIVE", "3MF is too small to be a ZIP archive");
  if (
    !Number.isSafeInteger(archiveSize) ||
    !Number.isSafeInteger(inputOffset) ||
    inputOffset < 0 ||
    inputOffset + bytes.length !== archiveSize
  )
    fail("MALFORMED_ARCHIVE", "3MF ZIP range is inconsistent");
  const start = Math.max(0, bytes.length - MAX_ZIP_END_RECORD_SIZE);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= start; i--)
    if (
      u32(bytes, i) === 0x06054b50 &&
      i + 22 <= bytes.length &&
      i + 22 + u16(bytes, i + 20) === bytes.length
    ) {
      eocd = i;
      break;
    }
  if (eocd < 0 || eocd + 22 > bytes.length)
    fail("MALFORMED_ARCHIVE", "3MF is missing a valid ZIP end record");
  const disk = u16(bytes, eocd + 4);
  const cdDisk = u16(bytes, eocd + 6);
  const diskEntries = u16(bytes, eocd + 8);
  const entries = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  const commentLength = u16(bytes, eocd + 20);
  if (entries === 0) fail("MALFORMED_ARCHIVE", "3MF ZIP has no entries");
  if (
    disk !== 0 ||
    cdDisk !== 0 ||
    diskEntries !== entries ||
    entries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff ||
    cdSize > MAX_3MF_CENTRAL_DIRECTORY_SIZE ||
    entries > MAX_3MF_ENTRIES
  )
    fail(
      "ARCHIVE_LIMIT_EXCEEDED",
      "3MF ZIP directory is unsupported or exceeds limits",
    );
  if (
    cdOffset + cdSize !== inputOffset + eocd ||
    eocd + 22 + commentLength !== bytes.length
  )
    fail("MALFORMED_ARCHIVE", "3MF ZIP directory boundary is inconsistent");
  return {
    entries,
    centralDirectoryOffset: cdOffset,
    centralDirectorySize: cdSize,
  };
}

export function inspect3mfCentralDirectory(
  input: Uint8Array,
  entries: number,
): ThreeMfInspection {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (
    !Number.isSafeInteger(entries) ||
    entries < 1 ||
    entries > MAX_3MF_ENTRIES ||
    bytes.byteLength > MAX_3MF_CENTRAL_DIRECTORY_SIZE
  )
    fail(
      "ARCHIVE_LIMIT_EXCEEDED",
      "3MF ZIP directory is unsupported or exceeds limits",
    );
  let offset = 0;
  let expandedBytes = 0;
  let hasContentTypes = false;
  let hasModel = false;
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50)
      fail("MALFORMED_ARCHIVE", "Malformed 3MF central directory");
    const flags = u16(bytes, offset + 8);
    const compressed = u32(bytes, offset + 20);
    const expanded = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (
      end > bytes.length ||
      (flags & 1) !== 0 ||
      compressed === 0xffffffff ||
      expanded === 0xffffffff ||
      expanded > MAX_3MF_ENTRY_SIZE ||
      expandedBytes > MAX_3MF_TOTAL_SIZE - expanded
    )
      fail("ARCHIVE_LIMIT_EXCEEDED", "3MF ZIP entry exceeds expansion limits");
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      );
    } catch {
      fail("ARCHIVE_UNSAFE_PATH", "3MF ZIP entry has an invalid name");
    }
    if (
      name.startsWith("/") ||
      name.startsWith("\\") ||
      name.includes("\\") ||
      /^[A-Za-z]:[\\/]/u.test(name) ||
      name.split(/[\\/]/u).some((part) => part === "..")
    )
      fail("ARCHIVE_UNSAFE_PATH", "3MF ZIP entry has an unsafe path");
    if (
      (compressed === 0 && expanded > 0) ||
      (compressed > 0 && expanded / compressed > 100)
    )
      fail(
        "ARCHIVE_LIMIT_EXCEEDED",
        "3MF ZIP entry has an excessive compression ratio",
      );
    hasContentTypes ||= name === "[Content_Types].xml";
    hasModel ||= /^3D\/[^/]+\.model$/u.test(name);
    expandedBytes += expanded;
    offset = end;
  }
  if (offset !== bytes.length)
    fail("MALFORMED_ARCHIVE", "3MF central directory size is inconsistent");
  if (!hasContentTypes || !hasModel)
    fail("MALFORMED_ARCHIVE", "3MF ZIP is missing required model entries");
  return { entries, expandedBytes };
}

export function inspect3mfArchive(input: Uint8Array): ThreeMfInspection {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const end = inspect3mfEndRecord(bytes);
  return inspect3mfCentralDirectory(
    bytes.subarray(
      end.centralDirectoryOffset,
      end.centralDirectoryOffset + end.centralDirectorySize,
    ),
    end.entries,
  );
}

export function validateFileSignature(
  format: UploadFormat | string,
  input: Uint8Array,
  totalSize = input.byteLength,
): void {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const normalized = format.toUpperCase() as UploadFormat;
  let valid = false;
  if (normalized === "JPEG")
    valid =
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff;
  else if (normalized === "PNG")
    valid =
      bytes.length >= 8 &&
      Buffer.from(bytes.subarray(0, 8)).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
  else if (normalized === "WEBP")
    valid =
      bytes.length >= 12 &&
      Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
      Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
  else if (normalized === "STEP")
    valid = Buffer.from(bytes.subarray(0, 21))
      .toString("ascii")
      .startsWith("ISO-10303-21;");
  else if (normalized === "STL")
    valid =
      (bytes.length >= 84 && 84 + u32(bytes, 80) * 50 === totalSize) ||
      /^\s*solid(?:\s|$)/u.test(
        Buffer.from(bytes.subarray(0, 512)).toString("ascii"),
      );
  else if (normalized === "3MF") {
    try {
      inspect3mfArchive(bytes);
      valid = true;
    } catch (error) {
      if (error instanceof UploadValidationError) throw error;
    }
  }
  if (!valid)
    fail("INVALID_SIGNATURE", `File bytes do not match ${format} signature`);
}

export function validateUploadContent(
  metadata: ValidatedUploadMetadata,
  input: Uint8Array,
): void {
  if (input.byteLength !== metadata.sizeBytes)
    fail(
      "INVALID_SIZE",
      "Content length does not match sizeBytes",
      "sizeBytes",
    );
  validateFileSignature(metadata.format, input);
}
