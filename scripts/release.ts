// MIT License
//
// Copyright (c) 2025 codehz
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "tsdown";

console.log("🚀 Starting release process...");
const startTime = Date.now();

// 获取最新 git tag
console.log("🏷️  Getting latest git tag...");
const tagOutput = await Bun.$`git describe --tags --abbrev=0`;
const tag = tagOutput.text().trim();
const version = tag.startsWith("v") ? tag.slice(1) : tag;
console.log(`📦 Version: ${version}`);

const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;

// 运行构建
console.log("🔨 Running build process...");
const entries = [
  { name: "index", path: "/index.ts" },
  { name: "testing", path: "/testing/index.ts" },
];
await build({
  entry: Object.fromEntries(entries.map((e) => [e.name, `src${e.path}`])),
  outDir: "dist",
  dts: true,
  sourcemap: true,
  hash: false,
});

// 生成 exports
const exports: Record<string, any> = Object.fromEntries(
  entries.map((e) => [
    `.${e.name === "index" ? "" : "/" + e.name}`,
    {
      types: `./${e.name}.d.mts`,
      import: `./${e.name}.mjs`,
    },
  ]),
);
console.log(`📦 Generated exports for ${Object.keys(exports).length} files`);

// 创建 dist/package.json
console.log("📄 Creating dist/package.json...");
const publishPkg = {
  name: pkg.name,
  version: pkg.version,
  license: pkg.license,
  keywords: pkg.keywords,
  repository: pkg.repository,
  type: pkg.type,
  main: "./index.mjs",
  types: "./index.d.mts",
  exports,
  peerDependencies: pkg.peerDependencies,
};

writeFileSync(join("dist", "package.json"), JSON.stringify(publishPkg, null, 2));
console.log("✅ dist/package.json created");

// 复制 LICENSE 文件到 dist
console.log("📋 Copying LICENSE file...");
await Bun.$`cp LICENSE dist/LICENSE`;
console.log("✅ LICENSE copied");

// 复制所有 README 文件到 dist
console.log("📖 Copying README files...");
const readmeFiles = readdirSync(".").filter(
  (f) => typeof f === "string" && f.startsWith("README") && f.endsWith(".md"),
);
for (const file of readmeFiles) {
  await Bun.$`cp ${file} dist/${file}`;
}
console.log(`✅ ${readmeFiles.length} README files copied`);

const totalTime = Date.now() - startTime;
console.log(`🎉 Release script completed in ${totalTime}ms! Ready for publish.`);
