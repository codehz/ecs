import { pipeline } from "@codehz/pipeline";
import { component, relation, World, type Query } from "../../src";

// Define component types
type Position = { x: number; y: number };
type Velocity = { x: number; y: number };

// Define component IDs
const PositionId = component<Position>();
const VelocityId = component<Velocity>();
const ChildOf = component({ exclusive: true }); // Exclusive relation component

// Create the world
const world = new World();

// Pre-cache queries
const movementQuery: Query = world.createQuery([PositionId, VelocityId]);

// Build game loop using pipeline
const gameLoop = pipeline<{ deltaTime: number }>()
  // Movement pass
  .addPass((env) => {
    movementQuery.forEach([PositionId, VelocityId], (entity, position, velocity) => {
      position.x += velocity.x * env.deltaTime;
      position.y += velocity.y * env.deltaTime;
      console.log(`Entity ${entity}: Position (${position.x.toFixed(2)}, ${position.y.toFixed(2)})`);
    });
  })
  // Sync pass - must be called as the last pass to execute all deferred commands
  .addPass(() => {
    world.sync();
  })
  .build();

function main() {
  console.log("ECS Simple Demo");

  // Create entity 1
  const entity1 = world.new();
  world.set(entity1, PositionId, { x: 0, y: 0 });
  world.set(entity1, VelocityId, { x: 1, y: 0.5 });

  // Create entity 2
  const entity2 = world.new();
  world.set(entity2, PositionId, { x: 10, y: 10 });
  world.set(entity2, VelocityId, { x: -0.5, y: 1 });

  // Demonstrate Exclusive Relations
  console.log("\nExclusive Relations Demo:");
  const parent1 = world.new();
  const parent2 = world.new();
  const child = world.new();

  // ChildOf is already marked as exclusive in component definition

  // Add first parent relation
  world.set(child, relation(ChildOf, parent1));
  world.sync();
  console.log(`Child has ChildOf(parent1): ${world.has(child, relation(ChildOf, parent1))}`);
  console.log(`Child has ChildOf(parent2): ${world.has(child, relation(ChildOf, parent2))}`);

  // Add second parent relation - should replace the first
  world.set(child, relation(ChildOf, parent2));
  world.sync();
  console.log(`After adding ChildOf(parent2):`);
  console.log(`Child has ChildOf(parent1): ${world.has(child, relation(ChildOf, parent1))}`);
  console.log(`Child has ChildOf(parent2): ${world.has(child, relation(ChildOf, parent2))}`);

  // Register component hooks
  world.hook([PositionId], {
    on_set: (entityId, component) => {
      console.log(`Component set hook triggered: Entity ${entityId} Position is (${component.x}, ${component.y})`);
    },
  });

  world.hook([VelocityId], {
    on_remove: (entityId) => {
      console.log(`Component remove hook triggered: Entity ${entityId} removed Velocity component`);
    },
  });

  // Execute commands to apply component additions
  world.sync();

  // Run a few update cycles
  const deltaTime = 1.0; // 1 second
  for (let i = 0; i < 5; i++) {
    console.log(`\nUpdate ${i + 1}:`);
    gameLoop({ deltaTime });
  }

  // Demonstrate component removal hooks
  console.log("\nComponent Removal Demo:");
  world.remove(entity1, VelocityId);
  world.sync();

  console.log("\nDemo completed!");
}

// Run demo
main();
