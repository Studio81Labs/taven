export const MAX_QUOTE_PHOTO_BYTES = 20 * 1024 * 1024;

export type QuotePhotoContentType = "image/jpeg" | "image/png" | "image/webp";

export interface ValidatedQuotePhoto {
  contentType: QuotePhotoContentType;
  originalFilename: string;
  sizeBytes: number;
}

export type QuotePhotoValidationCode =
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "TYPE_MISMATCH"
  | "UNSAFE_FILENAME"
  | "UNSUPPORTED_TYPE";

export class QuotePhotoValidationError extends Error {
  constructor(
    readonly code: QuotePhotoValidationCode,
    message: string,
  ) {
    super(message);
    this.name = "QuotePhotoValidationError";
  }
}

const extensionTypes: Readonly<Record<string, QuotePhotoContentType>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function validateQuotePhoto(
  file: Pick<File, "name" | "size" | "type">,
): ValidatedQuotePhoto {
  validateFilename(file.name);
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new QuotePhotoValidationError(
      "EMPTY_FILE",
      "Fotografie je prázdná. Vyberte prosím jiný soubor.",
    );
  }
  if (file.size > MAX_QUOTE_PHOTO_BYTES) {
    throw new QuotePhotoValidationError(
      "FILE_TOO_LARGE",
      "Jedna fotografie může mít nejvýše 20 MiB.",
    );
  }

  const extension = file.name
    .slice(file.name.lastIndexOf(".") + 1)
    .toLowerCase();
  const extensionType = extensionTypes[extension];
  const declaredType = normalizedContentType(file.type);
  if (!extensionType && !declaredType) {
    throw new QuotePhotoValidationError(
      "UNSUPPORTED_TYPE",
      "Přijímáme fotografie JPG, PNG nebo WebP.",
    );
  }
  if (extensionType && declaredType && extensionType !== declaredType) {
    throw new QuotePhotoValidationError(
      "TYPE_MISMATCH",
      "Přípona fotografie neodpovídá jejímu typu.",
    );
  }
  return {
    contentType: declaredType ?? extensionType!,
    originalFilename: file.name,
    sizeBytes: file.size,
  };
}

function normalizedContentType(
  value: string,
): QuotePhotoContentType | undefined {
  const normalized = value.trim().toLowerCase().split(";", 1)[0];
  return normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/webp"
    ? normalized
    : undefined;
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
    throw new QuotePhotoValidationError(
      "UNSAFE_FILENAME",
      "Název fotografie obsahuje nepovolené znaky.",
    );
  }
}
