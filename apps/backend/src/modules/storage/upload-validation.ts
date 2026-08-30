import { Buffer } from "node:buffer";

export const MAX_MODEL_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_PHOTO_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_3MF_ENTRIES = 1_024;
export const MAX_3MF_TOTAL_SIZE = 512 * 1024 * 1024;
export const MAX_3MF_ENTRY_SIZE = 128 * 1024 * 1024;
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
  if (typeof input.extension !== "string")
    fail("UNSUPPORTED_FORMAT", `Unsupported ${kind} file format`, "extension");
  const extension = normalizeExtension(input.extension);
  const spec = (kind === "model" ? MODEL_FORMATS : PHOTO_FORMATS)[extension];
  if (!spec)
    fail("UNSUPPORTED_FORMAT", `Unsupported ${kind} file format`, "extension");
  if (typeof input.contentType !== "string")
    fail(
      "CONTENT_TYPE_MISMATCH",
      "contentType does not match the file format",
      "contentType",
    );
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
  if (input.format !== undefined && typeof input.format !== "string")
    fail("UNSUPPORTED_FORMAT", "format does not match extension", "format");
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

export interface ThreeMfEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  expandedSize: number;
  localHeaderOffset: number;
}

export interface ThreeMfDirectoryInspection extends ThreeMfInspection {
  localEntries: ThreeMfEntry[];
}

export interface ThreeMfLocalEntryInspection {
  start: number;
  dataOffset: number;
  dataEnd: number;
  usesDataDescriptor: boolean;
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
    eocd + 22 + commentLength !== bytes.length ||
    cdSize < entries * 46
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
  centralDirectoryOffset?: number,
): ThreeMfDirectoryInspection {
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
  const names = new Set<string>();
  const localEntries: ThreeMfEntry[] = [];
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50)
      fail("MALFORMED_ARCHIVE", "Malformed 3MF central directory");
    const flags = u16(bytes, offset + 8);
    const compressionMethod = u16(bytes, offset + 10);
    const crc32 = u32(bytes, offset + 16);
    const compressed = u32(bytes, offset + 20);
    const expanded = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const diskStart = u16(bytes, offset + 34);
    const localHeaderOffset = u32(bytes, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (
      end > bytes.length ||
      (flags & 1) !== 0 ||
      compressed === 0xffffffff ||
      expanded === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      expanded > MAX_3MF_ENTRY_SIZE ||
      expandedBytes > MAX_3MF_TOTAL_SIZE - expanded
    )
      fail("ARCHIVE_LIMIT_EXCEEDED", "3MF ZIP entry exceeds expansion limits");
    if (
      diskStart !== 0 ||
      ![0, 8].includes(compressionMethod) ||
      (centralDirectoryOffset !== undefined &&
        localHeaderOffset + 30 > centralDirectoryOffset)
    )
      fail("MALFORMED_ARCHIVE", "3MF ZIP entry location is invalid");
    const nameBytes = bytes.slice(offset + 46, offset + 46 + nameLength);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      fail("ARCHIVE_UNSAFE_PATH", "3MF ZIP entry has an invalid name");
    }
    if (
      name.length === 0 ||
      name.includes("\u0000") ||
      name.startsWith("/") ||
      name.startsWith("\\") ||
      name.includes("\\") ||
      /^[A-Za-z]:[\\/]/u.test(name) ||
      name.split(/[\\/]/u).some((part) => part === "..")
    )
      fail("ARCHIVE_UNSAFE_PATH", "3MF ZIP entry has an unsafe path");
    if (names.has(name))
      fail("MALFORMED_ARCHIVE", "3MF ZIP contains duplicate entry names");
    names.add(name);
    validateZipExtraFields(
      bytes.subarray(
        offset + 46 + nameLength,
        offset + 46 + nameLength + extraLength,
      ),
    );
    if (compressionMethod === 0 && compressed !== expanded)
      fail("MALFORMED_ARCHIVE", "Stored 3MF ZIP entry sizes are inconsistent");
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
    localEntries.push({
      name,
      nameBytes,
      flags,
      compressionMethod,
      crc32,
      compressedSize: compressed,
      expandedSize: expanded,
      localHeaderOffset,
    });
    expandedBytes += expanded;
    offset = end;
  }
  if (offset !== bytes.length)
    fail("MALFORMED_ARCHIVE", "3MF central directory size is inconsistent");
  if (!hasContentTypes || !hasModel)
    fail("MALFORMED_ARCHIVE", "3MF ZIP is missing required model entries");
  return { entries, expandedBytes, localEntries };
}

export function threeMfLocalHeaderSize(input: Uint8Array): number {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength !== 30 || u32(bytes, 0) !== 0x04034b50)
    fail("MALFORMED_ARCHIVE", "3MF ZIP local header is malformed");
  return 30 + u16(bytes, 26) + u16(bytes, 28);
}

export function inspect3mfLocalEntryHeader(
  input: Uint8Array,
  expected: ThreeMfEntry,
  centralDirectoryOffset: number,
): ThreeMfLocalEntryInspection {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const headerSize = threeMfLocalHeaderSize(bytes.subarray(0, 30));
  if (bytes.byteLength !== headerSize)
    fail("MALFORMED_ARCHIVE", "3MF ZIP local header size is inconsistent");

  const flags = u16(bytes, 6);
  const compressionMethod = u16(bytes, 8);
  const crc32 = u32(bytes, 14);
  const compressedSize = u32(bytes, 18);
  const expandedSize = u32(bytes, 22);
  const nameLength = u16(bytes, 26);
  const nameBytes = bytes.subarray(30, 30 + nameLength);
  const extraBytes = bytes.subarray(30 + nameLength);
  if (
    flags !== expected.flags ||
    compressionMethod !== expected.compressionMethod ||
    !Buffer.from(nameBytes).equals(Buffer.from(expected.nameBytes))
  )
    fail(
      "MALFORMED_ARCHIVE",
      "3MF ZIP local header conflicts with its directory entry",
    );
  validateZipExtraFields(extraBytes);

  const usesDataDescriptor = (flags & 0x0008) !== 0;
  if (usesDataDescriptor) {
    if (
      ![0, expected.crc32].includes(crc32) ||
      ![0, expected.compressedSize].includes(compressedSize) ||
      ![0, expected.expandedSize].includes(expandedSize)
    )
      fail(
        "MALFORMED_ARCHIVE",
        "3MF ZIP streamed local sizes conflict with its directory entry",
      );
  } else if (
    crc32 !== expected.crc32 ||
    compressedSize !== expected.compressedSize ||
    expandedSize !== expected.expandedSize
  ) {
    fail(
      "MALFORMED_ARCHIVE",
      "3MF ZIP local sizes conflict with its directory entry",
    );
  }

  const dataOffset = expected.localHeaderOffset + headerSize;
  const dataEnd = dataOffset + expected.compressedSize;
  if (
    !Number.isSafeInteger(dataEnd) ||
    dataOffset > centralDirectoryOffset ||
    dataEnd > centralDirectoryOffset
  )
    fail(
      "MALFORMED_ARCHIVE",
      "3MF ZIP entry data overlaps its central directory",
    );
  return {
    start: expected.localHeaderOffset,
    dataOffset,
    dataEnd,
    usesDataDescriptor,
  };
}

export function inspect3mfDataDescriptor(
  input: Uint8Array,
  expected: ThreeMfEntry,
): number {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const hasSignature = bytes.byteLength >= 4 && u32(bytes, 0) === 0x08074b50;
  const descriptorSize = hasSignature ? 16 : 12;
  const valueOffset = hasSignature ? 4 : 0;
  if (
    bytes.byteLength < descriptorSize ||
    u32(bytes, valueOffset) !== expected.crc32 ||
    u32(bytes, valueOffset + 4) !== expected.compressedSize ||
    u32(bytes, valueOffset + 8) !== expected.expandedSize
  )
    fail("MALFORMED_ARCHIVE", "3MF ZIP data descriptor is inconsistent");
  return descriptorSize;
}

export function validate3mfLocalEntryRanges(
  ranges: ReadonlyArray<{ start: number; end: number }>,
): void {
  const ordered = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous && current && current.start < previous.end)
      fail("MALFORMED_ARCHIVE", "3MF ZIP local entries overlap");
  }
}

function validateZipExtraFields(bytes: Uint8Array): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength)
      fail("MALFORMED_ARCHIVE", "3MF ZIP extra field is malformed");
    const fieldId = u16(bytes, offset);
    const fieldLength = u16(bytes, offset + 2);
    offset += 4;
    if (offset + fieldLength > bytes.byteLength)
      fail("MALFORMED_ARCHIVE", "3MF ZIP extra field is malformed");
    if (fieldId === 0x0001 || fieldId === 0x7075)
      fail(
        "MALFORMED_ARCHIVE",
        "3MF ZIP uses an unsupported alternate entry identity",
      );
    offset += fieldLength;
  }
}

export function inspect3mfArchive(input: Uint8Array): ThreeMfInspection {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const end = inspect3mfEndRecord(bytes);
  const directory = inspect3mfCentralDirectory(
    bytes.subarray(
      end.centralDirectoryOffset,
      end.centralDirectoryOffset + end.centralDirectorySize,
    ),
    end.entries,
    end.centralDirectoryOffset,
  );
  const ranges: Array<{ start: number; end: number }> = [];
  for (const entry of directory.localEntries) {
    const fixed = bytes.subarray(
      entry.localHeaderOffset,
      entry.localHeaderOffset + 30,
    );
    const headerSize = threeMfLocalHeaderSize(fixed);
    const header = bytes.subarray(
      entry.localHeaderOffset,
      entry.localHeaderOffset + headerSize,
    );
    const local = inspect3mfLocalEntryHeader(
      header,
      entry,
      end.centralDirectoryOffset,
    );
    let rangeEnd = local.dataEnd;
    if (local.usesDataDescriptor) {
      const available = Math.min(16, end.centralDirectoryOffset - rangeEnd);
      rangeEnd += inspect3mfDataDescriptor(
        bytes.subarray(rangeEnd, rangeEnd + available),
        entry,
      );
    }
    ranges.push({ start: local.start, end: rangeEnd });
  }
  validate3mfLocalEntryRanges(ranges);
  return { entries: directory.entries, expandedBytes: directory.expandedBytes };
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
