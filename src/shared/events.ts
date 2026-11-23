import type { StoreListener, ValueListener } from "../types";

export class SimpleListeners<T = void> {
  private readonly listeners = new Set<StoreListener | ValueListener<T>>();

  subscribe(listener: T extends void ? StoreListener : ValueListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(...args: T extends void ? [] : [T]): void {
    for (const listener of this.listeners) {
      (listener as (...payload: unknown[]) => void)(...args);
    }
  }
}
