import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

/**
 * 工具层与测试要共享同一个 obsidian stub 里的 TFile 类，才能让 `instanceof TFile` 成立；
 * 因此用 stdin 入口把协议、服务与 stub 类打进同一个 bundle，而不是分开 bundle。
 */
async function loadAgentToolsHarness() {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-agent-tools-"));
  tempDirs.push(tempDir);
  const outfile = path.join(tempDir, "agent-tools-harness.mjs");

  await build({
    stdin: {
      contents: [
        `export { VaultToolService } from "./src/agent/tools/vault-tool-service";`,
        `export * from "./src/agent/tools/tool-protocol";`,
        `export { AGENT_TOOL_NAMES } from "./src/agent/tools/tool-types";`,
        `export { AGENT_TOOL_DEFINITIONS, getAgentToolDefinition, resolveAgentToolDefinitions } from "./src/agent/tools/tool-registry";`,
        `export { stripSidetProtocolBlocks } from "./src/agent/web-search/sidet-protocol";`,
        `export { TFile, Vault, MetadataCache } from "obsidian";`
      ].join("\n"),
      resolveDir: rootDir,
      sourcefile: "agent-tools-test-entry.ts",
      loader: "ts"
    },
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

function createFile(TFile, filePath, content = "", mtime = 0) {
  const file = new TFile();
  file.path = filePath;
  file.basename = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  file.extension = filePath.slice(filePath.lastIndexOf(".") + 1);
  file.stat = { ctime: mtime, mtime, size: content.length };
  return file;
}

function createDefaultResolver(files) {
  return (linkpath) => files.find((file) => file.path === linkpath)
    ?? files.find((file) => file.path === `${linkpath}.md`)
    ?? files.find((file) => file.path.endsWith(`/${linkpath}.md`))
    ?? files.find((file) => file.basename === linkpath)
    ?? null;
}

function createApp(Harness, documents, options = {}) {
  const files = documents.map((document) => createFile(Harness.TFile, document.path, document.content, document.mtime));
  const contents = new Map(documents.map((document) => [document.path, document.content]));
  const vault = new Harness.Vault(files, contents);
  const metadataCache = new Harness.MetadataCache(
    new Map(options.caches ?? []),
    options.resolveLink ?? createDefaultResolver(files)
  );
  metadataCache.resolvedLinks = options.resolvedLinks ?? {};
  return { app: { vault, metadataCache }, files };
}

function createService(Harness, app, queryWikiMemory = async () => []) {
  return new Harness.VaultToolService({ app, queryWikiMemory });
}

function createWikiMatch(Harness, fields) {
  return {
    file: createFile(Harness.TFile, fields.path, "", 0),
    kind: fields.kind ?? "knowledge-card",
    score: 1,
    summary: fields.summary ?? "",
    outline: fields.outline ?? [],
    relatedLinks: fields.relatedLinks ?? [],
    sourceLinks: [],
    matchedTerms: [],
    matchedFragments: fields.matchedFragments ?? [],
    excerpt: fields.excerpt ?? "",
    truncated: false,
    routeHint: "",
    structured: true
  };
}

function assertParseInvocation(protocol) {
  const search = protocol.parseAgentToolInvocation([
    "```sidet-tool",
    "tool: search_notes",
    "query: 项目 计划",
    "limit: 3",
    "```"
  ].join("\n"));
  assert.ok(search, "search_notes invocation should parse");
  assert.equal(search.tool, "search_notes");
  assert.equal(search.query, "项目 计划");
  assert.equal(search.limit, 3);
  assert.equal(search.path, null);

  const read = protocol.parseAgentToolInvocation([
    "```sidet-tool",
    "tool: read_note",
    "path: Projects/Alpha.md",
    "heading: 计划",
    "```"
  ].join("\n"));
  assert.ok(read, "read_note invocation should parse");
  assert.equal(read.path, "Projects/Alpha.md");
  assert.equal(read.heading, "计划");

  const links = protocol.parseAgentToolInvocation([
    "```sidet-tool",
    "tool: note_links",
    "path: Projects/Alpha.md",
    "```"
  ].join("\n"));
  assert.ok(links, "note_links invocation should parse");

  const wiki = protocol.parseAgentToolInvocation([
    "```sidet-tool",
    "tool: wiki_memory",
    "query: 注意力机制",
    "```"
  ].join("\n"));
  assert.ok(wiki, "wiki_memory invocation should parse");

  const firstOfTwo = protocol.parseAgentToolInvocation([
    "```sidet-tool",
    "tool: search_notes",
    "query: first",
    "```",
    "",
    "```sidet-tool",
    "tool: search_notes",
    "query: second",
    "```"
  ].join("\n"));
  assert.equal(firstOfTwo.query, "first", "only the first tool block should be parsed");
}

function assertMalformedInvocations(protocol) {
  const unknownTool = [
    "```sidet-tool",
    "tool: delete_note",
    "path: Projects/Alpha.md",
    "```"
  ].join("\n");
  assert.equal(protocol.parseAgentToolInvocation(unknownTool), null);
  assert.equal(protocol.isAgentToolInvocationMalformed(unknownTool), true);

  const missingRequired = [
    "```sidet-tool",
    "tool: search_notes",
    "```"
  ].join("\n");
  assert.equal(protocol.parseAgentToolInvocation(missingRequired), null);
  assert.equal(protocol.isAgentToolInvocationMalformed(missingRequired), true);

  const missingPath = [
    "```sidet-tool",
    "tool: read_note",
    "query: 计划",
    "```"
  ].join("\n");
  assert.equal(protocol.parseAgentToolInvocation(missingPath), null);

  const emptyBlock = ["```sidet-tool", "```"].join("\n");
  assert.equal(protocol.parseAgentToolInvocation(emptyBlock), null);
  assert.equal(protocol.isAgentToolInvocationMalformed(emptyBlock), true);

  assert.equal(protocol.parseAgentToolInvocation("没有工具块"), null);
  assert.equal(protocol.isAgentToolInvocationMalformed("没有工具块"), false);

  // 截断型协议失败：有 opener、没有闭合围栏，也必须进修复路径。
  const unclosed = [
    "```sidet-tool",
    "tool: read_note",
    "path: Projects/Alpha.md"
  ].join("\n");
  assert.equal(protocol.parseAgentToolInvocation(unclosed), null);
  assert.equal(protocol.isAgentToolInvocationMalformed(unclosed), true);
}

function assertResultBlockProtocol(protocol) {
  const result = { tool: "read_note", status: "ok", content: "path: A.md\n---\n正文内容" };
  const block = protocol.buildAgentToolResultBlock(result);
  assert.ok(block.startsWith("```sidet-tool-result\ntool: read_note\nstatus: ok\n---\n"));
  assert.ok(block.endsWith("\n```"));

  const parsed = protocol.parseAgentToolResultBlock(block);
  assert.deepEqual(parsed, result, "result block should round-trip");

  const errorBlock = protocol.buildAgentToolResultBlock({
    tool: "read_note",
    status: "error",
    content: "未找到笔记"
  });
  const parsedError = protocol.parseAgentToolResultBlock(errorBlock);
  assert.equal(parsedError.status, "error");

  const emptyContent = [
    "```sidet-tool-result",
    "tool: read_note",
    "status: ok",
    "---",
    "   ",
    "```"
  ].join("\n");
  assert.equal(protocol.parseAgentToolResultBlock(emptyContent), null);
  assert.equal(protocol.isAgentToolResultBlockMalformed(emptyContent), true);

  const badStatus = [
    "```sidet-tool-result",
    "tool: read_note",
    "status: maybe",
    "---",
    "内容",
    "```"
  ].join("\n");
  assert.equal(protocol.parseAgentToolResultBlock(badStatus), null);
  assert.equal(protocol.parseAgentToolResultBlock("普通文本"), null);
}

function assertProtocolStrip(protocol) {
  const stripped = protocol.stripSidetProtocolBlocks([
    "前文",
    "",
    "```sidet-tool",
    "tool: read_note",
    "path: Projects/Alpha.md",
    "```",
    "",
    "中间保留",
    "",
    "```sidet-tool-result",
    "tool: read_note",
    "status: ok",
    "---",
    "正文",
    "```",
    "",
    "后文保留"
  ].join("\n"));
  assert.equal(stripped, "前文\n\n中间保留\n\n后文保留");
}

function assertToolRegistry(Harness) {
  const expectedNames = ["search_notes", "read_note", "note_links", "wiki_memory", "web_research"];
  assert.deepEqual(
    [...Harness.AGENT_TOOL_NAMES],
    expectedNames,
    "AGENT_TOOL_NAMES should remain the single source of tool names"
  );
  assert.deepEqual(
    Object.keys(Harness.AGENT_TOOL_DEFINITIONS).sort(),
    [...expectedNames].sort(),
    "registry keys should match AGENT_TOOL_NAMES"
  );

  for (const name of expectedNames) {
    const definition = Harness.AGENT_TOOL_DEFINITIONS[name];
    assert.ok(definition, `${name} should have a definition`);
    assert.equal(definition.name, name);
    assert.equal(definition.readOnly, true, `${name} should be read-only`);
    assert.equal(
      definition.sideEffectScope,
      name === "web_research" ? "network" : "none",
      `${name} should declare its side effect scope`
    );
    assert.ok(
      Number.isFinite(definition.timeoutMs) && definition.timeoutMs > 0,
      `${name} should declare a positive execution timeout`
    );
    assert.deepEqual(Harness.getAgentToolDefinition(name), definition);

    const parsed = Harness.parseAgentToolInvocation([
      "```sidet-tool",
      `tool: ${name}`,
      name === "read_note" || name === "note_links" ? "path: Projects/Alpha.md" : "query: 项目 计划",
      "```"
    ].join("\n"));
    assert.ok(parsed, `parser should accept ${name}`);
    assert.equal(parsed.tool, name);
    assert.equal(Harness.isAgentToolName(name), true);
  }
  assert.equal(Harness.isAgentToolName("delete_note"), false);

  const vaultOnly = Harness.resolveAgentToolDefinitions({ webResearch: false });
  assert.equal(
    vaultOnly.web_research,
    undefined,
    "auto web search off should drop the web tool from the turn table"
  );
  assert.deepEqual(
    Object.keys(vaultOnly).sort(),
    ["search_notes", "read_note", "note_links", "wiki_memory"].sort()
  );
  const withWeb = Harness.resolveAgentToolDefinitions({ webResearch: true });
  assert.ok(withWeb.web_research, "auto web search on should expose the web tool");
  assert.equal(withWeb.search_notes.name, "search_notes");
}

/**
 * 联网工具只由对话运行时的组合执行器承接；vault 服务命中只说明误路由，
 * 必须给出错误结果而不是静默成功或抛异常。
 */
async function assertWebToolMisroute(service) {
  const result = await service.execute({
    tool: "web_research",
    query: "今天的新闻",
    path: null,
    heading: null,
    limit: null
  });
  assert.equal(result.status, "error");
  assert.match(result.content, /联网工具需要在对话运行时执行/);
}

async function assertSearchNotes(service) {
  const alpha = await service.execute({
    tool: "search_notes",
    query: "Alpha",
    path: null,
    heading: null,
    limit: null
  });
  assert.equal(alpha.status, "ok");
  assert.match(alpha.content, /命中 2 篇笔记（最多 5 篇）/);
  assert.ok(
    alpha.content.indexOf("Projects/Alpha.md") < alpha.content.indexOf("Projects/Beta.md"),
    "title or path hits should rank before body-only hits"
  );
  assert.match(alpha.content, /1\. Projects\/Alpha\.md（标题 \/ 路径命中）/);
  assert.match(alpha.content, /片段：/);

  const snippetLine = alpha.content.split("\n").find((line) => line.includes("片段："));
  assert.ok(snippetLine, "a hit should carry a snippet");
  assert.ok(snippetLine.length <= "   片段：".length + 160, "snippet should stay within 160 chars");

  const longSnippet = await service.execute({
    tool: "search_notes",
    query: "长",
    path: null,
    heading: null,
    limit: null
  });
  assert.equal(longSnippet.status, "ok");
  const longSnippetLine = longSnippet.content.split("\n").find((line) => line.includes("片段："));
  assert.ok(longSnippetLine.length <= "   片段：".length + 160, "long note snippet should stay within 160 chars");

  const empty = await service.execute({
    tool: "search_notes",
    query: "NoSuchNeedle",
    path: null,
    heading: null,
    limit: null
  });
  assert.equal(empty.status, "ok");
  assert.match(empty.content, /没有找到匹配「NoSuchNeedle」的 Markdown 笔记/);

  const capped = await service.execute({
    tool: "search_notes",
    query: "LimitNeedle",
    path: null,
    heading: null,
    limit: 99
  });
  assert.match(capped.content, /命中 5 篇笔记（最多 5 篇）/);
  assert.equal(
    capped.content.split("\n").filter((line) => /^\d+\. Limit\/L\d+\.md/.test(line)).length,
    5,
    "limit should be capped at 5"
  );

  const bounded = await service.execute({
    tool: "search_notes",
    query: "ZebraNeedle",
    path: null,
    heading: null,
    limit: null
  });
  assert.match(bounded.content, /没有找到匹配「ZebraNeedle」/, "read cap and scan cap should hide out-of-window hits");

  const scanBoundary = await service.execute({
    tool: "search_notes",
    query: "ScanBoundaryTarget",
    path: null,
    heading: null,
    limit: null
  });
  assert.match(
    scanBoundary.content,
    /没有找到匹配「ScanBoundaryTarget」/,
    "files outside the 400-file scan window should not be searched"
  );
}

async function assertReadNote(service) {
  const full = await service.execute({
    tool: "read_note",
    query: null,
    path: "Projects/Alpha.md",
    heading: null,
    limit: null
  });
  assert.equal(full.status, "ok");
  assert.match(full.content, /^path: Projects\/Alpha\.md\ntruncated: false\n---\n# Alpha/);

  const withoutExtension = await service.execute({
    tool: "read_note",
    query: null,
    path: "Projects/Alpha",
    heading: null,
    limit: null
  });
  assert.equal(withoutExtension.status, "ok", "path without .md should resolve through linkpath lookup");

  const section = await service.execute({
    tool: "read_note",
    query: null,
    path: "Projects/Alpha.md",
    heading: "计划",
    limit: null
  });
  assert.equal(section.status, "ok");
  assert.match(section.content, /heading: 计划/);
  assert.match(section.content, /第一阶段内容/);
  assert.doesNotMatch(section.content, /备注内容/, "heading read should stop at the next sibling heading");

  const missingHeading = await service.execute({
    tool: "read_note",
    query: null,
    path: "Projects/Alpha.md",
    heading: "不存在的小节",
    limit: null
  });
  assert.equal(missingHeading.status, "error");
  assert.match(missingHeading.content, /未找到标题「不存在的小节」/);
  assert.match(missingHeading.content, /可用标题/);

  const missingFile = await service.execute({
    tool: "read_note",
    query: null,
    path: "Missing/Nope.md",
    heading: null,
    limit: null
  });
  assert.equal(missingFile.status, "error");
  assert.match(missingFile.content, /未找到 Markdown 笔记/);

  const nonMarkdown = await service.execute({
    tool: "read_note",
    query: null,
    path: "Assets/report.pdf",
    heading: null,
    limit: null
  });
  assert.equal(nonMarkdown.status, "error");
  assert.match(nonMarkdown.content, /目标不是 Markdown 笔记/);

  const emptyNote = await service.execute({
    tool: "read_note",
    query: null,
    path: "Projects/Empty.md",
    heading: null,
    limit: null
  });
  assert.equal(emptyNote.status, "ok");
  assert.match(emptyNote.content, /（该笔记没有正文。）/);

  const truncated = await service.execute({
    tool: "read_note",
    query: null,
    path: "Long/Truncated.md",
    heading: null,
    limit: null
  });
  assert.equal(truncated.status, "ok");
  assert.match(truncated.content, /truncated: true/);
  assert.match(truncated.content, /内容已截断至 4000 字符/);
  assert.ok(truncated.content.length <= 4000, "read_note result should stay within the 4000-char budget");
}

function assertNoteLinks(service) {
  const hub = service.execute({
    tool: "note_links",
    query: null,
    path: "Links/Hub.md",
    heading: null,
    limit: null
  });
  return hub.then((result) => {
    assert.equal(result.status, "ok");
    assert.match(result.content, /outgoing: 4/);
    assert.match(result.content, /incoming: 2/);
    assert.match(result.content, /- Links\/A\.md（A）/);
    assert.match(result.content, /- Missing（未解析）/);
    assert.match(result.content, /- Links\/Source\.md（Source）/);

    return service.execute({
      tool: "note_links",
      query: null,
      path: "Links/Lonely.md",
      heading: null,
      limit: null
    });
  }).then((lonely) => {
    assert.equal(lonely.status, "ok");
    assert.match(lonely.content, /没有出链，也没有其他笔记链接到它/);

    return service.execute({
      tool: "note_links",
      query: null,
      path: "Missing/Nope.md",
      heading: null,
      limit: null
    });
  }).then((missing) => {
    assert.equal(missing.status, "error");
    assert.match(missing.content, /未找到 Markdown 笔记/);

    return service.execute({
      tool: "note_links",
      query: null,
      path: "Assets/report.pdf",
      heading: null,
      limit: null
    });
  }).then((nonMarkdown) => {
    assert.equal(nonMarkdown.status, "error");
    assert.match(nonMarkdown.content, /目标不是 Markdown 笔记/);

    return service.execute({
      tool: "note_links",
      query: null,
      path: "Links/Many.md",
      heading: null,
      limit: null
    });
  }).then((many) => {
    assert.match(many.content, /outgoing: 20/);
    assert.match(many.content, /incoming: 20/);
    const outgoingLines = many.content
      .split("## 出链")[1]
      .split("## 入链")[0]
      .split("\n")
      .filter((line) => line.startsWith("- "));
    assert.equal(outgoingLines.length, 20, "outgoing links should be capped at 20");
  });
}

async function assertWikiMemory(Harness, app) {
  const queries = [];
  const service = createService(Harness, app, async (query) => {
    queries.push(query);
    return [
      createWikiMatch(Harness, {
        path: "Sidet/Wiki/Alpha/Index.md",
        kind: "knowledge-card",
        summary: "Alpha 卡摘要",
        outline: ["# 定义", "## 变体"],
        relatedLinks: ["Beta", "Gamma"],
        matchedFragments: ["「Alpha 是……」"],
        excerpt: "Alpha 正文摘录"
      }),
      createWikiMatch(Harness, {
        path: "Sidet/Wiki/Beta.md",
        kind: "concept-page",
        summary: "Beta 概念页",
        excerpt: "Beta 概念正文"
      })
    ];
  });

  const result = await service.execute({
    tool: "wiki_memory",
    query: "Alpha 注意力",
    path: null,
    heading: null,
    limit: null
  });
  assert.deepEqual(queries, ["Alpha 注意力"]);
  assert.equal(result.status, "ok");
  assert.match(result.content, /Wiki 记忆命中 2 条（最多 3 条）/);
  assert.match(result.content, /title: Index/);
  assert.match(result.content, /kind: 知识卡/);
  assert.match(result.content, /summary: Alpha 卡摘要/);
  assert.match(result.content, /- # 定义/);
  assert.match(result.content, /related: \[\[Beta\]\]，\[\[Gamma\]\]/);
  assert.match(result.content, /fragment: 「Alpha 是……」/);
  assert.match(result.content, /kind: 概念页/);
  assert.match(result.content, /fragment: Beta 概念正文/);

  const emptyService = createService(Harness, app, async () => []);
  const empty = await emptyService.execute({
    tool: "wiki_memory",
    query: "什么都没有",
    path: null,
    heading: null,
    limit: null
  });
  assert.equal(empty.status, "ok");
  assert.match(empty.content, /Wiki 记忆中没有找到与「什么都没有」相关的条目/);

  const manyService = createService(Harness, app, async () => [1, 2, 3, 4, 5].map((index) =>
    createWikiMatch(Harness, { path: `Sidet/Wiki/W${index}.md`, summary: `W${index}` })
  ));
  const many = await manyService.execute({
    tool: "wiki_memory",
    query: "W",
    path: null,
    heading: null,
    limit: null
  });
  assert.equal(
    many.content.split("\n").filter((line) => /^\d+\. path: /.test(line)).length,
    3,
    "wiki_memory should surface at most 3 entries"
  );

  const failingService = createService(Harness, app, async () => {
    throw new Error("索引不可用");
  });
  const failed = await failingService.execute({
    tool: "wiki_memory",
    query: "Alpha",
    path: null,
    heading: null,
    limit: null
  });
  assert.equal(failed.status, "error");
  assert.match(failed.content, /Wiki 记忆查询失败：索引不可用/);
}

async function assertExecutionToResultBlock(Harness, service) {
  const result = await service.execute({
    tool: "read_note",
    query: null,
    path: "Projects/Alpha.md",
    heading: null,
    limit: null
  });
  const block = Harness.buildAgentToolResultBlock(result);
  const parsed = Harness.parseAgentToolResultBlock(block);
  assert.ok(parsed, "execution result should serialize into a parseable result block");
  assert.equal(parsed.tool, "read_note");
  assert.equal(parsed.status, "ok");
  assert.match(parsed.content, /path: Projects\/Alpha\.md/);
}

async function main() {
  try {
    const Harness = await loadAgentToolsHarness();
    assertParseInvocation(Harness);
    assertMalformedInvocations(Harness);
    assertResultBlockProtocol(Harness);
    assertProtocolStrip(Harness);
    assertToolRegistry(Harness);

    const bulkDocuments = Array.from({ length: 400 }, (_, index) => ({
      path: `Bulk/Bulk${String(index).padStart(3, "0")}.md`,
      content: `bulk placeholder ${index}`,
      mtime: 2
    }));
    const documents = [
      {
        path: "Projects/Alpha.md",
        content: "# Alpha\n\n## 计划\n第一阶段内容。\n\n## 备注\n备注内容。",
        mtime: 500
      },
      {
        path: "Projects/Beta.md",
        content: "# Beta\n\nAlpha Alpha Alpha 只是正文反复出现。",
        mtime: 400
      },
      { path: "Projects/Empty.md", content: "", mtime: 300 },
      { path: "Notes/Gamma.md", content: "# Gamma\n\n与检索无关的内容。", mtime: 200 },
      { path: "Links/Hub.md", content: "# Hub", mtime: 150 },
      { path: "Links/A.md", content: "# A", mtime: 140 },
      { path: "Links/B.md", content: "# B", mtime: 130 },
      { path: "Links/C.md", content: "# C", mtime: 120 },
      { path: "Links/Lonely.md", content: "# Lonely", mtime: 110 },
      { path: "Links/Many.md", content: "# Many", mtime: 100 },
      { path: "Assets/report.pdf", content: "pdf", mtime: 90 },
      {
        path: "Long/Truncated.md",
        content: `# Truncated\n\n${"长".repeat(5000)}`,
        mtime: 80
      },
      {
        path: "Long/SliceCut.md",
        content: `${"x".repeat(130_000)} ZebraNeedle`,
        mtime: 700
      },
      { path: "Zzz/Oldest.md", content: "ScanBoundaryTarget", mtime: 1 },
      ...Array.from({ length: 6 }, (_, index) => ({
        path: `Limit/L${index + 1}.md`,
        content: `LimitNeedle ${index}`,
        mtime: 60 - index
      })),
      ...bulkDocuments
    ];

    const manyOutgoingLinks = Array.from({ length: 25 }, (_, index) => ({ link: `Missing/T${index}` }));
    const manyIncomingLinks = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [`Sources/S${index}.md`, { "Links/Many.md": 1 }])
    );
    const caches = new Map([
      ["Links/Hub.md", {
        links: [
          { link: "Links/A" },
          { link: "B#小节" },
          { link: "Links/A|别名" },
          { link: "Missing" }
        ],
        embeds: [{ link: "Links/C" }]
      }],
      ["Links/Many.md", { links: manyOutgoingLinks }]
    ]);
    const resolvedLinks = {
      "Links/Source.md": { "Links/Hub.md": 2 },
      "Links/Other.md": { "Links/Hub.md": 1 },
      "Links/Unrelated.md": { "Links/A.md": 1 },
      ...manyIncomingLinks
    };

    const { app } = createApp(Harness, documents, { caches, resolvedLinks });
    const service = createService(Harness, app);

    await assertSearchNotes(service);
    await assertReadNote(service);
    await assertNoteLinks(service);
    await assertWikiMemory(Harness, app);
    await assertExecutionToResultBlock(Harness, service);
    await assertWebToolMisroute(service);

    console.log("agent tools logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
