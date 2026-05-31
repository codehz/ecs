/**
 * Example: Using the Debug Stats Collector for development & leak detection.
 *
 * Run with:
 *   bun run examples/debug-observability.ts
 */

import { component, relation, World } from "../src";

type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// Components
const Position = component<Position>();
const Velocity = component<Velocity>();
const ChildOf = component<void>({ exclusive: true, dontFragment: true });

const world = new World();

// Create a debug stats collector
const collector = world.createDebugStatsCollector((stats) => {
  console.log("=== Debug Stats ===");
  console.log(`Sync time: ${(stats.timestamps.syncEnd - stats.timestamps.syncStart).toFixed(3)}ms`);
  console.log(`Command buffer iterations: ${stats.commandIterations}`);
  console.log(`Entities: ${stats.entities.total} (freelist: ${stats.entities.freelistSize})`);
  console.log(`Archetypes: ${stats.archetypes.total} (empty: ${stats.archetypes.empty})`);
  console.log(`Queries (cached/registered): ${stats.queries.cached}/${stats.queries.registered}`);
  console.log(`Hooks: ${stats.hooks.total}`);
  console.log(`Indices:`, stats.indices);

  const act = stats.activity;
  console.log("Activity this sync:");
  console.log(`  Migrations: ${act.migrations}`);
  console.log(`  Hooks executed: ${act.hooksExecuted}`);
  console.log(`  Archetypes created: ${act.archetypesCreated}`);
  console.log(`  Archetypes removed: ${act.archetypesRemoved}`);
  console.log("===================\n");
});

// Setup some entities
const parent = world.new();
world.set(parent, Position, { x: 0, y: 0 });

const children: any[] = [];
for (let i = 0; i < 5; i++) {
  const child = world.new();
  world.set(child, Position, { x: i * 10, y: 0 });
  world.set(child, Velocity, { x: 1, y: 0.5 });
  world.set(child, relation(ChildOf, parent));
  children.push(child);
}

console.log("Initial sync (should create archetypes + relations)");
world.sync();

// Cause some migrations by adding/removing components
console.log("Adding/removing components to trigger migrations...");
for (const c of children) {
  world.remove(c, Velocity);
}
world.sync();

world.set(children[0], Velocity, { x: 2, y: 0 });
world.sync();

// Add a hook to observe hook execution counting
world.hook([Position, Velocity], {
  on_set: () => {},
});

console.log("Triggering hook + more structural changes");
world.set(children[1], Velocity, { x: 3, y: 1 });
world.sync();

// Clean up some entities to potentially remove archetypes
console.log("Deleting some children...");
world.delete(children[2]);
world.delete(children[3]);
world.sync();

// Dispose the collector when done
collector[Symbol.dispose]();

console.log("Collector disposed. Further syncs will not trigger callbacks.");
world.set(parent, Position, { x: 100, y: 100 });
world.sync();

console.log("Done. This demonstrates typical usage for spotting:");
console.log("- Unexpected archetype growth (fragmentation)");
console.log("- High migration or hook execution counts");
console.log("- Command buffer iteration spikes");
console.log("- Leaking entities or relations (watch entity/freelist numbers over time)");
