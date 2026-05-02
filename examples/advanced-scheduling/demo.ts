import { pipeline } from "@codehz/pipeline";
import { World, component, type Query } from "../../src";

// Define component types
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };
type Health = { value: number };

// Define component IDs
const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const HealthId = component<Health>();

// Create the world
const world = new World();

// Cache queries
const movementQuery: Query = world.createQuery([PositionId, VelocityId]);
const damageQuery: Query = world.createQuery([PositionId, HealthId]);
const renderQuery: Query = world.createQuery([PositionId]);

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
    movementQuery.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
      console.log(`  Entity ${entity}: Position (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  })
  // Damage pass - calculate damage based on position
  .addPass(() => {
    console.log(`[DamagePass] Applying damage based on position`);
    damageQuery.forEach([PositionId, HealthId], (entity, position, health) => {
      // Calculate damage based on position (example logic)
      const damage = Math.abs(position.x) * 0.1;
      health.value -= damage;
      console.log(`  Entity ${entity}: Health reduced by ${damage.toFixed(2)}, now ${health.value.toFixed(2)}`);
    });
  })
  // Render pass - render entities
  .addPass(() => {
    console.log(`[RenderPass] Rendering entities`);
    renderQuery.forEach([PositionId], (entity, position) => {
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
  const entity1 = world.new();
  world.set(entity1, PositionId, { x: 0, y: 0 });
  world.set(entity1, VelocityId, { x: 2, y: 1 });
  world.set(entity1, HealthId, { value: 100 });

  const entity2 = world.new();
  world.set(entity2, PositionId, { x: 5, y: 3 });
  world.set(entity2, VelocityId, { x: -1, y: 0.5 });
  world.set(entity2, HealthId, { value: 80 });

  // Execute initial sync
  world.sync();

  // Run a few frames
  console.log("\n--- Frame 1 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\n--- Frame 2 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\nDemo completed!");
}

if (import.meta.main) {
  main();
}
