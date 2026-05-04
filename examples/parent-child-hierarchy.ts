import { pipeline } from "@codehz/pipeline";
import { World, component, relation, type EntityId, type Query } from "../src";

// Define component types
type Transform = { x: number; y: number; rotation: number; scale: number };
type LinearVelocity = { x: number; y: number };
type AngularVelocity = { degreesPerSecond: number };
type Name = { value: string };

// Define component IDs
const NameId = component<Name>({ name: "Name" });
const LocalTransformId = component<Transform>({ name: "LocalTransform" });
const WorldTransformId = component<Transform>({ name: "WorldTransform" });
const LinearVelocityId = component<LinearVelocity>({ name: "LinearVelocity" });
const AngularVelocityId = component<AngularVelocity>({ name: "AngularVelocity" });
const ChildOf = component<void>({ exclusive: true, dontFragment: true, name: "ChildOf" });

// Create the world
const world = new World();

// Cache queries
const movementQuery: Query = world.createQuery([LocalTransformId, LinearVelocityId]);
const rotationQuery: Query = world.createQuery([LocalTransformId, AngularVelocityId]);
const transformQuery: Query = world.createQuery([NameId, LocalTransformId, WorldTransformId]);
const childQuery: Query = world.createQuery([relation(ChildOf, "*")]);
const renderQuery: Query = world.createQuery([NameId, WorldTransformId]);

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

function buildChildrenByParent(): Map<EntityId, EntityId[]> {
  const childrenByParent = new Map<EntityId, EntityId[]>();

  childQuery.forEach([relation(ChildOf, "*")], (child, parents) => {
    const parent = parents[0]?.[0];
    if (parent === undefined) return;

    const children = childrenByParent.get(parent) ?? [];
    children.push(child);
    childrenByParent.set(parent, children);
  });

  return childrenByParent;
}

function propagateChildren(
  parent: EntityId,
  parentWorld: Transform,
  childrenByParent: Map<EntityId, EntityId[]>,
): void {
  const children = childrenByParent.get(parent);
  if (!children) return;

  for (const child of children) {
    const name = world.get(child, NameId);
    const local = world.get(child, LocalTransformId);
    const worldTransform = world.get(child, WorldTransformId);
    copyTransform(worldTransform, composeTransform(local, parentWorld));
    console.log(`  Child ${name.value}: ${formatTransform(worldTransform)}`);
    propagateChildren(child, worldTransform, childrenByParent);
  }
}

// Build game loop using pipeline
// Pass execution order is determined by addition order; no need to manually manage dependencies
const gameLoop = pipeline<{ deltaTime: number }>()
  // Local movement pass - update local positions
  .addPass((env) => {
    console.log(`[LocalMovementPass] Updating local positions`);
    movementQuery.forEach([LocalTransformId, LinearVelocityId], (entity, localTransform, velocity) => {
      localTransform.x += velocity.x * env.deltaTime;
      localTransform.y += velocity.y * env.deltaTime;
      const name = world.get(entity, NameId);
      console.log(`  ${name.value}: local pos=(${localTransform.x.toFixed(2)}, ${localTransform.y.toFixed(2)})`);
    });
  })
  // Local rotation pass - update local rotation
  .addPass((env) => {
    console.log(`[LocalRotationPass] Updating local rotations`);
    rotationQuery.forEach([LocalTransformId, AngularVelocityId], (entity, localTransform, angularVelocity) => {
      localTransform.rotation += angularVelocity.degreesPerSecond * env.deltaTime;
      const name = world.get(entity, NameId);
      console.log(`  ${name.value}: local rot=${localTransform.rotation.toFixed(1)}deg`);
    });
  })
  // Hierarchy pass - propagate parent transforms into world transforms
  .addPass(() => {
    console.log(`[HierarchyPass] Propagating world transforms`);
    const childrenByParent = buildChildrenByParent();

    transformQuery.forEach(
      [NameId, LocalTransformId, WorldTransformId],
      (entity, name, localTransform, worldTransform) => {
        if (world.has(entity, relation(ChildOf, "*"))) return;

        copyTransform(worldTransform, composeTransform(localTransform));
        console.log(`  Root ${name.value}: ${formatTransform(worldTransform)}`);
        propagateChildren(entity, worldTransform, childrenByParent);
      },
    );
  })
  // Render pass - render propagated world transforms
  .addPass(() => {
    console.log(`[RenderPass] Rendering world transforms`);
    renderQuery.forEach([NameId, WorldTransformId], (_entity, name, worldTransform) => {
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
  const ship = world.new();
  world.set(ship, NameId, { value: "Ship" });
  world.set(ship, LocalTransformId, { x: 0, y: 0, rotation: 0, scale: 1 });
  world.set(ship, WorldTransformId, { x: 0, y: 0, rotation: 0, scale: 1 });
  world.set(ship, LinearVelocityId, { x: 1, y: 0.25 });

  // Create a rotating child attached to the ship
  const turret = world.new();
  world.set(turret, NameId, { value: "Turret" });
  world.set(turret, LocalTransformId, { x: 2, y: 0, rotation: 0, scale: 1 });
  world.set(turret, WorldTransformId, { x: 0, y: 0, rotation: 0, scale: 1 });
  world.set(turret, AngularVelocityId, { degreesPerSecond: 45 });
  world.set(turret, relation(ChildOf, ship));

  // Create a grandchild so propagation traverses multiple levels
  const muzzle = world.new();
  world.set(muzzle, NameId, { value: "Muzzle" });
  world.set(muzzle, LocalTransformId, { x: 1.5, y: 0.5, rotation: 0, scale: 1 });
  world.set(muzzle, WorldTransformId, { x: 0, y: 0, rotation: 0, scale: 1 });
  world.set(muzzle, relation(ChildOf, turret));

  // Create a second root entity to show independent hierarchies
  const drone = world.new();
  world.set(drone, NameId, { value: "Drone" });
  world.set(drone, LocalTransformId, { x: -4, y: 3, rotation: 15, scale: 0.75 });
  world.set(drone, WorldTransformId, { x: -4, y: 3, rotation: 15, scale: 0.75 });
  world.set(drone, LinearVelocityId, { x: 0.5, y: -0.25 });

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
