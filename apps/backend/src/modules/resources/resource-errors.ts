export class ResourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceValidationError";
  }
}

export class ResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceNotFoundError";
  }
}

export class ResourceConflictError extends Error {
  readonly constraint: string | undefined;

  constructor(message: string, constraint?: string) {
    super(message);
    this.name = "ResourceConflictError";
    this.constraint = constraint;
  }
}

export class ResourceSnapshotIntegrityError extends Error {
  constructor(message = "catalog revision snapshot verification failed") {
    super(message);
    this.name = "ResourceSnapshotIntegrityError";
  }
}

export class ResourceSnapshotUnavailableError extends Error {
  constructor(
    message = "catalog revision snapshot verification is unavailable",
  ) {
    super(message);
    this.name = "ResourceSnapshotUnavailableError";
  }
}
