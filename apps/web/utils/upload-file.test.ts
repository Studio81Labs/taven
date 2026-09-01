import { describe, expect, it, vi } from "vitest";
import { uploadFile } from "./upload-file";

type Listener = (event: ProgressEvent) => void;

class FakeXhr {
  readonly headers: Record<string, string> = {};
  readonly listeners = new Map<string, Listener>();
  readonly uploadListeners = new Map<string, Listener>();
  readonly upload = {
    addEventListener: (name: string, listener: Listener) => {
      this.uploadListeners.set(name, listener);
    },
  };
  body?: Blob;
  completeOnSend = true;
  method?: string;
  status = 200;
  url?: string;

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, listener);
  }
  abort(): void {
    this.listeners.get("abort")?.({} as ProgressEvent);
  }
  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  send(body: Blob): void {
    this.body = body;
    this.uploadListeners.get("progress")?.({
      lengthComputable: true,
      loaded: body.size / 2,
      total: body.size,
    } as ProgressEvent);
    if (this.completeOnSend) {
      this.listeners.get("load")?.({} as ProgressEvent);
    }
  }
  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }
}

describe("direct object-storage upload", () => {
  it("uses PUT, signed headers, browser content length, and progress", async () => {
    const xhr = new FakeXhr();
    const progress = vi.fn();
    const file = new Blob(["model"]);
    await uploadFile({
      file,
      onProgress: progress,
      requiredHeaders: {
        "content-length": String(file.size),
        "content-type": "model/stl",
        "x-amz-checksum-sha256": "checksum",
      },
      uploadUrl: "https://storage.example/upload",
      xhrFactory: () => xhr as unknown as XMLHttpRequest,
    });

    expect(xhr).toMatchObject({
      body: file,
      method: "PUT",
      url: "https://storage.example/upload",
    });
    expect(xhr.headers).toEqual({
      "content-type": "model/stl",
      "x-amz-checksum-sha256": "checksum",
    });
    expect(progress).toHaveBeenCalledWith(50);
  });

  it("rejects a signed content length that differs from the Blob", async () => {
    const xhr = new FakeXhr();
    await expect(
      uploadFile({
        file: new Blob(["model"]),
        requiredHeaders: { "content-length": "999" },
        uploadUrl: "https://storage.example/upload",
        xhrFactory: () => xhr as unknown as XMLHttpRequest,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "REJECTED" }));
    expect(xhr.body).toBeUndefined();
  });

  it("maps HTTP rejection and cancellation into retryable failures", async () => {
    const rejectedXhr = new FakeXhr();
    rejectedXhr.status = 403;
    await expect(
      uploadFile({
        file: new Blob(["model"]),
        requiredHeaders: {},
        uploadUrl: "https://storage.example/upload",
        xhrFactory: () => rejectedXhr as unknown as XMLHttpRequest,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "REJECTED", status: 403 }),
    );

    const cancelledXhr = new FakeXhr();
    cancelledXhr.completeOnSend = false;
    const controller = new AbortController();
    const pending = uploadFile({
      file: new Blob(["model"]),
      requiredHeaders: {},
      signal: controller.signal,
      uploadUrl: "https://storage.example/upload",
      xhrFactory: () => cancelledXhr as unknown as XMLHttpRequest,
    });
    controller.abort();
    await expect(pending).rejects.toEqual(
      expect.objectContaining({ code: "ABORTED" }),
    );
  });
});
