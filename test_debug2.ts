import { component, relation, decodeRelationId } from "./src/entity";
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
const entityData1 = (world as any).entityToArchetype.get(child).getEntity(child);
console.log("Entity components:");
for (const [key, value] of entityData1) {
  if (key < 0) {
    const decoded = decodeRelationId(key);
    console.log(`  Relation: componentId=${decoded.componentId}, targetId=${decoded.targetId}, type=${decoded.type}`);
  } else {
    console.log(`  Component: ${key}`);
  }
}

// Now manually check what the exclusive logic should find
const rel1 = relation(ChildOf, parent1);
const rel2 = relation(ChildOf, parent2);
console.log("\nRelation IDs:");
console.log(`  parent1 relation:`, rel1);
console.log(`  parent2 relation:`, rel2);

world.set(child, relation(ChildOf, parent2));
world.sync();

console.log("\nAfter setting parent2:");
const entityData2 = (world as any).entityToArchetype.get(child).getEntity(child);
console.log("Entity components:");
for (const [key, value] of entityData2) {
  if (key < 0) {
    const decoded = decodeRelationId(key);
    console.log(`  Relation: componentId=${decoded.componentId}, targetId=${decoded.targetId}, type=${decoded.type}`);
  } else {
    console.log(`  Component: ${key}`);
  }
}
