import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-agent-prompts-"));
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

function assertWikiMaintenancePrompts(module) {
  const executionContext = module.buildWikiExecutionDraftRequestContext();
  assert.match(executionContext, /不要重写维护计划/);
  assert.match(executionContext, /最多输出一个 sidet-action 块/);
  assert.match(executionContext, /不要先问用户是否确认/);
  assert.match(executionContext, /如果这次更适合只补 Index/);

  const planPrompt = module.buildWikiMaintenancePlanPrompt([
    "来源：本条消息之前的当前 Sidet 对话。",
    "来源对话：测试对话"
  ]);
  assert.match(planPrompt, /你是 Sidet 的 Wiki 管家/);
  assert.match(planPrompt, /第一阶段只在已识别知识库自己的根目录内判断和检索，不跨目录聚合/);
  assert.match(planPrompt, /## 需要用户确认/);
}

function assertToolActionPrompts(module) {
  const fullContext = module.buildSidetFileToolContext();
  assert.match(fullContext, /直接输出 sidet-action；卡片本身就是确认入口/);
  assert.match(fullContext, /块后不得再输出任何文字/);
  assert.match(fullContext, /外层用三个反引号/);
  assert.match(fullContext, /卡片会展示完整预览并等待用户确认/);
  assert.match(fullContext, /不要写“同上”“见上文”“完整内容如上述预览”/);
  assert.match(fullContext, /没有可靠来源就省略 sources/);
  assert.match(fullContext, /sidet-action 块必须是回复的最后内容/);
  assert.match(fullContext, /不要创建空模板、占位笔记或“待更新”笔记/);
  assert.match(fullContext, /其余没有明确知识库意图的笔记.*默认用 Drafts/);
  assert.match(fullContext, /路径不在 Sidet\/Wiki 下时.*不要写 YAML frontmatter/);
  assert.match(fullContext, /上面的示例是 Drafts，故意不带 YAML/);
  assert.match(fullContext, /动作主题必须对应用户当前要求/);
  assert.match(fullContext, /外部网页用 \[标题\]\(URL\)/);
  assert.match(fullContext, /也不要建议创建空白笔记或模板/);
  assert.match(fullContext, /视为明确的写入要求/);
  assert.match(fullContext, /不要重复同一 targetPath 和内容/);

  const summaryContext = module.buildSidetFileToolSummaryContext();
  assert.match(summaryContext, /直接输出一条 sidet-action/);
  assert.match(summaryContext, /唯一的确认步骤/);
  assert.match(summaryContext, /sidet-action 放在回复最后/);
  assert.match(summaryContext, /不要创建空模板、占位笔记或“待更新”笔记/);
}

function assertWebSearchPrompts(module) {
  const decisionContext = module.buildSidetResearchDecisionContext();
  assert.ok(decisionContext.includes("```sidet-action"));
  assert.match(decisionContext, /question 只写自然语言研究问题/);

  const queryContext = module.buildSidetResearchQueryContext("测试问题", new Date("2026-11-27T00:00:00+08:00"), 4);
  assert.match(queryContext, /查询行只写自然语言关键词/);

  const finalAnswerContext = module.buildSidetResearchFinalAnswerContext({
    hasEvidence: true,
    exhausted: false
  });
  assert.ok(finalAnswerContext.includes("```sidet-action"));
  assert.match(finalAnswerContext, /不要先问是否确认/);

  const repairContext = module.buildSidetResearchFinalAnswerRepairContext();
  assert.ok(repairContext.includes("```sidet-action"));
}

function assertPromptMode(module) {
  assert.equal(module.resolveSidetFileToolPromptMode({ text: "再帮我创建一条" }), "full");
  assert.equal(module.resolveSidetFileToolPromptMode({ text: "一条完整的笔记" }), "full");
  assert.equal(module.resolveSidetFileToolPromptMode({ text: "我要写入笔记" }), "full");
  assert.equal(module.resolveSidetFileToolPromptMode({ text: "帮我查一下最近的新闻" }), "compact");
}

function assertNestedCodeFenceAction(module) {
  const text = [
    "说明",
    "````sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Drafts/code.md",
    "title: 代码笔记",
    "reason: 验证四反引号外层",
    "---",
    "# 代码笔记",
    "```javascript",
    "const a = 1",
    "```",
    "## 之后",
    "正文",
    "````",
    "请确认"
  ].join("\n");
  const preview = module.parseSidetToolActionPreview(text, "test");
  assert.ok(preview);
  assert.ok(preview.content.includes("```javascript"));
  assert.ok(preview.content.includes("## 之后"));
  const trimmed = module.trimTextAfterSidetActionBlock(text);
  assert.ok(trimmed.endsWith("````"));
  assert.ok(!trimmed.includes("请确认"));

  const crlf = text.replace(/\n/g, "\r\n");
  const crlfPreview = module.parseSidetToolActionPreview(crlf, "test");
  assert.ok(crlfPreview);
  assert.ok(crlfPreview.content.includes("```javascript"));
  assert.ok(crlfPreview.content.includes("## 之后"));
  const crlfTrimmed = module.trimTextAfterSidetActionBlock(crlf);
  assert.ok(crlfTrimmed.endsWith("````"));
  assert.ok(!crlfTrimmed.includes("请确认"));

  const legacy = [
    "说明",
    "```sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Drafts/code-legacy.md",
    "title: 代码笔记",
    "reason: 验证旧三反引号外层",
    "---",
    "# 代码笔记",
    "```javascript",
    "const a = 1",
    "```",
    "## 之后",
    "正文",
    "```",
    "请确认"
  ].join("\n");
  const legacyPreview = module.parseSidetToolActionPreview(legacy, "test");
  assert.ok(legacyPreview);
  assert.ok(legacyPreview.content.includes("```javascript"));
  assert.ok(legacyPreview.content.includes("## 之后"));

  const legacyCrlfPreview = module.parseSidetToolActionPreview(legacy.replace(/\n/g, "\r\n"), "test");
  assert.ok(legacyCrlfPreview);
  assert.ok(legacyCrlfPreview.content.includes("```javascript"));
  assert.ok(legacyCrlfPreview.content.includes("## 之后"));

  const unclosed = [
    "```sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Drafts/code-unclosed.md",
    "title: 代码笔记",
    "reason: 验证漏写外层闭合围栏",
    "---",
    "# 代码笔记",
    "```javascript",
    "console.log(1);",
    "```"
  ].join("\n");
  const unclosedPreview = module.parseSidetToolActionPreview(unclosed, "test");
  assert.ok(unclosedPreview);
  assert.ok(unclosedPreview.content.includes("```javascript"));
  assert.equal((unclosedPreview.content.match(/```/g) ?? []).length, 2);

  // 正文里不带语言标记的三反引号代码块不能被当成外层闭合，否则笔记会被截断。
  const bareFence = [
    "```sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Drafts/bare-fence.md",
    "---",
    "# 代码笔记",
    "```",
    "const a = 1;",
    "```",
    "## 之后",
    "正文",
    "```"
  ].join("\n");
  const bareFencePreview = module.parseSidetToolActionPreview(bareFence, "test");
  assert.ok(bareFencePreview);
  assert.ok(bareFencePreview.content.includes("const a = 1;"));
  assert.ok(bareFencePreview.content.includes("## 之后"));
  assert.ok(module.trimTextAfterSidetActionBlock(bareFence).endsWith("正文\n```"));

  // 缺 header 分隔线时不能从正文里的 `---` 兜底切分。
  const missingSeparator = [
    "```sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Drafts/missing.md",
    "# 标题",
    "前言",
    "---",
    "尾部",
    "```"
  ].join("\n");
  assert.equal(module.parseSidetToolActionPreview(missingSeparator, "test"), null);

  // 路径归一化与去引号：预览和写入必须看到同一个目标。
  const normalized = module.parseSidetToolActionPreview([
    "```sidet-action",
    "tool: create_note",
    'targetPath: "./Sidet/Drafts/normalized.md"',
    "---",
    "# 笔记",
    "正文",
    "```"
  ].join("\n"), "test");
  assert.equal(normalized?.targetPath, "Sidet/Drafts/normalized.md");

  // Wiki 的 updatedAt 用消息时间而不是解析时刻，签名/内容必须稳定。
  const wikiAction = [
    "```sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Wiki/Stable.md",
    "---",
    "# 稳定标题",
    "正文",
    "```"
  ].join("\n");
  const wikiA = module.parseSidetToolActionPreview(wikiAction, "test", {
    updatedAt: "2026-11-28 0315"
  });
  const wikiB = module.parseSidetToolActionPreview(wikiAction, "test", {
    updatedAt: "2026-11-28 0315"
  });
  assert.ok(wikiA && wikiB);
  assert.equal(wikiA.content, wikiB.content);
  assert.ok(wikiA.content.includes("2026-11-28 0315"));
}

function assertSidetActionTailTrim(module) {
  const withAction = [
    "说明",
    "```sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Drafts/a.md",
    "title: A",
    "reason: test",
    "---",
    "# A",
    "正文",
    "```",
    "请确认是否创建"
  ].join("\n");
  const trimmed = module.trimTextAfterSidetActionBlock(withAction);
  assert.ok(trimmed.endsWith("```"));
  assert.ok(!trimmed.includes("请确认"));
  assert.ok(trimmed.startsWith("说明"));

  const noAction = "普通回答\n没有动作";
  assert.equal(module.trimTextAfterSidetActionBlock(noAction), noAction);

  const malformed = ["```sidet-action", "tool: create_note", "---", "# A", "```", "尾巴"].join("\n");
  assert.equal(module.trimTextAfterSidetActionBlock(malformed), malformed);

  const realWorld = [
    "根据你的要求，我将创建一篇纯 Markdown 格式的笔记，不含 Wiki 字段或追问内容。以下是拟创建的笔记内容：",
    "```sidet-action",
    "tool: create_note",
    "targetPath: Sidet/Drafts/Sidet 提示词验证五.md",
    "title: Sidet 提示词验证五",
    "reason: 创建用户指定的基础提示词测试笔记",
    "---",
    "# Sidet 提示词验证五",
    "",
    "这是一个普通笔记示例，主要验证：",
    "1. 纯 Markdown 书写格式",
    "2. 不含 Wiki 结构字段",
    "3. 卡片式单次输出完整性",
    "",
    "测试要点：",
    "- 双链测试 [[示例笔记]]",
    "- 列表测试",
    "- 基础排版",
    "",
    "无需追问补充，本条笔记应保持独立完整。",
    "```",
    "",
    "请确认是否创建该笔记，或需要调整内容。笔记将保存在 `Sidet/Drafts/` 目录下，后期可自由移动到其他位置。"
  ].join("\n");
  const realTrimmed = module.trimTextAfterSidetActionBlock(realWorld);
  assert.ok(realTrimmed.endsWith("```"));
  assert.ok(!realTrimmed.includes("请确认"));

  const visible = module.stripSidetActionAndFollowing(realWorld);
  assert.ok(visible.startsWith("根据你的要求"));
  assert.ok(!visible.includes("sidet-action"));
  assert.ok(!visible.includes("请确认"));

  assert.equal(module.stripSidetActionAndFollowing("普通回答"), "普通回答");
}

function assertDraftGenerationPrompts(module) {
  const memoryBundle = module.buildMemoryCandidateBundle({
    conversationTitle: "测试对话",
    usefulMessageCount: 4,
    attachmentCount: 2
  });
  assert.equal(memoryBundle.kind, "memory-candidate");
  assert.ok(memoryBundle.footer?.some((line) => line.includes("本轮无记忆候选")));

  const skillPrompt = module.buildSkillGenerationPrompt();
  assert.match(skillPrompt, /完整 Skill 以 SKILL\.md 口径输出/);
  assert.match(skillPrompt, /## 不写入/);

  const draftBundle = module.buildDraftNotePreviewBundle({
    conversationTitle: "测试对话",
    usefulMessageCount: 3,
    attachmentCount: 0
  });
  assert.equal(draftBundle.kind, "draft-note-preview");
  assert.ok(draftBundle.footer?.some((line) => line.includes("建议保存位置")));
}

async function main() {
  try {
    const wikiModule = await loadBundledModule("src/agent/prompts/wiki-maintenance-prompts.ts");
    const draftModule = await loadBundledModule("src/agent/prompts/draft-generation-prompts.ts");
    const toolActionModule = await loadBundledModule("src/agent/prompts/tool-action-prompt.ts");
    const webSearchModule = await loadBundledModule("src/agent/prompts/web-search-prompts.ts");
    const actionProtocolModule = await loadBundledModule("src/agent/actions/agent-tool-protocol.ts");
    const baseContextModule = await loadBundledModule("src/agent/prompts/base-request-context.ts");
    assertWikiMaintenancePrompts(wikiModule);
    assertDraftGenerationPrompts(draftModule);
    assertToolActionPrompts(toolActionModule);
    assertWebSearchPrompts(webSearchModule);
    assertNestedCodeFenceAction(actionProtocolModule);
    assertSidetActionTailTrim(actionProtocolModule);
    assertPromptMode(baseContextModule);
    console.log("sidet agent prompts logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
