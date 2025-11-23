import { component, relation } from "./src/entity";
import { World } from "./src/world";

const world = new World();

const ChildOf = component({ dontFragment: true, exclusive: true });
const PositionId = component();

const parent1 = world.new();
const parent2 = world.new();
const child = world.new();

world.set(child, PositionId);
world.set(child, relation(ChildOf, parent1));
world.sync();

console.log("After setting parent1:");
console.log("has parent1:", world.has(child, relation(ChildOf, parent1)));
console.log("has parent2:", world.has(child, relation(ChildOf, parent2)));

const entityData1 = (world as any).entityToArchetype.get(child).getEntity(child);
console.log("Entity data keys:", Array.from(entityData1.keys()));

// Change parent (exclusive should replace)
console.log("\n=== Setting parent2 ===");
world.set(child, relation(ChildOf, parent2));
world.sync();

console.log("\nAfter setting parent2:");
console.log("has parent1:", world.has(child, relation(ChildOf, parent1)));
console.log("has parent2:", world.has(child, relation(ChildOf, parent2)));

const entityData2 = (world as any).entityToArchetype.get(child).getEntity(child);
console.log("Entity data keys:", Array.from(entityData2.keys()));
