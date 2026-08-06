import { describe, expect, it } from "bun:test";

import fc from "fast-check";

import { BitSet } from "../../utils/bit-set";
import { pbtAssertOptions } from "./config";

/** Naive boolean[] oracle for BitSet. */
class ModelBitSet {
  bits: boolean[];
  constructor(readonly length: number) {
    this.bits = new Array(length).fill(false);
  }
  has(i: number): boolean {
    if (i < 0 || i >= this.length) return false;
    return this.bits[i]!;
  }
  set(i: number): void {
    if (i < 0 || i >= this.length) return;
    this.bits[i] = true;
  }
  clear(i: number): void {
    if (i < 0 || i >= this.length) return;
    this.bits[i] = false;
  }
  setRange(lo: number, hi: number): void {
    if (lo > hi) return;
    lo = Math.max(0, lo);
    hi = Math.min(this.length - 1, hi);
    for (let i = lo; i <= hi; i++) this.bits[i] = true;
  }
  anyClearInRange(lo: number, hi: number): boolean {
    if (lo > hi) return false;
    lo = Math.max(0, lo);
    hi = Math.min(this.length - 1, hi);
    for (let i = lo; i <= hi; i++) {
      if (!this.bits[i]) return true;
    }
    return false;
  }
  reset(): void {
    this.bits.fill(false);
  }
  *setIndices(): IterableIterator<number> {
    for (let i = 0; i < this.length; i++) {
      if (this.bits[i]) yield i;
    }
  }
}

type Op =
  | { kind: "set"; i: number }
  | { kind: "clear"; i: number }
  | { kind: "setRange"; lo: number; hi: number }
  | { kind: "reset" };

function opArb(length: number): fc.Arbitrary<Op> {
  const idx = fc.integer({ min: -2, max: length + 2 });
  return fc.oneof(
    idx.map((i) => ({ kind: "set" as const, i })),
    idx.map((i) => ({ kind: "clear" as const, i })),
    fc.tuple(idx, idx).map(([a, b]) => ({
      kind: "setRange" as const,
      lo: Math.min(a, b),
      hi: Math.max(a, b),
    })),
    fc.constant({ kind: "reset" as const }),
  );
}

function applyOp(bs: BitSet, model: ModelBitSet, op: Op): void {
  switch (op.kind) {
    case "set":
      bs.set(op.i);
      model.set(op.i);
      break;
    case "clear":
      bs.clear(op.i);
      model.clear(op.i);
      break;
    case "setRange":
      bs.setRange(op.lo, op.hi);
      model.setRange(op.lo, op.hi);
      break;
    case "reset":
      bs.reset();
      model.reset();
      break;
  }
}

function assertAgree(bs: BitSet, model: ModelBitSet): void {
  expect(bs.length).toBe(model.length);
  for (let i = -1; i <= model.length; i++) {
    expect(bs.has(i)).toBe(model.has(i));
  }
  const windows: [number, number][] = [
    [0, model.length - 1],
    [0, 0],
    [model.length - 1, model.length - 1],
    [30, 35],
    [31, 63],
    [-5, 5],
    [model.length - 5, model.length + 5],
  ];
  for (const [lo, hi] of windows) {
    expect(bs.anyClearInRange(lo, hi)).toBe(model.anyClearInRange(lo, hi));
  }
  expect([...bs]).toEqual([...model.setIndices()]);
}

describe("PBT: BitSet model agreement", () => {
  it("random op sequences match boolean[] oracle", () => {
    fc.assert(
      fc.property(
        fc
          .integer({ min: 1, max: 160 })
          .chain((length) => fc.tuple(fc.constant(length), fc.array(opArb(length), { minLength: 0, maxLength: 60 }))),
        ([length, ops]) => {
          const bs = new BitSet(length);
          const model = new ModelBitSet(length);
          for (const op of ops) {
            applyOp(bs, model, op);
          }
          assertAgree(bs, model);
        },
      ),
      pbtAssertOptions,
    );
  });

  it("setRange then anyClearInRange agrees with model for random ranges", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 32, max: 256 }),
        fc.integer({ min: -5, max: 300 }),
        fc.integer({ min: -5, max: 300 }),
        (length, a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const bs = new BitSet(length);
          const model = new ModelBitSet(length);
          bs.setRange(lo, hi);
          model.setRange(lo, hi);
          assertAgree(bs, model);
          for (let i = 0; i < 5; i++) {
            const x = ((lo + i * 7) % (length + 10)) - 2;
            const y = ((hi + i * 3) % (length + 10)) - 2;
            const rlo = Math.min(x, y);
            const rhi = Math.max(x, y);
            expect(bs.anyClearInRange(rlo, rhi)).toBe(model.anyClearInRange(rlo, rhi));
          }
        },
      ),
      pbtAssertOptions,
    );
  });
});
