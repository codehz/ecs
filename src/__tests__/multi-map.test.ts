import { describe, expect, test } from "bun:test";
import { MultiMap } from "../utils/multi-map";

describe("MultiMap", () => {
  test("add and get values", () => {
    const mm = new MultiMap<string, number>();
    mm.add("a", 1);
    mm.add("a", 2);
    mm.add("b", 3);

    expect(mm.keyCount).toBe(2);
    expect(mm.valueCount).toBe(3);

    const aValues = mm.get("a");
    expect(Array.from(aValues).sort()).toEqual([1, 2]);
    expect(Array.from(mm.get("c"))).toEqual([]);
  });

  test("remove value and deleteKey behavior", () => {
    const mm = new MultiMap<string, string>();
    mm.add("x", "one");
    mm.add("x", "two");
    mm.add("y", "three");

    expect(mm.valueCount).toBe(3);

    const removed = mm.remove("x", "one");
    expect(removed).toBe(true);
    expect(mm.valueCount).toBe(2);
    expect(mm.has("x", "one")).toBe(false);

    // remove remaining value for x -> key removed
    expect(mm.remove("x", "two")).toBe(true);
    expect(mm.hasKey("x")).toBe(false);
    expect(mm.keyCount).toBe(1);
    expect(mm.valueCount).toBe(1);

    // delete whole key y
    expect(mm.deleteKey("y")).toBe(true);
    expect(mm.keyCount).toBe(0);
    expect(mm.valueCount).toBe(0);
  });

  test("keys, values and entries iteration", () => {
    const mm = new MultiMap<number, string>();
    mm.add(1, "a");
    mm.add(1, "b");
    mm.add(2, "c");

    const keys = Array.from(mm.keys()).sort((a, b) => a - b);
    expect(keys).toEqual([1, 2]);

    const values = Array.from(mm.values()).sort();
    expect(values).toEqual(["a", "b", "c"]);

    const entries = Array.from(mm.entries());
    // entries should be pairs of key and a Set copy
    expect(entries.length).toBe(3);
    const entryMap = new Map(entries);
    expect(entryMap.get(1)!).toEqual("b");
  });

  test("clear resets state", () => {
    const mm = new MultiMap<string, number>();
    mm.add("k", 1);
    mm.add("k", 2);
    expect(mm.keyCount).toBe(1);
    expect(mm.valueCount).toBe(2);
    mm.clear();
    expect(mm.keyCount).toBe(0);
    expect(mm.valueCount).toBe(0);
    expect(Array.from(mm.keys()).length).toBe(0);
  });
});
