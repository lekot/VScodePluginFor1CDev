/**
 * Generic reference table for DAP protocol.
 *
 * Maps 1-based integer references (variablesReference, frameId) to typed data.
 * IDs grow monotonically — freed IDs are never reused, so stale references
 * returned by clients are always safe to look up (returns undefined).
 *
 * Node is single-threaded, so no locking is needed.
 */
export class ReferencesTable<T> {
  private readonly _map = new Map<number, T>();
  private _counter = 0;

  /**
   * Store an item and return its 1-based reference id.
   * The id is suitable for use as DAP variablesReference / frameId (> 0).
   */
  add(item: T): number {
    this._counter++;
    this._map.set(this._counter, item);
    return this._counter;
  }

  /**
   * Retrieve an item by reference id.
   * Returns undefined if the id was never assigned or was cleared.
   */
  get(reference: number): T | undefined {
    return this._map.get(reference);
  }

  /**
   * Clear items from the table.
   * - If no predicate is supplied, removes all entries.
   * - If a predicate is supplied, removes only entries where predicate(item) is true.
   * The internal counter is NOT reset — new ids after clear will not collide with
   * previously issued ids.
   */
  clear(predicate?: (item: T) => boolean): void {
    if (predicate === undefined) {
      this._map.clear();
    } else {
      for (const [ref, item] of this._map) {
        if (predicate(item)) {
          this._map.delete(ref);
        }
      }
    }
  }

  /** Number of items currently in the table. */
  get size(): number {
    return this._map.size;
  }
}
