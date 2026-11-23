import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-user-skill-index-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, `${path.basename(relativePath, ".ts")}.mjs`);

  await build({
    entryPoints: [path.join(rootDir, relativePath)],
    bundle: true,
    format: "esm",
    platform: "node",
    alias: {
      obsidian: path.join(rootDir, "scripts", "test-stubs", "obsidian.ts")
    },
    outfile,
    logLevel: "silent"
  });

  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function createSkillFile(pathname, mtime) {
  return {
    path: pathname,
    basename: "SKILL",
    stat: {
      mtime
    }
  };
}

async function assertUserSkillIndexCachesParsedSkills(module) {
  const matchingFile = createSkillFile("Sidet/Skills/web-search/SKILL.md", 10);
  const otherFile = createSkillFile("Sidet/Skills/note-write/SKILL.md", 20);
  const skillBodies = new Map([
    [matchingFile.path, [
      "---",
      "name: 联网搜索协作",
      "description: 当需要联网搜索时使用。",
      "---",
      "",
      "# 联网搜索协作",
      "",
      "## 触发词",
      "- 联网搜索",
      "- 网页搜索",
      "",
      "## 边界",
      "- 只做路由提示。"
    ].join("\n")],
    [otherFile.path, [
      "---",
      "name: 笔记写入",
      "description: 当需要写笔记时使用。",
      "---",
      "",
      "# 笔记写入",
      "",
      "## 触发词",
      "- 写入笔记",
      "",
      "## 边界",
      "- 不处理联网。"
    ].join("\n")]
  ]);
  let readCount = 0;
  const app = {
    vault: {
      getMarkdownFiles: () => [matchingFile, otherFile],
      cachedRead: async (file) => {
        readCount += 1;
        return skillBodies.get(file.path) ?? "";
      }
    }
  };

  const index = new module.UserSkillIndex(app);
  const first = await index.findRelevantSkills("帮我做一次联网搜索", [], 5);
  const second = await index.findRelevantSkills("帮我做一次联网搜索", [], 5);

  assert.ok(first.length >= 1, "first lookup should return at least one relevant skill");
  assert.ok(second.length >= 1, "second lookup should still return relevant skills");
  assert.equal(first[0]?.name, "联网搜索协作", "matching skill should rank first on the initial lookup");
  assert.equal(second[0]?.name, "联网搜索协作", "matching skill should still rank first on the cached lookup");
  assert.equal(readCount, 2, "unchanged skill files should only be read once");

  matchingFile.stat.mtime = 30;
  const third = await index.findRelevantSkills("帮我做一次联网搜索", [], 5);
  assert.ok(third.length >= 1, "lookup should still work after one skill file changes");
  assert.equal(third[0]?.name, "联网搜索协作", "matching skill should stay first after a targeted cache refresh");
  assert.equal(readCount, 3, "only the changed skill file should be re-read");
}

async function main() {
  try {
    const module = await loadBundledModule("src/agent/skills/user-skills.ts");
    await assertUserSkillIndexCachesParsedSkills(module);
    console.log("user skill index logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
