import { describe, expect, it } from "bun:test";

import { component, relation, type EntityId } from "../../entity";
import type { EntityView } from "../../query/entity-view";
import { World } from "../../world/world";

describe("Query EntityView", () => {
  type Position = { x: number; y: number };
  type Velocity = { x: number; y: number };
  type Health = { value: number };

  const Position = component<Position>();
  const Velocity = component<Velocity>();
  const Health = component<Health>();
  const Stun = component();

  it("forEachView reads components without world.get and supports arbitrary columns on the archetype", () => {
    const world = new World();
    const query = world.createQuery([Position, Velocity]);

    const e1 = world.new();
    const e2 = world.new();
    world.set(e1, Position, { x: 1, y: 2 });
    world.set(e1, Velocity, { x: 10, y: 20 });
    world.set(e1, Health, { value: 100 });
    world.set(e2, Position, { x: 3, y: 4 });
    world.set(e2, Velocity, { x: 30, y: 40 });
    world.sync();

    const seen: Array<{ entity: EntityId; pos: Position; health?: number }> = [];
    query.forEachView((entity, view) => {
      expect(view.entity).toBe(entity);
      const pos = view.get(Position);
      const vel = view.get(Velocity);
      pos.x += vel.x;
      pos.y += vel.y;
      seen.push({
        entity,
        pos: { x: pos.x, y: pos.y },
        health: view.has(Health) ? view.get(Health).value : undefined,
      });
    });

    expect(seen).toHaveLength(2);
    expect(world.get(e1, Position)).toEqual({ x: 11, y: 22 });
    expect(world.get(e2, Position)).toEqual({ x: 33, y: 44 });
    expect(seen.find((s) => s.entity === e1)?.health).toBe(100);
    expect(seen.find((s) => s.entity === e2)?.health).toBeUndefined();
  });

  it("get throws when component is absent; getOptional returns undefined", () => {
    const world = new World();
    const query = world.createQuery([Position]);

    const entity = world.new();
    world.set(entity, Position, { x: 0, y: 0 });
    world.sync();

    query.forEachView((_entity, view) => {
      expect(view.has(Health)).toBe(false);
      expect(view.getOptional(Health)).toBeUndefined();
      expect(() => view.get(Health)).toThrow();
      // undefined is a valid void-component value when present
      expect(view.has(Position)).toBe(true);
      expect(view.getOptional(Position)).toEqual({ value: { x: 0, y: 0 } });
    });
  });

  it("writes forward to the command buffer and apply on sync", () => {
    const world = new World();
    const query = world.createQuery([Position]);

    const entity = world.new();
    world.set(entity, Position, { x: 1, y: 1 });
    world.sync();

    query.forEachView((_entity, view) => {
      view.set(Velocity, { x: 5, y: 6 });
      view.set(Stun);
      view.set(Position, { x: 9, y: 9 });
    });

    // Deferred: not visible yet
    expect(world.has(entity, Velocity)).toBe(false);
    expect(world.has(entity, Stun)).toBe(false);
    expect(world.get(entity, Position)).toEqual({ x: 1, y: 1 });

    world.sync();

    expect(world.get(entity, Velocity)).toEqual({ x: 5, y: 6 });
    expect(world.has(entity, Stun)).toBe(true);
    expect(world.get(entity, Position)).toEqual({ x: 9, y: 9 });
  });

  it("remove and delete forward to the command buffer", () => {
    const world = new World();
    const query = world.createQuery([Position, Velocity]);

    const keep = world.new();
    const dropComp = world.new();
    const dropEntity = world.new();
    for (const e of [keep, dropComp, dropEntity]) {
      world.set(e, Position, { x: 0, y: 0 });
      world.set(e, Velocity, { x: 1, y: 1 });
    }
    world.sync();

    query.forEachView((entity, view) => {
      if (entity === dropComp) view.remove(Velocity);
      if (entity === dropEntity) view.delete();
    });

    expect(world.exists(dropEntity)).toBe(true);
    expect(world.has(dropComp, Velocity)).toBe(true);

    world.sync();

    expect(world.exists(dropEntity)).toBe(false);
    expect(world.has(dropComp, Velocity)).toBe(false);
    expect(world.has(dropComp, Position)).toBe(true);
    expect(world.exists(keep)).toBe(true);
  });

  it("iterateView yields the same rebound view instance", () => {
    const world = new World();
    const query = world.createQuery([Position]);

    const e1 = world.new();
    const e2 = world.new();
    world.set(e1, Position, { x: 1, y: 0 });
    world.set(e2, Position, { x: 2, y: 0 });
    world.sync();

    const views: EntityView[] = [];
    const entities: EntityId[] = [];
    for (const [entity, view] of query.iterateView()) {
      entities.push(entity);
      views.push(view);
      expect(view.entity).toBe(entity);
      expect(view.get(Position).x).toBe(entity === e1 ? 1 : 2);
    }

    expect(entities).toEqual([e1, e2]);
    expect(views[0]).toBe(views[1]);
  });

  it("applies entity-level sparse relation filters", () => {
    const ChildOf = component({ exclusive: true, sparse: true });
    const world = new World();
    const parent1 = world.new();
    const parent2 = world.new();
    const child1 = world.new();
    const child2 = world.new();

    world.set(child1, Position, { x: 0, y: 0 });
    world.set(child1, relation(ChildOf, parent1));
    world.set(child2, Position, { x: 1, y: 1 });
    world.set(child2, relation(ChildOf, parent2));
    world.sync();

    const query = world.createQuery([Position, relation(ChildOf, parent1)]);
    const matched: EntityId[] = [];
    query.forEachView((entity, view) => {
      matched.push(entity);
      expect(view.has(relation(ChildOf, parent1))).toBe(true);
      expect(view.getOptional(relation(ChildOf, parent2))).toBeUndefined();
    });

    expect(matched).toEqual([child1]);
  });

  it("supports typed helpers that accept EntityView", () => {
    const world = new World();
    const query = world.createQuery([Health]);

    const entity = world.new();
    world.set(entity, Health, { value: 10 });
    world.sync();

    function damage(view: EntityView, amount: number): void {
      const h = view.get(Health);
      h.value -= amount;
      if (h.value <= 0) view.delete();
    }

    query.forEachView((_e, view) => damage(view, 3));
    expect(world.get(entity, Health).value).toBe(7);

    query.forEachView((_e, view) => damage(view, 10));
    world.sync();
    expect(world.exists(entity)).toBe(false);
  });
});
