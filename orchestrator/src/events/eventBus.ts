export type Listener<T> = (payload: T) => void;

/**
 * Minimal typed pub-sub. Agents never call each other; the orchestrator's
 * decisions are observable as events instead of only a function's return
 * value, so a logger, a UI, or a differently-hosted agent runner can all
 * listen without being wired into a call chain.
 */
export class EventBus<EventMap extends object> {
  private listeners: { [K in keyof EventMap]?: Listener<EventMap[K]>[] } = {};

  on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): () => void {
    (this.listeners[event] ??= []).push(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): void {
    const arr = this.listeners[event];
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx !== -1) arr.splice(idx, 1);
  }

  emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    for (const l of this.listeners[event] ?? []) l(payload);
  }
}
