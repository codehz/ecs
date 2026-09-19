import { describe, expect, it } from "bun:test";

import { component, relation, type EntityId } from "../../entity";
import { World } from "../../world/world";

/** Relations are column-ordered, which is not part of the contract: compare sorted. */
const sorted = <T>(pairs: [EntityId<unknown>, T][]): [EntityId<unknown>, T][] =>
  [...pairs].sort((left, right) => (left[0] as number) - (right[0] as number));

describe("Query.getComponentData", () => {
  const setup = () => {
    const world = new World();
    const Position = component<{ x: number }>();
    const Timer = component<number>();
    const one = world.new();
    const two = world.new();
    const bare = world.new();
    world.set(one, Position, { x: 1 });
    world.set(two, Position, { x: 2 });
    world.set(bare, Position, { x: 3 });
    world.set(one, relation(Timer, two), 5);
    world.set(two, relation(Timer, one), 6);
    world.set(two, relation(Timer, bare), 7);
    world.sync();
    return { world, Position, Timer, one, two, bare };
  };

  it("reads a wildcard relation per matching entity, in getEntities order", () => {
    const { world, Position, Timer, one, two, bare } = setup();
    const timer = relation(Timer, "*");
    const query = world.createQuery([Position, timer]);

    const entities = query.getEntities();
    const data = query.getComponentData(timer);

    expect(data).toHaveLength(entities.length);
    // One list per entity, holding the same pairs `world.get` hands out.
    expect(data).toEqual(entities.map((entity) => world.get(entity, timer)));
    expect(sorted(data[entities.indexOf(one)]!)).toEqual([[two, 5]]);
    expect(sorted(data[entities.indexOf(two)]!)).toEqual([
      [one, 6],
      [bare, 7],
    ]);
  });

  it("agrees with forEach for the same wildcard slot", () => {
    const { world, Position, Timer } = setup();
    const timer = relation(Timer, "*");
    const query = world.createQuery([Position, timer]);

    const fromData = query.getComponentData(timer);
    const fromEach: [EntityId<unknown>, number][][] = [];
    query.forEach([timer], (_entity, timers) => {
      fromEach.push(sorted(timers));
    });

    expect(fromData.map(sorted)).toEqual(fromEach);
  });

  it("keeps an entry per entity when the wildcard is not in the query types", () => {
    const { world, Position, Timer, one, two, bare } = setup();
    const timer = relation(Timer, "*");
    const query = world.createQuery([Position]);

    const entities = query.getEntities();
    const data = query.getComponentData(timer);

    expect(data).toHaveLength(entities.length);
    // `bare` holds no relation of that component: an empty list, not a missing entry.
    expect(sorted(data[entities.indexOf(bare)]!)).toEqual([]);
    expect(sorted(data[entities.indexOf(one)]!)).toEqual([[two, 5]]);
  });

  it("carries undefined for a void relation, like world.get", () => {
    const world = new World();
    const Position = component<{ x: number }>();
    const Tag = component<void>();
    const entity = world.new();
    const target = world.new();
    world.set(entity, Position, { x: 1 });
    world.set(entity, relation(Tag, target));
    world.sync();

    const tag = relation(Tag, "*");
    const query = world.createQuery([Position, tag]);
    expect(query.getComponentData(tag)).toEqual([[[target, undefined]]]);
  });

  it("includes sparse relations", () => {
    const world = new World();
    const Position = component<{ x: number }>();
    const MemberOf = component<number>({ sparse: true });
    const entity = world.new();
    const guild = world.new();
    world.set(entity, Position, { x: 1 });
    world.set(entity, relation(MemberOf, guild), 42);
    world.sync();

    const memberOf = relation(MemberOf, "*");
    const query = world.createQuery([Position, memberOf]);
    expect(query.getComponentData(memberOf)).toEqual([[[guild, 42]]]);
  });

  it("honours the query's negative filter", () => {
    const world = new World();
    const Position = component<{ x: number }>();
    const Timer = component<number>();
    const Stun = component<void>();
    const running = world.new();
    const stunned = world.new();
    const target = world.new();
    world.set(running, Position, { x: 1 });
    world.set(stunned, Position, { x: 2 });
    world.set(stunned, Stun);
    world.set(running, relation(Timer, target), 5);
    world.set(stunned, relation(Timer, target), 6);
    world.sync();

    const timer = relation(Timer, "*");
    const query = world.createQuery([Position, timer], { negativeComponentTypes: [Stun] });

    expect(query.getEntities()).toEqual([running]);
    expect(query.getComponentData(timer)).toEqual([[[target, 5]]]);
  });

  it("still reads plain and specific sparse components", () => {
    const { world, Position, Timer, two, bare } = setup();
    const positionQuery = world.createQuery([Position]);

    expect(positionQuery.getComponentData(Position)).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);

    const specific = relation(Timer, bare);
    const specificQuery = world.createQuery([specific]);
    expect(specificQuery.getEntities()).toEqual([two]);
    expect(specificQuery.getComponentData(specific)).toEqual([7]);
  });
});
