import { describe, expect, it } from "bun:test";

import { ComponentEntityStore } from "../../component/entity-store";
import { component, createEntityId, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";

function expectType<T>(_value: T): void {}

describe("World - Singleton Component", () => {
  type GlobalConfig = { debug: boolean; version: string };
  type GameState = { score: number; level: number };

  const GlobalConfigId = component<GlobalConfig>();
  const GameStateId = component<GameState>();

  it("should set singleton component through the explicit handle", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };
    const singleton = world.singleton(GlobalConfigId);

    singleton.set(config);
    world.sync();

    expect(world.has(GlobalConfigId)).toBe(true);
    expect(world.get(GlobalConfigId)).toEqual(config);
  });

  it("should interpret 2-argument set on a component entity as a void component set", () => {
    const world = new World();
    const singleton = world.singleton(GlobalConfigId);
    const Marker = component<void>();
    const originalWarn = console.warn;
    const warnings: string[] = [];

    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    try {
      world.set(GlobalConfigId, Marker);
    } finally {
      console.warn = originalWarn;
    }

    world.sync();

    expect(world.has(GlobalConfigId, Marker)).toBe(true);
    expect(singleton.has()).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it("should support the deprecated singleton data shorthand for non-number values", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };
    const originalWarn = console.warn;
    const warnings: string[] = [];

    if (false) {
      expectType<void>(world.set(GlobalConfigId, config));
    }

    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    try {
      world.set(GlobalConfigId, config);
    } finally {
      console.warn = originalWarn;
    }

    world.sync();

    expect(world.get(GlobalConfigId)).toEqual(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("deprecated");
    expect(warnings[0]).toContain("world.singleton(componentId).set(value)");
  });

  it("should not expose the deprecated shorthand for numeric singleton types at the type level", () => {
    const world = new World();
    const Score = component<number>();

    if (false) {
      // @ts-expect-error Numeric singleton shorthand is intentionally unsupported.
      expectType<void>(world.set(Score, 123));
    }

    expect(true).toBe(true);
  });

  it("should manage singleton data through an explicit handle", () => {
    const world = new World();
    const config = world.singleton(GlobalConfigId);

    expect(config.getOptional()).toBeUndefined();
    expect(config.has()).toBe(false);

    config.set({ debug: true, version: "1.0.0" });
    world.sync();

    expect(config.has()).toBe(true);
    expect(config.get()).toEqual({ debug: true, version: "1.0.0" });

    config.remove();
    world.sync();

    expect(config.has()).toBe(false);
    expect(config.getOptional()).toBeUndefined();
  });

  it("should support void singleton components through an explicit handle", () => {
    const world = new World();
    const Tag = component<void>();
    const tag = world.singleton(Tag);

    tag.set();
    world.sync();

    expect(tag.has()).toBe(true);
    expect(world.has(Tag)).toBe(true);
  });

  it("should update singleton component through the explicit handle", () => {
    const world = new World();
    const config1: GlobalConfig = { debug: true, version: "1.0.0" };
    const config2: GlobalConfig = { debug: false, version: "2.0.0" };
    const singleton = world.singleton(GlobalConfigId);

    singleton.set(config1);
    world.sync();
    expect(world.get(GlobalConfigId)).toEqual(config1);

    singleton.set(config2);
    world.sync();
    expect(world.get(GlobalConfigId)).toEqual(config2);
  });

  it("should be equivalent to set(comp, comp, data)", () => {
    const world1 = new World();
    const world2 = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    world1.singleton(GlobalConfigId).set(config);
    world1.sync();

    world2.set(GlobalConfigId, GlobalConfigId, config);
    world2.sync();

    expect(world1.get(GlobalConfigId)).toEqual(world2.get(GlobalConfigId));
  });

  it("should work with multiple singleton components", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };
    const state: GameState = { score: 100, level: 5 };

    world.singleton(GlobalConfigId).set(config);
    world.singleton(GameStateId).set(state);
    world.sync();

    expect(world.get(GlobalConfigId)).toEqual(config);
    expect(world.get(GameStateId)).toEqual(state);
  });

  it("should throw error if component entity does not exist", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    // Try to set a component on an entity that doesn't exist
    const nonExistentEntity = 99999 as any; // Use a fake entity ID
    expect(() => {
      world.set(nonExistentEntity, GlobalConfigId, config);
    }).toThrow("does not exist");
  });

  it("should check singleton component existence through the explicit handle", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };
    const singleton = world.singleton(GlobalConfigId);

    expect(singleton.has()).toBe(false);

    singleton.set(config);
    world.sync();

    expect(singleton.has()).toBe(true);
  });

  it("should be equivalent to has(comp, comp)", () => {
    const world1 = new World();
    const world2 = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    world1.singleton(GlobalConfigId).set(config);
    world1.sync();

    world2.set(GlobalConfigId, GlobalConfigId, config);
    world2.sync();

    expect(world1.has(GlobalConfigId)).toBe(world2.has(GlobalConfigId, GlobalConfigId));
    expect(world1.has(GlobalConfigId)).toBe(true);
  });

  it("should remove singleton component through the explicit handle", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };
    const singleton = world.singleton(GlobalConfigId);

    singleton.set(config);
    world.sync();
    expect(world.has(GlobalConfigId)).toBe(true);

    singleton.remove();
    world.sync();
    expect(world.has(GlobalConfigId)).toBe(false);
  });

  it("should be equivalent to remove(comp, comp)", () => {
    const world1 = new World();
    const world2 = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    world1.singleton(GlobalConfigId).set(config);
    world1.sync();
    world2.set(GlobalConfigId, GlobalConfigId, config);
    world2.sync();

    world1.singleton(GlobalConfigId).remove();
    world2.remove(GlobalConfigId, GlobalConfigId);
    world1.sync();
    world2.sync();

    expect(world1.has(GlobalConfigId)).toBe(world2.has(GlobalConfigId, GlobalConfigId));
    expect(world1.has(GlobalConfigId)).toBe(false);
  });

  it("should cover ComponentEntityStore hasWildcard, getWildcard, wildcard delete paths", () => {
    const store = new ComponentEntityStore();
    const compE = GlobalConfigId as EntityId; // reuse as component entity id (valid in range)
    const target1 = createEntityId(1024);
    const target2 = createEntityId(1025);
    const relComp = relation(GlobalConfigId, target1); // entity-relation on the comp entity
    const relComp2 = relation(GlobalConfigId, target2);
    const wildcard = relation(GlobalConfigId, "*");

    // Setup via internal? Use executeCommands to populate (simulates)
    store.executeCommands(compE, [
      { type: "set", componentType: relComp, component: { dist: 1 } } as any,
      { type: "set", componentType: relComp2, component: { dist: 2 } } as any,
    ]);

    // hasWildcard
    expect(store.hasWildcard(compE, GlobalConfigId as any)).toBe(true);
    expect(store.hasWildcard(compE, GameStateId as any)).toBe(false);
    expect(store.hasWildcard(createEntityId(9999), GlobalConfigId as any)).toBe(false); // no data

    // getWildcard
    const w1 = store.getWildcard(compE, wildcard as any);
    expect(w1.length).toBe(2);

    // wildcard delete via executeCommands
    store.executeCommands(compE, [{ type: "delete", componentType: wildcard } as any]);
    const afterDel = store.getWildcard(compE, wildcard as any);
    expect(afterDel.length).toBe(0);

    // also test get on non exist throws
    expect(() => store.get(compE, createEntityId(5000) as any)).toThrow();
    expect(store.getOptional(compE, createEntityId(5000) as any)).toBeUndefined();

    // clear
    store.clear(compE);
    expect(store.has(compE, relComp)).toBe(false);
  });
});
