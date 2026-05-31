import { pipeline } from "@codehz/pipeline";
import { World, component, relation, type Query } from "../src";

// Define component types
type Transform = { x: number; y: number; rotation: number; scale: number };
type LinearVelocity = { x: number; y: number };
type AngularVelocity = { degreesPerSecond: number };
type Name = { value: string };

// Define component IDs
const Name = component<Name>({ name: "Name" });
const LocalTransform = component<Transform>({ name: "LocalTransform" });
const WorldTransform = component<Transform>({ name: "WorldTransform" });
const LinearVelocity = component<LinearVelocity>({ name: "LinearVelocity" });
const AngularVelocity = component<AngularVelocity>({ name: "AngularVelocity" });
const ChildOf = component<void>({ exclusive: true, sparse: true, name: "ChildOf" });

// Create the world
const world = new World();

// Cache queries
const movementQuery: Query = world.createQuery([LocalTransform, LinearVelocity]);
const rotationQuery: Query = world.createQuery([LocalTransform, AngularVelocity]);
const transformQuery: Query = world.createQuery([Name, LocalTransform, WorldTransform]);
const renderQuery: Query = world.createQuery([Name, WorldTransform]);

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function copyTransform(target: Transform, source: Transform): void {
  target.x = source.x;
  target.y = source.y;
  target.rotation = source.rotation;
  target.scale = source.scale;
}

function composeTransform(local: Transform, parent?: Transform): Transform {
  if (!parent) {
    return { ...local };
  }

  const angle = toRadians(parent.rotation);
  const scaledX = local.x * parent.scale;
  const scaledY = local.y * parent.scale;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return {
    x: parent.x + scaledX * cos - scaledY * sin,
    y: parent.y + scaledX * sin + scaledY * cos,
    rotation: parent.rotation + local.rotation,
    scale: parent.scale * local.scale,
  };
}

function formatTransform(transform: Transform): string {
  return `pos=(${transform.x.toFixed(2)}, ${transform.y.toFixed(2)}) rot=${transform.rotation.toFixed(1)}deg scale=${transform.scale.toFixed(2)}`;
}

// NOTE: Before the relation/hierarchy companion tools, this required manually
// building a children map every frame + writing recursive propagation.
// Now we can use the built-in efficient helpers (getChildren + traverseDescendants).

// Build game loop using pipeline
// Pass execution order is determined by addition order; no need to manually manage dependencies
const gameLoop = pipeline<{ deltaTime: number }>()
  // Local movement pass - update local positions
  .addPass((env) => {
    console.log(`[LocalMovementPass] Updating local positions`);
    movementQuery.forEach([LocalTransform, LinearVelocity], (entity, localTransform, velocity) => {
      localTransform.x += velocity.x * env.deltaTime;
      localTransform.y += velocity.y * env.deltaTime;
      const name = world.get(entity, Name);
      console.log(`  ${name.value}: local pos=(${localTransform.x.toFixed(2)}, ${localTransform.y.toFixed(2)})`);
    });
  })
  // Local rotation pass - update local rotation
  .addPass((env) => {
    console.log(`[LocalRotationPass] Updating local rotations`);
    rotationQuery.forEach([LocalTransform, AngularVelocity], (entity, localTransform, angularVelocity) => {
      localTransform.rotation += angularVelocity.degreesPerSecond * env.deltaTime;
      const name = world.get(entity, Name);
      console.log(`  ${name.value}: local rot=${localTransform.rotation.toFixed(1)}deg`);
    });
  })
  // Hierarchy pass - propagate parent transforms into world transforms
  // (modernized with the new relation/hierarchy companion tools)
  .addPass(() => {
    console.log(`[HierarchyPass] Propagating world transforms`);

    transformQuery.forEach([Name, LocalTransform, WorldTransform], (entity, name, localTransform, worldTransform) => {
      if (world.has(entity, relation(ChildOf, "*"))) return; // skip non-roots

      copyTransform(worldTransform, composeTransform(localTransform));
      console.log(`  Root ${name.value}: ${formatTransform(worldTransform)}`);

      // Use the efficient built-in traverser (replaces manual Map + recursion)
      world.traverseDescendants(entity, ChildOf, (child, _depth, parent) => {
        if (!parent) return;
        const childName = world.get(child, Name);
        const local = world.get(child, LocalTransform);
        const childWorld = world.get(child, WorldTransform);
        const parentWorldT = world.get(parent, WorldTransform);
        copyTransform(childWorld, composeTransform(local, parentWorldT));
        console.log(`  Child ${childName.value}: ${formatTransform(childWorld)}`);
      });
    });
  })
  // Render pass - render propagated world transforms
  .addPass(() => {
    console.log(`[RenderPass] Rendering world transforms`);
    renderQuery.forEach([Name, WorldTransform], (_entity, name, worldTransform) => {
      console.log(`  ${name.value}: ${formatTransform(worldTransform)}`);
    });
  })
  // Sync pass - must be called as the last pass to execute all deferred commands
  .addPass(() => {
    world.sync();
  })
  .build();

function main() {
  console.log("ECS Parent-Child Hierarchy Demo - Transform Propagation");
  console.log("=======================================================");

  // Create a moving root entity
  const ship = world
    .spawn()
    .with(Name, { value: "Ship" })
    .with(LocalTransform, { x: 0, y: 0, rotation: 0, scale: 1 })
    .with(WorldTransform, { x: 0, y: 0, rotation: 0, scale: 1 })
    .with(LinearVelocity, { x: 1, y: 0.25 })
    .build();

  // Create a rotating child attached to the ship
  const turret = world
    .spawn()
    .with(Name, { value: "Turret" })
    .with(LocalTransform, { x: 2, y: 0, rotation: 0, scale: 1 })
    .with(WorldTransform, { x: 0, y: 0, rotation: 0, scale: 1 })
    .with(AngularVelocity, { degreesPerSecond: 45 })
    .with(relation(ChildOf, ship))
    .build();

  // Create a grandchild so propagation traverses multiple levels
  const muzzle = world
    .spawn()
    .with(Name, { value: "Muzzle" })
    .with(LocalTransform, { x: 1.5, y: 0.5, rotation: 0, scale: 1 })
    .with(WorldTransform, { x: 0, y: 0, rotation: 0, scale: 1 })
    .with(relation(ChildOf, turret))
    .build();
  void muzzle;

  // Create a second root entity to show independent hierarchies
  const drone = world
    .spawn()
    .with(Name, { value: "Drone" })
    .with(LocalTransform, { x: -4, y: 3, rotation: 15, scale: 0.75 })
    .with(WorldTransform, { x: -4, y: 3, rotation: 15, scale: 0.75 })
    .with(LinearVelocity, { x: 0.5, y: -0.25 })
    .build();
  void drone;

  // Execute initial sync
  world.sync();

  // Run an initial propagation frame so children receive their world transforms
  console.log("\n--- Initial Hierarchy ---");
  gameLoop({ deltaTime: 0.0 });

  // Run a few frames
  console.log("\n--- Frame 1 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\n--- Frame 2 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\n--- Frame 3 ---");
  gameLoop({ deltaTime: 1.0 });

  console.log("\nDemo completed!");
}

main();
