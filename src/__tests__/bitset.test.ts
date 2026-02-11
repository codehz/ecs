import { describe, expect, it } from "bun:test";
import { BitSet } from "../utils/bit-set";

describe("BitSet word boundary tests", () => {
  it("should setRange across word boundaries", () => {
    const bitset = new BitSet(100);

    // Set range crossing 32-bit boundary (30-35)
    bitset.setRange(30, 35);

    // Check that all bits in range are set
    for (let i = 30; i <= 35; i++) {
      expect(bitset.has(i)).toBe(true);
    }

    // Check boundary bits
    expect(bitset.has(29)).toBe(false);
    expect(bitset.has(36)).toBe(false);
  });

  it("should handle setRange at word boundary exactly", () => {
    const bitset = new BitSet(100);

    // Set range [0..31] = first word
    bitset.setRange(0, 31);

    for (let i = 0; i <= 31; i++) {
      expect(bitset.has(i)).toBe(true);
    }
    expect(bitset.has(32)).toBe(false);
  });

  it("should handle setRange spanning multiple words", () => {
    const bitset = new BitSet(200);

    // Set range [20..80] spanning parts of 3 words
    bitset.setRange(20, 80);

    for (let i = 20; i <= 80; i++) {
      expect(bitset.has(i)).toBe(true);
    }
    expect(bitset.has(19)).toBe(false);
    expect(bitset.has(81)).toBe(false);
  });

  it("should anyClearInRange work across word boundaries", () => {
    const bitset = new BitSet(100);

    // Set all bits
    bitset.setRange(0, 99);

    // All bits are set, so anyClearInRange should return false
    expect(bitset.anyClearInRange(30, 35)).toBe(false);
    expect(bitset.anyClearInRange(0, 99)).toBe(false);

    // Clear some bits crossing boundary
    bitset.clear(31);
    bitset.clear(32);

    expect(bitset.anyClearInRange(30, 35)).toBe(true);
    expect(bitset.anyClearInRange(0, 30)).toBe(false);
    expect(bitset.anyClearInRange(33, 99)).toBe(false);
  });

  it("should handle anyClearInRange with single word", () => {
    const bitset = new BitSet(100);

    bitset.setRange(10, 20);

    // Range entirely in one word and all bits set
    expect(bitset.anyClearInRange(10, 20)).toBe(false);

    // Clear one bit in range
    bitset.clear(15);
    expect(bitset.anyClearInRange(10, 20)).toBe(true);

    // Check range before and after
    expect(bitset.anyClearInRange(0, 9)).toBe(true);
    expect(bitset.anyClearInRange(21, 99)).toBe(true);
  });

  it("should handle large ranges", () => {
    const bitset = new BitSet(1000);

    // Set all bits
    bitset.setRange(0, 999);

    expect(bitset.anyClearInRange(0, 999)).toBe(false);

    // Clear one bit in the middle
    bitset.clear(500);
    expect(bitset.anyClearInRange(0, 999)).toBe(true);
    expect(bitset.anyClearInRange(0, 499)).toBe(false);
    expect(bitset.anyClearInRange(501, 999)).toBe(false);
  });

  it("should handle range with no overlap", () => {
    const bitset = new BitSet(100);

    bitset.setRange(10, 20);

    expect(bitset.anyClearInRange(0, 9)).toBe(true);
    expect(bitset.anyClearInRange(21, 99)).toBe(true);
  });

  it("should iterate over set bits correctly", () => {
    const bitset = new BitSet(100);

    bitset.set(5);
    bitset.set(35);
    bitset.set(65);
    bitset.set(99);

    const setBits: number[] = [];
    for (const bit of bitset) {
      setBits.push(bit);
    }

    expect(setBits).toEqual([5, 35, 65, 99]);
  });

  it("should iterate over setRange result", () => {
    const bitset = new BitSet(100);

    bitset.setRange(10, 15);

    const setBits: number[] = [];
    for (const bit of bitset) {
      setBits.push(bit);
    }

    expect(setBits).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it("should handle reset correctly", () => {
    const bitset = new BitSet(100);

    bitset.setRange(0, 99);
    bitset.reset();

    expect(bitset.anyClearInRange(0, 99)).toBe(true);

    const setBits: number[] = [];
    for (const bit of bitset) {
      setBits.push(bit);
    }

    expect(setBits).toHaveLength(0);
  });

  it("should handle edge case: setRange with reversed bounds", () => {
    const bitset = new BitSet(100);

    // setRange(hi, lo) where hi > lo should do nothing
    bitset.setRange(50, 30);

    for (let i = 0; i < 100; i++) {
      expect(bitset.has(i)).toBe(false);
    }
  });

  it("should handle single bit in range", () => {
    const bitset = new BitSet(100);

    bitset.setRange(25, 25);

    expect(bitset.has(25)).toBe(true);
    expect(bitset.has(24)).toBe(false);
    expect(bitset.has(26)).toBe(false);
  });
});
