export const MAX_MODEL_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_LOCAL_PREVIEW_BYTES = 32 * 1024 * 1024;

export type DirectModelFormat = "STL" | "3MF";

export interface ValidatedModelFile {
  contentType: "model/stl" | "model/3mf";
  format: DirectModelFormat;
  originalFilename: string;
  sizeBytes: number;
}

export type ModelFileValidationCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "INDIVIDUAL_QUOTE_REQUIRED"
  | "UNSAFE_FILENAME"
  | "UNSUPPORTED_FORMAT";

export class ModelFileValidationError extends Error {
  constructor(
    readonly code: ModelFileValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelFileValidationError";
  }
}

function fileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

function validateFilename(filename: string): void {
  const hasControlCharacter = [...filename].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });

  if (
    filename.length === 0 ||
    filename.length > 255 ||
    filename === "." ||
    filename === ".." ||
    /[\\/]/u.test(filename) ||
    hasControlCharacter
  ) {
    throw new ModelFileValidationError(
      "UNSAFE_FILENAME",
      "Název souboru obsahuje nepovolené znaky.",
    );
  }
}

export function validateModelFile(
  file: Pick<File, "name" | "size">,
): ValidatedModelFile {
  validateFilename(file.name);

  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new ModelFileValidationError(
      "EMPTY_FILE",
      "Soubor je prázdný. Vyberte prosím jiný model.",
    );
  }
  if (file.size > MAX_MODEL_FILE_BYTES) {
    throw new ModelFileValidationError(
      "FILE_TOO_LARGE",
      "Soubor je větší než povolených 100 MiB.",
    );
  }

  const extension = fileExtension(file.name);
  if (extension === "step" || extension === "stp") {
    throw new ModelFileValidationError(
      "INDIVIDUAL_QUOTE_REQUIRED",
      "STEP zatím přímá kalkulace nepodporuje. Exportujte model jako STL nebo nebarvený 3MF.",
    );
  }
  if (extension === "obj") {
    throw new ModelFileValidationError(
      "UNSUPPORTED_FORMAT",
      "Formát OBJ nepodporujeme. Použijte STL nebo 3MF.",
    );
  }
  if (extension === "stl") {
    return {
      contentType: "model/stl",
      format: "STL",
      originalFilename: file.name,
      sizeBytes: file.size,
    };
  }
  if (extension === "3mf") {
    return {
      contentType: "model/3mf",
      format: "3MF",
      originalFilename: file.name,
      sizeBytes: file.size,
    };
  }

  throw new ModelFileValidationError(
    "UNSUPPORTED_FORMAT",
    "Tento formát nepodporujeme. Použijte STL nebo 3MF.",
  );
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
