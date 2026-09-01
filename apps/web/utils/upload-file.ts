export type UploadFailureCode = "ABORTED" | "NETWORK" | "REJECTED";

export class UploadFailure extends Error {
  constructor(
    readonly code: UploadFailureCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UploadFailure";
  }
}

export interface UploadFileOptions {
  file: Blob;
  onProgress?: (percentage: number) => void;
  requiredHeaders: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  uploadUrl: string;
  xhrFactory?: () => XMLHttpRequest;
}

export function uploadFile({
  file,
  onProgress,
  requiredHeaders,
  signal,
  uploadUrl,
  xhrFactory = () => new XMLHttpRequest(),
}: UploadFileOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = xhrFactory();
    let settled = false;

    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      action();
    };
    const abort = (): void => xhr.abort();

    xhr.open("PUT", uploadUrl, true);
    for (const [name, value] of Object.entries(requiredHeaders)) {
      if (name.toLowerCase() === "content-length") {
        if (Number(value) !== file.size) {
          finish(() =>
            reject(
              new UploadFailure(
                "REJECTED",
                "Velikost souboru neodpovídá podmínkám nahrání.",
              ),
            ),
          );
          return;
        }
        // Browsers set Content-Length from the Blob and forbid JavaScript from
        // assigning this signed header directly.
        continue;
      }
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress?.(
          Math.min(100, Math.round((event.loaded / event.total) * 100)),
        );
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        finish(resolve);
      } else {
        finish(() =>
          reject(
            new UploadFailure(
              "REJECTED",
              "Úložiště soubor odmítlo. Zkuste nahrání znovu.",
              xhr.status,
            ),
          ),
        );
      }
    });
    xhr.addEventListener("error", () => {
      finish(() =>
        reject(
          new UploadFailure(
            "NETWORK",
            "Nahrání přerušila síťová chyba. Soubor můžete odeslat znovu.",
          ),
        ),
      );
    });
    xhr.addEventListener("abort", () => {
      finish(() =>
        reject(new UploadFailure("ABORTED", "Nahrání bylo zrušeno.")),
      );
    });

    if (signal?.aborted) {
      xhr.abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
