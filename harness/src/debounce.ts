/**
 * Generic debouncer — accumulates items by key, flushes after a delay.
 * Used by the Slack adapter to combine rapid-fire messages.
 */
export class Debouncer<T> {
  private map = new Map<string, { items: T[]; timer: NodeJS.Timeout; metadata?: Record<string, unknown> }>();

  constructor(private delayMs: number) {}

  /**
   * Add an item to the debounce window for the given key.
   * On first item: starts a timer. On subsequent items: resets the timer.
   * When the timer fires: calls onFlush with all accumulated items + metadata.
   */
  debounce(
    key: string,
    item: T,
    onFlush: (items: T[], metadata?: Record<string, unknown>) => void,
    metadata?: Record<string, unknown>,
  ): void {
    const existing = this.map.get(key);

    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = setTimeout(() => {
        this.map.delete(key);
        onFlush(existing.items, existing.metadata);
      }, this.delayMs);
    } else {
      const entry = {
        items: [item],
        timer: setTimeout(() => {
          this.map.delete(key);
          onFlush(entry.items, entry.metadata);
        }, this.delayMs),
        metadata,
      };
      this.map.set(key, entry);
    }
  }

  /** Check if a key has a pending debounce. */
  has(key: string): boolean {
    return this.map.has(key);
  }
}
