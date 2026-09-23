export type CursorPage<Item> = Readonly<{
  items: readonly Item[];
  nextCursor: string | null;
}>;

export class CursorPager<Item> {
  items: readonly Item[] = [];
  nextCursor: string | null = null;
  private filterKey = "";
  private generation = 0;
  private controller: AbortController | null = null;
  private pendingMore: Promise<void> | null = null;

  constructor(
    private readonly load: (
      cursor: string | null,
      signal: AbortSignal,
    ) => Promise<CursorPage<Item>>,
  ) {}

  async reset(filterKey: string): Promise<void> {
    this.generation += 1;
    this.controller?.abort();
    this.pendingMore = null;
    this.items = [];
    this.nextCursor = null;
    this.filterKey = filterKey;
    await this.fetch(null, this.generation);
  }

  async more(): Promise<void> {
    if (this.pendingMore) return this.pendingMore;
    if (!this.nextCursor) return;
    const pending = this.fetch(this.nextCursor, this.generation);
    this.pendingMore = pending;
    try {
      await pending;
    } finally {
      if (this.pendingMore === pending) this.pendingMore = null;
    }
  }

  dispose(): void {
    this.generation += 1;
    this.controller?.abort();
    this.pendingMore = null;
    this.items = [];
    this.nextCursor = null;
  }

  private async fetch(
    cursor: string | null,
    generation: number,
  ): Promise<void> {
    const key = this.filterKey;
    const controller = new AbortController();
    this.controller = controller;
    let page: CursorPage<Item>;
    try {
      page = await this.load(cursor, controller.signal);
    } catch (error) {
      if (controller.signal.aborted || generation !== this.generation) return;
      throw error;
    }
    if (
      controller.signal.aborted ||
      generation !== this.generation ||
      key !== this.filterKey
    )
      return;
    this.items = cursor ? [...this.items, ...page.items] : page.items;
    this.nextCursor = page.nextCursor;
  }
}
