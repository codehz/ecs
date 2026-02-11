// A lightweight generic MultiMap implementation backed by Map<K, Set<V>>.
// Provides usual operations: add, remove, get, has, keys, values, entries,
// clear, deleteKey and size accessors.

class MultiMap<K, V> {
  private map: Map<K, Set<V>> = new Map();

  // Number of value entries across all keys (not number of keys).
  private _valueCount = 0;

  get valueCount(): number {
    return this._valueCount;
  }

  get keyCount(): number {
    return this.map.size;
  }

  hasKey(key: K): boolean {
    return this.map.has(key);
  }

  has(key: K, value?: V): boolean {
    const set = this.map.get(key);
    if (!set) return false;
    if (arguments.length === 1) return true;
    return set.has(value as V);
  }

  add(key: K, value: V): void {
    let set = this.map.get(key);
    if (!set) {
      set = new Set();
      this.map.set(key, set);
    }
    if (!set.has(value)) {
      set.add(value);
      this._valueCount++;
    }
  }

  // Remove a specific value for a key. Returns true if removed.
  remove(key: K, value: V): boolean {
    const set = this.map.get(key);
    if (!set) return false;
    if (!set.has(value)) return false;
    set.delete(value);
    this._valueCount--;
    if (set.size === 0) this.map.delete(key);
    return true;
  }

  // Delete entire key and all its values. Returns true if key existed.
  deleteKey(key: K): boolean {
    const set = this.map.get(key);
    if (!set) return false;
    this._valueCount -= set.size;
    this.map.delete(key);
    return true;
  }

  get(key: K): Set<V> {
    const set = this.map.get(key);
    return set ? new Set(set) : new Set();
  }

  // iterate keys, values and entries (key -> Set copy)
  *keys(): IterableIterator<K> {
    yield* this.map.keys();
  }

  *values(): IterableIterator<V> {
    for (const set of this.map.values()) {
      for (const v of set) yield v;
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  *entries(): IterableIterator<[K, V]> {
    for (const [k, set] of this.map.entries()) {
      for (const v of set) yield [k, v];
    }
  }

  clear(): void {
    this.map.clear();
    this._valueCount = 0;
  }
}

export { MultiMap };
