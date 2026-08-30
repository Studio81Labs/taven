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
