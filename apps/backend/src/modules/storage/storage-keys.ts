const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const GENERATED_OBJECT_KEY_PATTERN =
  /^(?:quarantine|models|photos|qc|geometries|canonical|reference-slices|slices|gcode|reproduction-artifacts)\/[a-z0-9][a-z0-9:-]*(?:\/[a-z0-9][a-z0-9._:-]*)*$/;

function assertUuid(id: string, name: string): void {
  if (!UUID_PATTERN.test(id))
    throw new Error(`${name} must be a lowercase UUID`);
}

function key(prefix: string, id: string, leaf: string): string {
  assertUuid(id, `${prefix} ID`);
  const objectKey = `${prefix}/${id}/${leaf}`;
  assertStorageObjectKey(objectKey);
  return objectKey;
}

/** Reject path-like input before it reaches an S3 command or signed URL. */
export function assertStorageObjectKey(objectKey: string): void {
  if (
    !GENERATED_OBJECT_KEY_PATTERN.test(objectKey) ||
    objectKey.includes("..") ||
    objectKey.includes("\\") ||
    objectKey.startsWith("/")
  ) {
    throw new Error(
      "object storage keys must use a server-generated asset path",
    );
  }
}

export function quarantineObjectKey(uploadIntentId: string): string {
  assertUuid(uploadIntentId, "upload intent ID");
  const objectKey = `quarantine/${uploadIntentId}`;
  assertStorageObjectKey(objectKey);
  return objectKey;
}

export function modelSourceObjectKey(modelFileId: string): string {
  return key("models", modelFileId, "source");
}

export function photoOriginalObjectKey(photoAssetId: string): string {
  return key("photos", photoAssetId, "original");
}

export function photoThumbnailObjectKey(photoAssetId: string): string {
  return key("photos", photoAssetId, "thumbnail");
}

export function photoTransformObjectKey(photoAssetId: string): string {
  return key("photos", photoAssetId, "transform");
}

export function photoExifObjectKey(photoAssetId: string): string {
  return key("photos", photoAssetId, "exif.json");
}

export function canonicalGeometryObjectKey(geometryId: string): string {
  return key("geometries", geometryId, "canonical");
}

export function gcodeObjectKey(jobId: string): string {
  return key("gcode", jobId, "toolpath");
}

export function reproductionArtifactObjectKey(artifactId: string): string {
  return key("reproduction-artifacts", artifactId, "canonical");
}
