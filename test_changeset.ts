import { ComponentChangeset } from "./src/changeset";

const changeset = new ComponentChangeset();

// Simulate the scenario
changeset.delete(-4398046512128 as any); // Delete parent1 relation
changeset.set(-4398046512129 as any, undefined); // Add parent2 relation

console.log("Changeset removes:", Array.from(changeset.removes));
console.log("Changeset adds:", Array.from(changeset.adds.keys()));
