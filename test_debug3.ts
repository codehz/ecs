import { component, relation, decodeRelationId, getDetailedIdType, isExclusiveComponent } from "./src/entity";
import { World } from "./src/world";

const world = new World();

const ChildOf = component({ dontFragment: true, exclusive: true });
const PositionId = component();

console.log("ChildOf componentId:", ChildOf);
console.log("ChildOf is exclusive:", isExclusiveComponent(ChildOf));

const parent1 = world.new();
const parent2 = world.new();
const child = world.new();

world.set(child, PositionId);
world.set(child, relation(ChildOf, parent1));
world.sync();

const rel2 = relation(ChildOf, parent2);
const rel2DetailedType = getDetailedIdType(rel2);
console.log("\nSetting relation to parent2:");
console.log("  relation ID:", rel2);
console.log("  detailed type:", rel2DetailedType);
console.log("  is exclusive:", isExclusiveComponent(rel2DetailedType.componentId!));

// Check what's in the entity now
const entityData1 = (world as any).entityToArchetype.get(child).getEntity(child);
console.log("\nCurrent entity components before set:");
for (const [key, value] of entityData1) {
  const detailedType = getDetailedIdType(key);
  console.log(`  ${key}:`, detailedType);
}

world.set(child, relation(ChildOf, parent2));
world.sync();

const entityData2 = (world as any).entityToArchetype.get(child).getEntity(child);
console.log("\nEntity components after set:");
for (const [key, value] of entityData2) {
  const detailedType = getDetailedIdType(key);
  console.log(`  ${key}:`, detailedType);
}
