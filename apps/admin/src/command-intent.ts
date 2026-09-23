export class CommandIntent<Body, Result> {
  readonly key: string;
  readonly body: Readonly<Body>;
  private pending: Promise<Result> | null = null;

  constructor(body: Body, key: string = crypto.randomUUID()) {
    this.key = key;
    this.body = deepFreeze(structuredClone(body));
  }

  submit(
    send: (body: Readonly<Body>, key: string) => Promise<Result>,
  ): Promise<Result> {
    if (this.pending) return this.pending;
    const pending = send(this.body, this.key);
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      })
      .catch(() => undefined);
    return pending;
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
