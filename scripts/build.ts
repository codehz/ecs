// scripts/dist.ts - 构建脚本

import { $ } from "bun";
import { build as tsdownBuild } from "tsdown";

export async function build() {
  const startTime = Date.now();

  // 清空 dist 目录
  console.log("🧹 Cleaning dist directory...");
  await $`rm -rf dist`;

  const entrypoints = ["src/index.ts"];
  console.log(`📋 Found ${entrypoints.length} entrypoints to build`);

  // 使用 Bun.build 构建所有入口点
  console.log("🔨 Building workflow library...");
  await tsdownBuild({
    entry: entrypoints,
    outDir: "dist",
    dts: true,
    sourcemap: true,
  });

  // 输出构建结果
  const buildTime = Date.now() - startTime;
  console.log(`✅ Build successful in ${buildTime}ms!`);

  // 生成类型定义
  console.log("📝 Generating TypeScript declarations...");
  await $`bunx tsc --project tsconfig.build.json`;
  console.log("✅ TypeScript declarations generated!");
}

// 如果直接运行此脚本，执行构建
if (import.meta.main) {
  await build();
}
