export class BitSet {
  private data: Uint32Array;
  private _length: number;

  constructor(length: number) {
    this._length = length;
    const numWords = Math.ceil(length / 32);
    this.data = new Uint32Array(numWords);
  }

  get length(): number {
    return this._length;
  }

  has(index: number): boolean {
    if (index < 0 || index >= this._length) return false;
    const word = index >>> 5; // divide by 32
    const bit = index & 31;
    return ((this.data[word]! >>> bit) & 1) !== 0;
  }

  set(index: number): void {
    if (index < 0 || index >= this._length) return;
    const word = index >>> 5;
    const bit = index & 31;
    this.data[word]! |= 1 << bit;
  }

  clear(index: number): void {
    if (index < 0 || index >= this._length) return;
    const word = index >>> 5;
    const bit = index & 31;
    this.data[word]! &= ~(1 << bit);
  }

  // set a range [lo, hi] inclusive to 1
  setRange(lo: number, hi: number): void {
    if (lo > hi) return;
    if (lo < 0) lo = 0;
    if (hi >= this._length) hi = this._length - 1;

    const firstWord = lo >>> 5;
    const lastWord = hi >>> 5;
    const loBit = lo & 31;
    const hiBit = hi & 31;

    // helper to produce mask for [a..b] within a single 32-bit word
    const maskFor = (a: number, b: number) => {
      const width = b - a + 1;
      if (width <= 0) return 0 >>> 0;
      if (width >= 32) return 0xffffffff >>> 0;
      return (((1 << width) - 1) << a) >>> 0;
    };

    if (firstWord === lastWord) {
      const mask = maskFor(loBit, hiBit);
      this.data[firstWord]! = (this.data[firstWord]! | mask) >>> 0;
      return;
    }

    // first partial word
    const firstMask = maskFor(loBit, 31);
    this.data[firstWord]! = (this.data[firstWord]! | firstMask) >>> 0;

    // middle full words
    for (let w = firstWord + 1; w <= lastWord - 1; w++) {
      this.data[w] = 0xffffffff >>> 0;
    }

    // last partial word
    const lastMask = maskFor(0, hiBit);
    this.data[lastWord]! = (this.data[lastWord]! | lastMask) >>> 0;
  }

  // check whether any bit in [lo, hi] is zero (i.e. not set)
  anyClearInRange(lo: number, hi: number): boolean {
    if (lo > hi) return false;
    if (lo < 0) lo = 0;
    if (hi >= this._length) hi = this._length - 1;

    const firstWord = lo >>> 5;
    const lastWord = hi >>> 5;
    const loBit = lo & 31;
    const hiBit = hi & 31;

    const maskFor = (a: number, b: number) => {
      const width = b - a + 1;
      if (width <= 0) return 0 >>> 0;
      if (width >= 32) return 0xffffffff >>> 0;
      return (((1 << width) - 1) << a) >>> 0;
    };

    if (firstWord === lastWord) {
      const mask = maskFor(loBit, hiBit);
      const bits = (this.data[firstWord]! & mask) >>> 0;
      return bits !== mask >>> 0;
    }

    // first partial word: if any bit in the mask is clear -> return true
    const firstMask = maskFor(loBit, 31);
    if ((this.data[firstWord]! & firstMask) >>> 0 !== firstMask >>> 0) return true;

    // middle full words
    for (let w = firstWord + 1; w <= lastWord - 1; w++) {
      if (this.data[w] !== 0xffffffff >>> 0) return true;
    }

    // last partial word
    const lastMask = maskFor(0, hiBit);
    if ((this.data[lastWord]! & lastMask) >>> 0 !== lastMask >>> 0) return true;

    return false;
  }

  // reset all bits to zero
  reset(): void {
    this.data.fill(0);
  }

  *[Symbol.iterator](): IterableIterator<number> {
    for (let wordIndex = 0; wordIndex < this.data.length; wordIndex++) {
      let word = this.data[wordIndex]!;
      if (word === 0) continue;
      const baseIndex = wordIndex * 32;
      for (let bit = 0; bit < 32 && baseIndex + bit < this._length; bit++) {
        if (word & 1) {
          yield baseIndex + bit;
        }
        word >>>= 1;
      }
    }
  }
}
