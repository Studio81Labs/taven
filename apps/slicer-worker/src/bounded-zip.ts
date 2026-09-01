import { inflateRawSync } from "node:zlib";
import { SlicingWorkerError } from "./failures.js";

const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_LOCAL_FILE = 0x04034b50;

type InvalidZipCode = "INVALID_MODEL" | "INVALID_GEOMETRY";

type BoundedZipOptions = {
  label: string;
  invalidCode: InvalidZipCode;
  maximumEntries: number;
  maximumEntryBytes: number;
  maximumTotalBytes: number;
};

function invalid(options: BoundedZipOptions, message: string): never {
  throw new SlicingWorkerError(
    "deterministic_invalid",
    options.invalidCode,
    `${options.label} ${message}`,
  );
}

function safeArchivePath(name: string, options: BoundedZipOptions): string {
  const normalized = name.replace(/\\/gu, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    invalid(options, "contains an unsafe entry path");
  }
  return normalized;
}

export function readBoundedZipEntries(
  bytes: Uint8Array,
  options: BoundedZipOptions,
): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (
    let offset = Math.max(0, bytes.byteLength - 65_557);
    offset <= bytes.byteLength - 22;
    offset += 1
  ) {
    if (view.getUint32(offset, true) === ZIP_EOCD) eocd = offset;
  }
  if (eocd < 0) invalid(options, "has no end directory");
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    count < 1 ||
    count > options.maximumEntries ||
    directoryOffset + directorySize > eocd
  ) {
    invalid(options, "directory is invalid");
  }
  const entries = new Map<string, Uint8Array>();
  let offset = directoryOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (
      offset + 46 > eocd ||
      view.getUint32(offset, true) !== ZIP_CENTRAL_FILE
    ) {
      invalid(options, "central entry is invalid");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      uncompressedSize > options.maximumEntryBytes
    ) {
      invalid(options, "uses an unsupported entry encoding");
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > options.maximumTotalBytes) {
      throw new SlicingWorkerError(
        "deterministic_invalid",
        "RESOURCE_LIMIT_EXCEEDED",
        `${options.label} exceeds the decompressed byte limit`,
      );
    }
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd + extraLength + commentLength > eocd) {
      invalid(options, "entry exceeds its directory");
    }
    let rawName: string;
    try {
      rawName = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(offset + 46, nameEnd),
      );
    } catch {
      invalid(options, "entry name is not valid UTF-8");
    }
    const isDirectory = rawName!.endsWith("/");
    const name = safeArchivePath(
      isDirectory ? rawName!.slice(0, -1) : rawName!,
      options,
    );
    if (!isDirectory && entries.has(name)) {
      invalid(options, "contains duplicate entries");
    }
    if (
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== ZIP_LOCAL_FILE
    ) {
      invalid(options, "local entry is invalid");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > directoryOffset) {
      invalid(options, "entry data is truncated");
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    let contents: Uint8Array;
    try {
      contents =
        method === 0
          ? new Uint8Array(compressed)
          : inflateRawSync(compressed, {
              maxOutputLength: options.maximumEntryBytes,
            });
    } catch {
      invalid(options, "entry cannot be decompressed safely");
    }
    if (contents.byteLength !== uncompressedSize) {
      invalid(options, "entry size does not match its directory");
    }
    if (isDirectory) {
      if (contents.byteLength !== 0) {
        invalid(options, "directory entry contains data");
      }
    } else {
      entries.set(name, contents);
    }
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}
