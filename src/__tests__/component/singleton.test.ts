import { describe, expect, it } from "bun:test";
import { ComponentEntityStore } from "../../component/entity-store";
import { component, createEntityId, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";

describe("World - Singleton Component", () => {
  type GlobalConfig = { debug: boolean; version: string };
  type GameState = { score: number; level: number };

  const GlobalConfigId = component<GlobalConfig>();
  const GameStateId = component<GameState>();

  it("should set singleton component using shorthand syntax", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    // Use singleton syntax: set(componentId, data)
    world.set(GlobalConfigId, config);
    world.sync();

    // Verify it was set on the component entity itself
    expect(world.has(GlobalConfigId)).toBe(true);
    expect(world.get(GlobalConfigId)).toEqual(config);
  });

  it("should update singleton component using shorthand syntax", () => {
    const world = new World();
    const config1: GlobalConfig = { debug: true, version: "1.0.0" };
    const config2: GlobalConfig = { debug: false, version: "2.0.0" };

    world.set(GlobalConfigId, config1);
    world.sync();
    expect(world.get(GlobalConfigId)).toEqual(config1);

    world.set(GlobalConfigId, config2);
    world.sync();
    expect(world.get(GlobalConfigId)).toEqual(config2);
  });

  it("should be equivalent to set(comp, comp, data)", () => {
    const world1 = new World();
    const world2 = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    // Singleton syntax
    world1.set(GlobalConfigId, config);
    world1.sync();

    // Traditional syntax
    world2.set(GlobalConfigId, GlobalConfigId, config);
    world2.sync();

    // Both should have the same result
    expect(world1.get(GlobalConfigId)).toEqual(world2.get(GlobalConfigId));
  });

  it("should work with multiple singleton components", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };
    const state: GameState = { score: 100, level: 5 };

    world.set(GlobalConfigId, config);
    world.set(GameStateId, state);
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

  it("should check singleton component existence using shorthand syntax", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    // Before setting, should return false
    expect(world.has(GlobalConfigId)).toBe(false);

    // Set singleton component
    world.set(GlobalConfigId, config);
    world.sync();

    // After setting, should return true
    expect(world.has(GlobalConfigId)).toBe(true);
  });

  it("should be equivalent to has(comp, comp)", () => {
    const world1 = new World();
    const world2 = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    // Singleton syntax
    world1.set(GlobalConfigId, config);
    world1.sync();

    // Traditional syntax
    world2.set(GlobalConfigId, GlobalConfigId, config);
    world2.sync();

    // Both should have the same result
    expect(world1.has(GlobalConfigId)).toBe(world2.has(GlobalConfigId, GlobalConfigId));
    expect(world1.has(GlobalConfigId)).toBe(true);
  });

  it("should remove singleton component using shorthand syntax", () => {
    const world = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    world.set(GlobalConfigId, config);
    world.sync();
    expect(world.has(GlobalConfigId)).toBe(true);

    // Remove using singleton syntax
    world.remove(GlobalConfigId);
    world.sync();
    expect(world.has(GlobalConfigId)).toBe(false);
  });

  it("should be equivalent to remove(comp, comp)", () => {
    const world1 = new World();
    const world2 = new World();
    const config: GlobalConfig = { debug: true, version: "1.0.0" };

    // Set on both worlds
    world1.set(GlobalConfigId, config);
    world1.sync();
    world2.set(GlobalConfigId, GlobalConfigId, config);
    world2.sync();

    // Remove using different syntax
    world1.remove(GlobalConfigId); // Singleton syntax
    world2.remove(GlobalConfigId, GlobalConfigId); // Traditional syntax
    world1.sync();
    world2.sync();

    // Both should have the same result
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
