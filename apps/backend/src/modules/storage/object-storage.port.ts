/**
 * Provider-neutral object-storage boundary.  Callers deal only in verified
 * object metadata and short-lived URLs; S3 command types stay in the adapter.
 */
export const OBJECT_STORAGE = Symbol("OBJECT_STORAGE");

export class ObjectStorageDeadlineError extends Error {
  constructor(message = "signed object URL deadline must be in the future") {
    super(message);
    this.name = "ObjectStorageDeadlineError";
  }
}

export class ImmutableObjectConflictError extends Error {
  constructor(
    message = "immutable object key already contains different data",
  ) {
    super(message);
    this.name = "ImmutableObjectConflictError";
  }
}

export interface ObjectStorageUploadRequest {
  objectKey: string;
  contentType: string;
  contentHash: string;
  contentLength: number;
  expiresAt: Date;
}

export interface ObjectStorageDownloadRequest {
  objectKey: string;
  expiresAt: Date;
}

export interface SignedObjectUrl {
  url: string;
  method: "PUT" | "GET";
  requiredHeaders: Readonly<Record<string, string>>;
  expiresAt: Date;
}

export interface StoredObjectMetadata {
  contentType: string;
  contentLength: number;
  contentHash: string | null;
}

export interface ImmutableObjectWrite {
  objectKey: string;
  contentType: string;
  contentHash: string;
  bytes: Uint8Array;
}

export interface ObjectStorageListRequest {
  prefix: string;
  startAfter?: string;
  limit: number;
}

export interface StoredObjectSummary {
  objectKey: string;
  lastModified: Date;
}

export interface ObjectStorageListPage {
  objects: StoredObjectSummary[];
  isTruncated: boolean;
}

export interface ObjectStorage {
  putImmutableObject(input: ImmutableObjectWrite): Promise<void>;
  createUploadUrl(input: ObjectStorageUploadRequest): Promise<SignedObjectUrl>;
  createDownloadUrl(
    input: ObjectStorageDownloadRequest,
  ): Promise<SignedObjectUrl>;
  headObject(objectKey: string): Promise<StoredObjectMetadata | null>;
  readObjectRange(
    objectKey: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array>;
  copyObject(
    sourceObjectKey: string,
    destinationObjectKey: string,
  ): Promise<void>;
  deleteObjects(objectKeys: readonly string[]): Promise<void>;
  listObjects(input: ObjectStorageListRequest): Promise<ObjectStorageListPage>;
}
