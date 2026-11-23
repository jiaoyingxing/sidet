import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeConfigPath = path.join(rootDir, "runtime-artifacts.config.json");

const COMMON_TERMS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "into",
  "wiki",
  "sidet",
  "note",
  "notes",
  "markdown",
  "card",
  "concept",
  "page",
  "文件",
  "笔记",
  "内容",
  "当前",
  "这个",
  "那个",
  "我们",
  "一个",
  "可以",
  "需要",
  "问题",
  "功能",
  "概念",
  "页面"
]);

function resolveDefaultVaultRoot() {
  if (!existsSync(runtimeConfigPath)) {
    return rootDir;
  }

  try {
    const config = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
    const firstVault = Array.isArray(config.targets) ? config.targets[0]?.vault : "";
    return typeof firstVault === "string" && firstVault.trim() ? path.resolve(firstVault.trim()) : rootDir;
  } catch {
    return rootDir;
  }
}

function printHelp() {
  console.log(`Knowledge base check

Usage:
  node scripts/check-knowledge-bases.mjs [--vault-root <path>] [--knowledge-base <path-or-name>] [--query <text>] [--limit <n>] [--json]

Checks:
  - scans <vault-root> for Index.md
  - recognizes knowledge bases by minimal frontmatter:
      sidet_type: knowledge-base
      aliases
      summary
  - when --query is provided, only searches inside each recognized knowledge base root
`);
}

function parseArgs(argv) {
  const options = {
    vaultRoot: resolveDefaultVaultRoot(),
    knowledgeBase: "",
    query: "",
    limit: 5,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--vault-root" && next) {
      options.vaultRoot = path.resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--knowledge-base" && next) {
      options.knowledgeBase = next.trim();
      index += 1;
      continue;
    }
    if (arg === "--query" && next) {
      options.query = next.trim();
      index += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: ${next}`);
      }
      options.limit = parsed;
      index += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function normalizeScalarList(value) {
  if (Array.isArray(value)) {
    return unique(value.map((item) => String(item ?? "").trim()).filter(Boolean));
  }
  if (typeof value !== "string") {
    return [];
  }
  return unique(
    value
      .split(/[，,、;；\n]/g)
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseFrontmatter(text) {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return null;
  }
  const endIndex = normalized.indexOf("\n---\n", 4);
  if (endIndex < 0) {
    return null;
  }

  const lines = normalized.slice(4, endIndex).split("\n");
  const frontmatter = {};
  let currentKey = "";

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (keyMatch) {
      currentKey = keyMatch[1];
      const rawValue = keyMatch[2]?.trim() ?? "";
      if (rawValue === "") {
        frontmatter[currentKey] = [];
      } else if (rawValue === "[]") {
        frontmatter[currentKey] = [];
      } else {
        frontmatter[currentKey] = rawValue.replace(/^["']|["']$/g, "");
      }
      continue;
    }

    if (!currentKey || !Array.isArray(frontmatter[currentKey])) {
      continue;
    }

    const listMatch = /^-\s*(.*)$/.exec(line.trim());
    if (!listMatch) {
      continue;
    }
    frontmatter[currentKey].push(listMatch[1].trim().replace(/^["']|["']$/g, ""));
  }

  return frontmatter;
}

function stripFrontmatter(text) {
  const normalized = normalizeText(text);
  return normalized.startsWith("---")
    ? normalized.replace(/^---[\s\S]*?---/, "").trim()
    : normalized;
}

function inferSummary(body, maxChars = 140) {
  const paragraph = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^[-*#>`]/.test(line) && !line.startsWith("![["))
    ?? body.split("\n").map((line) => line.trim()).find(Boolean)
    ?? "";
  return paragraph.length <= maxChars ? paragraph : paragraph.slice(0, maxChars).trimEnd();
}

function isKnowledgeBaseFrontmatter(frontmatter) {
  const kind = typeof frontmatter?.sidet_type === "string"
    ? frontmatter.sidet_type.trim().toLowerCase()
    : typeof frontmatter?.type === "string"
      ? frontmatter.type.trim().toLowerCase()
      : "";
  const aliases = normalizeScalarList(frontmatter?.aliases);
  const summary = typeof frontmatter?.summary === "string" ? frontmatter.summary.trim() : "";

  return (kind === "knowledge-base" || kind === "knowledge-base-root" || kind === "index")
    && aliases.length > 0
    && summary.length > 0;
}

function walkFiles(rootPath, visitor) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !existsSync(current)) {
      continue;
    }

    const stat = statSync(current);
    if (!stat.isDirectory()) {
      continue;
    }

    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".obsidian" || entry.name === ".trash") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        visitor(fullPath);
      }
    }
  }
}

function getVaultRelativePath(vaultRoot, fullPath) {
  return path.relative(vaultRoot, fullPath).replace(/\\/g, "/");
}

function getKnowledgeBaseRootPath(indexPath) {
  return indexPath.replace(/\\/g, "/").replace(/\/Index\.md$/i, "");
}

function isWithinRoot(filePath, rootPath) {
  const normalizedFilePath = filePath.replace(/\\/g, "/");
  const normalizedRootPath = rootPath.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalizedRootPath) {
    return true;
  }
  return normalizedFilePath === `${normalizedRootPath}/Index.md`
    || normalizedFilePath.startsWith(`${normalizedRootPath}/`);
}

function extractTerms(text, limit = 28) {
  const lower = text.toLowerCase();
  const latinTerms = Array.from(lower.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g))
    .map((match) => match[0])
    .filter((term) => !COMMON_TERMS.has(term));
  const cjkTerms = [];

  for (const match of lower.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const segment = match[0];
    if (segment.length <= 6) {
      cjkTerms.push(segment);
      continue;
    }
    for (let index = 0; index < segment.length - 1 && cjkTerms.length < limit; index += 1) {
      cjkTerms.push(segment.slice(index, index + 2));
    }
  }

  return unique([...latinTerms, ...cjkTerms])
    .filter((term) => term.length >= 2 && !COMMON_TERMS.has(term))
    .slice(0, limit);
}

function scoreText(text, terms, weight) {
  const lower = text.toLowerCase();
  const matchedTerms = [];
  let score = 0;

  for (const term of terms) {
    if (!lower.includes(term)) {
      continue;
    }
    matchedTerms.push(term);
    score += weight;
  }

  return {
    score,
    matchedTerms
  };
}

function collectKnowledgeBases(vaultRoot) {
  const knowledgeBases = [];
  walkFiles(vaultRoot, (fullPath) => {
    if (path.basename(fullPath).toLowerCase() !== "index.md") {
      return;
    }

    const content = readFileSync(fullPath, "utf8");
    const frontmatter = parseFrontmatter(content);
    if (!isKnowledgeBaseFrontmatter(frontmatter)) {
      return;
    }

    const relativeIndexPath = getVaultRelativePath(vaultRoot, fullPath);
    const rootPath = getKnowledgeBaseRootPath(relativeIndexPath);
    const aliases = normalizeScalarList(frontmatter?.aliases);
    knowledgeBases.push({
      indexPath: relativeIndexPath,
      rootPath,
      displayName: aliases[0] || path.basename(rootPath) || "知识库",
      summary: typeof frontmatter?.summary === "string" ? frontmatter.summary.trim() : "",
      aliases,
      fileCount: 0
    });
  });

  const markdownFiles = [];
  walkFiles(vaultRoot, (fullPath) => {
    if (path.extname(fullPath).toLowerCase() !== ".md") {
      return;
    }
    markdownFiles.push(getVaultRelativePath(vaultRoot, fullPath));
  });

  for (const knowledgeBase of knowledgeBases) {
    knowledgeBase.fileCount = markdownFiles.filter((filePath) => isWithinRoot(filePath, knowledgeBase.rootPath)).length;
  }

  return knowledgeBases.sort((left, right) => left.rootPath.localeCompare(right.rootPath));
}

function selectKnowledgeBases(knowledgeBases, filterText) {
  if (!filterText) {
    return knowledgeBases;
  }

  const normalizedFilter = filterText.trim().toLowerCase();
  return knowledgeBases.filter((knowledgeBase) => {
    return knowledgeBase.rootPath.toLowerCase() === normalizedFilter
      || knowledgeBase.indexPath.toLowerCase() === normalizedFilter
      || knowledgeBase.displayName.toLowerCase() === normalizedFilter
      || knowledgeBase.aliases.some((alias) => alias.toLowerCase() === normalizedFilter);
  });
}

function searchKnowledgeBase(vaultRoot, knowledgeBase, query, limit) {
  const terms = extractTerms(query);
  if (terms.length === 0) {
    return [];
  }

  const results = [];
  walkFiles(path.join(vaultRoot, knowledgeBase.rootPath), (fullPath) => {
    if (path.extname(fullPath).toLowerCase() !== ".md") {
      return;
    }

    const relativePath = getVaultRelativePath(vaultRoot, fullPath);
    if (!isWithinRoot(relativePath, knowledgeBase.rootPath)) {
      return;
    }

    const raw = readFileSync(fullPath, "utf8");
    const frontmatter = parseFrontmatter(raw);
    const body = stripFrontmatter(raw);
    const summary = typeof frontmatter?.summary === "string" && frontmatter.summary.trim()
      ? frontmatter.summary.trim()
      : inferSummary(body);
    const aliases = normalizeScalarList(frontmatter?.aliases);
    const keywords = normalizeScalarList(frontmatter?.keywords);
    const title = path.basename(relativePath, ".md");

    const titleScore = scoreText(`${title}\n${relativePath}`, terms, 6);
    const summaryScore = scoreText(summary, terms, 5);
    const keywordScore = scoreText(`${aliases.join("\n")}\n${keywords.join("\n")}`, terms, 4);
    const bodyScore = scoreText(body.slice(0, 900), terms, 1);
    const score = titleScore.score + summaryScore.score + keywordScore.score + bodyScore.score;

    if (score <= 0) {
      return;
    }

    results.push({
      path: relativePath,
      title,
      summary,
      score,
      matchedTerms: unique([
        ...titleScore.matchedTerms,
        ...summaryScore.matchedTerms,
        ...keywordScore.matchedTerms,
        ...bodyScore.matchedTerms
      ])
    });
  });

  return results
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function printHuman(summary) {
  console.log(`Vault root: ${summary.vaultRoot}`);
  console.log(`Recognized knowledge bases: ${summary.knowledgeBases.length}`);

  if (summary.knowledgeBases.length === 0) {
    console.log("No knowledge bases recognized.");
    return;
  }

  for (const knowledgeBase of summary.knowledgeBases) {
    console.log(`- ${knowledgeBase.displayName}`);
    console.log(`  root: ${knowledgeBase.rootPath || "/"}`);
    console.log(`  index: ${knowledgeBase.indexPath}`);
    console.log(`  summary: ${knowledgeBase.summary}`);
    console.log(`  files: ${knowledgeBase.fileCount}`);

    if (!summary.query) {
      continue;
    }

    const results = summary.searchResults[knowledgeBase.indexPath] ?? [];
    if (results.length === 0) {
      console.log("  matches: none");
      continue;
    }

    console.log("  matches:");
    for (const result of results) {
      console.log(`    - ${result.path} (score: ${result.score}; terms: ${result.matchedTerms.join(" / ") || "n/a"})`);
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const vaultRoot = options.vaultRoot;

  if (!existsSync(vaultRoot) || !statSync(vaultRoot).isDirectory()) {
    throw new Error(`Vault root does not exist or is not a directory: ${vaultRoot}`);
  }

  const allKnowledgeBases = collectKnowledgeBases(vaultRoot);
  const selectedKnowledgeBases = selectKnowledgeBases(allKnowledgeBases, options.knowledgeBase);

  if (options.knowledgeBase && selectedKnowledgeBases.length === 0) {
    throw new Error(`Could not find knowledge base: ${options.knowledgeBase}`);
  }

  const summary = {
    vaultRoot,
    query: options.query,
    knowledgeBases: selectedKnowledgeBases,
    searchResults: {}
  };

  if (options.query) {
    for (const knowledgeBase of selectedKnowledgeBases) {
      summary.searchResults[knowledgeBase.indexPath] = searchKnowledgeBase(
        vaultRoot,
        knowledgeBase,
        options.query,
        options.limit
      );
    }
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  printHuman(summary);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
