import { $ } from "bun";
import { build as tsdownBuild } from "tsdown";

const startTime = Date.now();

console.log("🧹 Cleaning dist directory...");
await $`rm -rf dist`;

console.log("🔨 Building...");
await tsdownBuild({
  entry: {
    index: "src/index.ts",
    testing: "src/testing/index.ts",
  },
  outDir: "dist",
  dts: true,
  sourcemap: true,
  hash: false,
});

console.log(`✅ Build successful in ${Date.now() - startTime}ms!`);
