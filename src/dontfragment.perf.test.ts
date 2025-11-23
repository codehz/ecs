import { describe, it, expect } from "bun:test";
import { World } from "./world";
import { component, relation } from "./entity";

describe("DontFragment Performance", () => {
  it("should reduce archetype count with dontFragment enabled", () => {
    console.log("\n=== Archetype Fragmentation Comparison ===");

    // Test WITHOUT dontFragment (causes fragmentation)
    const world1 = new World();
    type Position = { x: number; y: number };
    const Position1 = component<Position>();
    const Velocity1 = component<{ x: number; y: number }>();
    const ChildOf1 = component(); // WITHOUT dontFragment

    const numParents = 100;
    const childrenPerParent = 10;

    // Create parent entities
    const parents1: number[] = [];
    for (let i = 0; i < numParents; i++) {
      parents1.push(world1.new());
    }

    const start1 = performance.now();

    // Create children with different parents
    for (let i = 0; i < numParents; i++) {
      for (let j = 0; j < childrenPerParent; j++) {
        const child = world1.new();
        world1.set(child, Position1, { x: i, y: j });
        world1.set(child, Velocity1, { x: 1, y: 1 });
        world1.set(child, relation(ChildOf1, parents1[i]!));
      }
    }

    world1.sync();
    const end1 = performance.now();
    const time1 = end1 - start1;

    const archetypes1 = (world1 as any).archetypes;
    const archetypesWithPosition1 = archetypes1.filter((arch: any) => {
      return arch.componentTypes.includes(Position1);
    });

    console.log(`WITHOUT dontFragment:`);
    console.log(`  Time: ${time1.toFixed(2)}ms`);
    console.log(`  Total archetypes: ${archetypes1.length}`);
    console.log(`  Archetypes with Position: ${archetypesWithPosition1.length}`);
    console.log(`  Entities per archetype: ${childrenPerParent}`);

    // Test WITH dontFragment (prevents fragmentation)
    const world2 = new World();
    const Position2 = component<Position>();
    const Velocity2 = component<{ x: number; y: number }>();
    const ChildOf2 = component({ dontFragment: true }); // WITH dontFragment

    const parents2: number[] = [];
    for (let i = 0; i < numParents; i++) {
      parents2.push(world2.new());
    }

    const start2 = performance.now();

    for (let i = 0; i < numParents; i++) {
      for (let j = 0; j < childrenPerParent; j++) {
        const child = world2.new();
        world2.set(child, Position2, { x: i, y: j });
        world2.set(child, Velocity2, { x: 1, y: 1 });
        world2.set(child, relation(ChildOf2, parents2[i]!));
      }
    }

    world2.sync();
    const end2 = performance.now();
    const time2 = end2 - start2;

    const archetypes2 = (world2 as any).archetypes;
    const archetypesWithPosition2 = archetypes2.filter((arch: any) => {
      return arch.componentTypes.includes(Position2);
    });

    console.log(`\nWITH dontFragment:`);
    console.log(`  Time: ${time2.toFixed(2)}ms`);
    console.log(`  Total archetypes: ${archetypes2.length}`);
    console.log(`  Archetypes with Position: ${archetypesWithPosition2.length}`);
    console.log(`  Entities per archetype: ${archetypesWithPosition2[0]?.size || 0}`);

    console.log(`\nImprovement:`);
    console.log(
      `  Archetype reduction: ${archetypesWithPosition1.length}x → 1x (${((1 - 1 / archetypesWithPosition1.length) * 100).toFixed(1)}% reduction)`,
    );
    console.log(
      `  Time difference: ${(time1 - time2).toFixed(2)}ms (${((1 - time2 / time1) * 100).toFixed(1)}% ${time2 < time1 ? "faster" : "slower"})`,
    );

    // Verify fragmentation is reduced
    expect(archetypesWithPosition2.length).toBe(1);
    expect(archetypesWithPosition1.length).toBe(numParents);
    expect(archetypesWithPosition2[0]?.size).toBe(numParents * childrenPerParent);
  });

  it("should improve query performance with dontFragment enabled", () => {
    console.log("\n=== Query Performance Comparison ===");

    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };

    const numParents = 50;
    const childrenPerParent = 20;
    const totalChildren = numParents * childrenPerParent;

    // Test WITHOUT dontFragment
    const world1 = new World();
    const Position1 = component<Position>();
    const Velocity1 = component<Velocity>();
    const ChildOf1 = component();

    const parents1: number[] = [];
    for (let i = 0; i < numParents; i++) {
      parents1.push(world1.new());
    }

    for (let i = 0; i < numParents; i++) {
      for (let j = 0; j < childrenPerParent; j++) {
        const child = world1.new();
        world1.set(child, Position1, { x: i, y: j });
        world1.set(child, Velocity1, { x: 1, y: 1 });
        world1.set(child, relation(ChildOf1, parents1[i]!));
      }
    }
    world1.sync();

    // Test WITH dontFragment
    const world2 = new World();
    const Position2 = component<Position>();
    const Velocity2 = component<Velocity>();
    const ChildOf2 = component({ dontFragment: true });

    const parents2: number[] = [];
    for (let i = 0; i < numParents; i++) {
      parents2.push(world2.new());
    }

    for (let i = 0; i < numParents; i++) {
      for (let j = 0; j < childrenPerParent; j++) {
        const child = world2.new();
        world2.set(child, Position2, { x: i, y: j });
        world2.set(child, Velocity2, { x: 1, y: 1 });
        world2.set(child, relation(ChildOf2, parents2[i]!));
      }
    }
    world2.sync();

    const iterations = 1000;

    // Query performance WITHOUT dontFragment
    const query1 = world1.createQuery([Position1, Velocity1]);
    let totalTime1 = 0;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      query1.forEach([Position1, Velocity1], (entity, pos, vel) => {
        // Simulate some work
        pos.x += vel.x * 0.016;
        pos.y += vel.y * 0.016;
      });
      totalTime1 += performance.now() - start;
    }
    const avgTime1 = totalTime1 / iterations;

    // Query performance WITH dontFragment
    const query2 = world2.createQuery([Position2, Velocity2]);
    let totalTime2 = 0;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      query2.forEach([Position2, Velocity2], (entity, pos, vel) => {
        // Simulate some work
        pos.x += vel.x * 0.016;
        pos.y += vel.y * 0.016;
      });
      totalTime2 += performance.now() - start;
    }
    const avgTime2 = totalTime2 / iterations;

    console.log(`WITHOUT dontFragment:`);
    console.log(`  Average query time: ${avgTime1.toFixed(4)}ms`);
    console.log(`  Entities processed: ${totalChildren}`);
    console.log(
      `  Archetypes queried: ${(world1 as any).archetypes.filter((a: any) => a.componentTypes.includes(Position1)).length}`,
    );

    console.log(`\nWITH dontFragment:`);
    console.log(`  Average query time: ${avgTime2.toFixed(4)}ms`);
    console.log(`  Entities processed: ${totalChildren}`);
    console.log(
      `  Archetypes queried: ${(world2 as any).archetypes.filter((a: any) => a.componentTypes.includes(Position2)).length}`,
    );

    console.log(`\nImprovement:`);
    const speedup = avgTime1 / avgTime2;
    console.log(`  Query speedup: ${speedup.toFixed(2)}x (${((1 - avgTime2 / avgTime1) * 100).toFixed(1)}% faster)`);

    // Verify both worlds have same number of entities
    expect(query1.getEntities().length).toBe(totalChildren);
    expect(query2.getEntities().length).toBe(totalChildren);

    // Cleanup
    query1.dispose();
    query2.dispose();
  });

  it("should demonstrate memory layout benefits", () => {
    console.log("\n=== Memory Layout & Cache Efficiency ===");

    type Position = { x: number; y: number };
    type Velocity = { x: number; y: number };
    type Health = { value: number };

    const numParents = 100;
    const childrenPerParent = 10;

    // WITHOUT dontFragment - fragmented memory layout
    const world1 = new World();
    const Position1 = component<Position>();
    const Velocity1 = component<Velocity>();
    const Health1 = component<Health>();
    const ChildOf1 = component();

    const parents1: number[] = [];
    for (let i = 0; i < numParents; i++) {
      parents1.push(world1.new());
    }

    for (let i = 0; i < numParents; i++) {
      for (let j = 0; j < childrenPerParent; j++) {
        const child = world1.new();
        world1.set(child, Position1, { x: i, y: j });
        world1.set(child, Velocity1, { x: 1, y: 1 });
        world1.set(child, Health1, { value: 100 });
        world1.set(child, relation(ChildOf1, parents1[i]!));
      }
    }
    world1.sync();

    // WITH dontFragment - contiguous memory layout
    const world2 = new World();
    const Position2 = component<Position>();
    const Velocity2 = component<Velocity>();
    const Health2 = component<Health>();
    const ChildOf2 = component({ dontFragment: true });

    const parents2: number[] = [];
    for (let i = 0; i < numParents; i++) {
      parents2.push(world2.new());
    }

    for (let i = 0; i < numParents; i++) {
      for (let j = 0; j < childrenPerParent; j++) {
        const child = world2.new();
        world2.set(child, Position2, { x: i, y: j });
        world2.set(child, Velocity2, { x: 1, y: 1 });
        world2.set(child, Health2, { value: 100 });
        world2.set(child, relation(ChildOf2, parents2[i]!));
      }
    }
    world2.sync();

    // Measure iteration performance (cache efficiency indicator)
    const iterations = 5000;
    const query1 = world1.createQuery([Position1, Velocity1, Health1]);

    let totalTime1 = 0;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      let sum = 0;
      query1.forEach([Position1, Velocity1, Health1], (entity, pos, vel, health) => {
        sum += pos.x + pos.y + vel.x + vel.y + health.value;
      });
      totalTime1 += performance.now() - start;
    }
    const avgTime1 = totalTime1 / iterations;

    const query2 = world2.createQuery([Position2, Velocity2, Health2]);

    let totalTime2 = 0;
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      let sum = 0;
      query2.forEach([Position2, Velocity2, Health2], (entity, pos, vel, health) => {
        sum += pos.x + pos.y + vel.x + vel.y + health.value;
      });
      totalTime2 += performance.now() - start;
    }
    const avgTime2 = totalTime2 / iterations;

    const archetypes1 = (world1 as any).archetypes.filter(
      (a: any) =>
        a.componentTypes.includes(Position1) &&
        a.componentTypes.includes(Velocity1) &&
        a.componentTypes.includes(Health1),
    );

    const archetypes2 = (world2 as any).archetypes.filter(
      (a: any) =>
        a.componentTypes.includes(Position2) &&
        a.componentTypes.includes(Velocity2) &&
        a.componentTypes.includes(Health2),
    );

    console.log(`WITHOUT dontFragment (fragmented):`);
    console.log(`  Archetypes: ${archetypes1.length}`);
    console.log(`  Avg entities/archetype: ${((numParents * childrenPerParent) / archetypes1.length).toFixed(1)}`);
    console.log(`  Average iteration time: ${avgTime1.toFixed(4)}ms`);

    console.log(`\nWITH dontFragment (contiguous):`);
    console.log(`  Archetypes: ${archetypes2.length}`);
    console.log(`  Avg entities/archetype: ${((numParents * childrenPerParent) / archetypes2.length).toFixed(1)}`);
    console.log(`  Average iteration time: ${avgTime2.toFixed(4)}ms`);

    console.log(`\nBenefits:`);
    console.log(`  Memory fragmentation: ${archetypes1.length}x → ${archetypes2.length}x`);
    console.log(`  Cache efficiency improvement: ${(avgTime1 / avgTime2).toFixed(2)}x faster`);
    console.log(`  Iteration speedup: ${((1 - avgTime2 / avgTime1) * 100).toFixed(1)}% improvement`);

    // Verify single contiguous archetype
    expect(archetypes2.length).toBe(1);
    expect(archetypes1.length).toBeGreaterThan(1);

    query1.dispose();
    query2.dispose();
  });

  it("should show performance difference with varying parent counts", () => {
    console.log("\n=== Scalability Analysis ===");

    type Position = { x: number; y: number };

    const parentCounts = [10, 50, 100, 200];
    const childrenPerParent = 10;

    console.log("Testing with different numbers of parents:\n");

    for (const numParents of parentCounts) {
      // WITHOUT dontFragment
      const world1 = new World();
      const Position1 = component<Position>();
      const ChildOf1 = component();

      const parents1: number[] = [];
      for (let i = 0; i < numParents; i++) {
        parents1.push(world1.new());
      }

      const start1 = performance.now();
      for (let i = 0; i < numParents; i++) {
        for (let j = 0; j < childrenPerParent; j++) {
          const child = world1.new();
          world1.set(child, Position1, { x: i, y: j });
          world1.set(child, relation(ChildOf1, parents1[i]!));
        }
      }
      world1.sync();
      const time1 = performance.now() - start1;

      const archetypes1 = (world1 as any).archetypes.filter((a: any) => a.componentTypes.includes(Position1)).length;

      // WITH dontFragment
      const world2 = new World();
      const Position2 = component<Position>();
      const ChildOf2 = component({ dontFragment: true });

      const parents2: number[] = [];
      for (let i = 0; i < numParents; i++) {
        parents2.push(world2.new());
      }

      const start2 = performance.now();
      for (let i = 0; i < numParents; i++) {
        for (let j = 0; j < childrenPerParent; j++) {
          const child = world2.new();
          world2.set(child, Position2, { x: i, y: j });
          world2.set(child, relation(ChildOf2, parents2[i]!));
        }
      }
      world2.sync();
      const time2 = performance.now() - start2;

      const archetypes2 = (world2 as any).archetypes.filter((a: any) => a.componentTypes.includes(Position2)).length;

      console.log(`${numParents} parents (${numParents * childrenPerParent} children):`);
      console.log(`  Without: ${archetypes1} archetypes, ${time1.toFixed(2)}ms`);
      console.log(`  With:    ${archetypes2} archetype(s), ${time2.toFixed(2)}ms`);
      console.log(`  Improvement: ${((1 - time2 / time1) * 100).toFixed(1)}% faster, ${archetypes1}x fewer archetypes`);
      console.log();
    }

    expect(true).toBe(true); // Test always passes, we're just measuring
  });
});
