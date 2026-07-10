import { pipeline } from "@codehz/pipeline";

import { World, component, type Query } from "../src";

// Define component types
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number };

// Define component IDs
const Position = component<Position>();
const Velocity = component<Velocity>();
const Health = component<Health>();

// Create the world
const world = new World();

// Cache queries
const movementQuery: Query = world.createQuery([Position, Velocity]);
const damageQuery: Query = world.createQuery([Position, Health]);
const renderQuery: Query = world.createQuery([Position]);

// Build game loop using pipeline
// Pass execution order is determined by addition order; no need to manually manage dependencies
const gameLoop = pipeline<{ deltaTime: number }>()
  // Input pass - handle user input
  .addPass(() => {
    console.log(`[InputPass] Processing input at ${Date.now()}`);
    // Keyboard/mouse input handling etc. goes here
  })
  // Movement pass - update positions
  .addPass((env) => {
    console.log(`[MovementPass] Updating positions`);
    movementQuery.forEach([Position, Velocity], (entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
      console.log(`  Entity ${entity}: Position (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  })
  // Damage pass - calculate damage based on position
  .addPass(() => {
    console.log(`[DamagePass] Applying damage based on position`);
    damageQuery.forEach([Position, Health], (entity, position, health) => {
      // Calculate damage based on position (example logic)
      const damage = Math.abs(position.x) * 0.1;
      health.value -= damage;
      console.log(`  Entity ${entity}: Health reduced by ${damage.toFixed(2)}, now ${health.value.toFixed(2)}`);
    });
  })
  // Render pass - render entities
  .addPass(() => {
    console.log(`[RenderPass] Rendering entities`);
    renderQuery.forEach([Position], (entity, position) => {
      console.log(`  Rendering Entity ${entity} at (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  })
  // Sync pass - must be called as the last pass to execute all deferred commands
  .addPass(() => {
    world.sync();
  })
  .build();

function main() {
  console.log("ECS Advanced Scheduling Demo - Pipeline-based Execution");
  console.log("========================================================");

  // Create some entities
  const entity1 = world
    .spawn()
    .with(Position, { x: 0, y: 0 })
    .with(Velocity, { x: 2, y: 1 })
    .with(Health, { value: 100 })
    .build();
  void entity1;

  const entity2 = world
    .spawn()
    .with(Position, { x: 5, y: 3 })
    .with(Velocity, { x: -1, y: 0.5 })
    .with(Health, { value: 80 })
    .build();
  void entity2;

  // Execute initial sync
  world.sync();

  // Run a few frames
  console.log("\n--- Frame 1 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\n--- Frame 2 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\nDemo completed!");
}

main();
