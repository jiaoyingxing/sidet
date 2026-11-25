import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs = [];

async function loadBundledModule(relativePath) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-web-research-loop-"));
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

function createMessageFactory() {
  let index = 0;
  return (role, text) => ({
    id: `m${index++}`,
    role,
    text,
    createdAt: 1,
    status: "done"
  });
}

function makeRound(round, question, state) {
  const sourceIndex = state.pages.length + 1;
  return {
    round,
    question,
    queries: [`query ${round}`],
    providerLabel: "Bing",
    results: [
      {
        title: `Result ${round}`,
        url: `https://example.com/${round}`,
        host: "example.com",
        snippet: `snippet ${round}`
      }
    ],
    pages: [
      {
        sourceIndex,
        title: `Page ${round}`,
        url: `https://example.com/page-${round}`,
        host: "example.com",
        content: `content ${round}`,
        snippet: `snippet ${round}`
      }
    ],
    failedPageCount: 0,
    evidenceText: `evidence ${round}`,
    resultBlock: `\`\`\`sidet-research-result\nround: ${round}\n---\nevidence ${round}\n\`\`\``,
    status: "ok",
    searchError: null
  };
}

function createBaseOptions(overrides = {}) {
  return {
    initialQuestion: "原始问题",
    baseMessages: [],
    decisionContext: "决策上下文",
    createMessage: createMessageFactory(),
    budgets: {
      maxRounds: 3,
      maxQueries: 12,
      maxPages: 9,
      maxWallClockMs: 10_000,
      maxModelCalls: 11
    },
    now: () => 0,
    ...overrides
  };
}

async function assertDirectAnswer(loopModule) {
  const calls = {
    rounds: [],
    decisions: 0,
    repairs: 0,
    final: [],
    visible: [],
    commits: []
  };
  const loop = await loopModule.runWebResearchLoop(createBaseOptions({
    callDecisionModel: async (messages) => {
      calls.decisions += 1;
      assert.equal(messages[0].text, "决策上下文");
      return { contentText: "最终答案", reasoningText: "" };
    },
    callRepairModel: async () => {
      calls.repairs += 1;
      throw new Error("should not repair");
    },
    runResearchRound: async (round, question, _budget, state) => {
      calls.rounds.push({ round, question, pages: state.pages.length });
      return makeRound(round, question, state);
    },
    streamFinalAnswer: async () => {
      calls.final.push("called");
      return "final";
    },
    onVisibleContent: (text) => calls.visible.push(text),
    commitSources: (state) => calls.commits.push(state.pages.map((page) => page.sourceIndex)),
    signal: new AbortController().signal
  }));

  assert.equal(loop.finalText, "最终答案");
  assert.equal(loop.aborted, false);
  assert.equal(loop.exhausted, false);
  assert.equal(loop.rounds, 1);
  assert.equal(calls.rounds.length, 1);
  assert.equal(calls.rounds[0].question, "原始问题");
  assert.equal(calls.decisions, 1);
  assert.equal(calls.repairs, 0);
  assert.deepEqual(calls.final, [], "a visible answer should not enter final-answer repair");
  assert.deepEqual(calls.visible, ["最终答案"]);
  assert.deepEqual(calls.commits, [[1]]);
}

async function assertSecondResearchThenAnswer(loopModule) {
  const calls = { rounds: [], decisions: 0, visible: [], commits: [] };
  let decisionCount = 0;
  const loop = await loopModule.runWebResearchLoop(createBaseOptions({
    callDecisionModel: async () => {
      calls.decisions += 1;
      decisionCount += 1;
      if (decisionCount === 1) {
        return {
          contentText: "```sidet-research\nquestion: 更聚焦的问题\nreason: 需要补细节\n```",
          reasoningText: ""
        };
      }
      return { contentText: "第二轮之后的答案", reasoningText: "" };
    },
    callRepairModel: async () => {
      throw new Error("should not repair");
    },
    runResearchRound: async (round, question, _budget, state, reason) => {
      calls.rounds.push({ round, question, reason, pages: state.pages.length });
      return makeRound(round, question, state);
    },
    streamFinalAnswer: async () => "final",
    onVisibleContent: (text) => calls.visible.push(text),
    commitSources: (state) => calls.commits.push(state.pages.map((page) => page.sourceIndex)),
    signal: new AbortController().signal
  }));

  assert.equal(loop.finalText, "第二轮之后的答案");
  assert.equal(loop.rounds, 2);
  assert.equal(calls.rounds.length, 2);
  assert.equal(calls.rounds[0].question, "原始问题");
  assert.equal(calls.rounds[1].question, "更聚焦的问题");
  assert.equal(calls.rounds[1].reason, "需要补细节");
  assert.deepEqual(calls.commits, [[1, 2]], "sources should accumulate in fetch order");
  assert.deepEqual(calls.visible, ["第二轮之后的答案"]);
  assert.equal(calls.decisions, 2);
}

async function assertMalformedRepair(loopModule) {
  const calls = { repairs: 0, visible: [], commits: [] };
  const loop = await loopModule.runWebResearchLoop(createBaseOptions({
    callDecisionModel: async () => ({
      contentText: "sidet-research\nquestion: 没有围栏的协议",
      reasoningText: ""
    }),
    callRepairModel: async (messages) => {
      calls.repairs += 1;
      assert.equal(messages.at(-1).role, "assistant");
      assert.match(messages.at(-1).text, /sidet-research/);
      return { contentText: "补正后的最终答案", reasoningText: "" };
    },
    runResearchRound: async (round, question, _budget, state) => makeRound(round, question, state),
    streamFinalAnswer: async () => "final",
    onVisibleContent: (text) => calls.visible.push(text),
    commitSources: (state) => calls.commits.push(state.pages.map((page) => page.sourceIndex)),
    signal: new AbortController().signal
  }));

  assert.equal(loop.finalText, "补正后的最终答案");
  assert.equal(calls.repairs, 1);
  assert.deepEqual(calls.visible, ["补正后的最终答案"]);
  assert.deepEqual(calls.commits, [[1]]);
}

async function assertRepairEmptyForcesFinalAnswer(loopModule) {
  const calls = { repairs: 0, final: [], finalExhausted: null, commits: [] };
  const loop = await loopModule.runWebResearchLoop(createBaseOptions({
    callDecisionModel: async () => ({
      contentText: "```sidet-fetch\npick1: 1\n```",
      reasoningText: ""
    }),
    callRepairModel: async () => {
      calls.repairs += 1;
      return { contentText: "", reasoningText: "" };
    },
    runResearchRound: async (round, question, _budget, state) => makeRound(round, question, state),
    streamFinalAnswer: async (_messages, state) => {
      calls.final.push("called");
      calls.finalExhausted = state.exhausted;
      return "阶段性答案";
    },
    onVisibleContent: () => undefined,
    commitSources: (state) => calls.commits.push(state.pages.map((page) => page.sourceIndex)),
    signal: new AbortController().signal
  }));

  assert.equal(loop.finalText, "阶段性答案");
  assert.equal(loop.exhausted, true);
  assert.equal(calls.repairs, 1);
  assert.equal(calls.finalExhausted, true);
  assert.deepEqual(calls.commits, [[1]]);
}

async function assertRoundBudgetExhausted(loopModule) {
  const calls = { rounds: 0, finalExhausted: null, commits: [] };
  const loop = await loopModule.runWebResearchLoop(createBaseOptions({
    budgets: {
      maxRounds: 1,
      maxQueries: 12,
      maxPages: 9,
      maxWallClockMs: 10_000,
      maxModelCalls: 11
    },
    callDecisionModel: async () => ({
      contentText: "```sidet-research\nquestion: 还想继续研究\n```",
      reasoningText: ""
    }),
    callRepairModel: async () => {
      throw new Error("should not repair");
    },
    runResearchRound: async (round, question, _budget, state) => {
      calls.rounds += 1;
      return makeRound(round, question, state);
    },
    streamFinalAnswer: async (_messages, state) => {
      calls.finalExhausted = state.exhausted;
      return "预算用完后的阶段性答案";
    },
    onVisibleContent: () => undefined,
    commitSources: (state) => calls.commits.push(state.pages.map((page) => page.sourceIndex)),
    signal: new AbortController().signal
  }));

  assert.equal(loop.finalText, "预算用完后的阶段性答案");
  assert.equal(loop.exhausted, true);
  assert.equal(calls.rounds, 1, "maxRounds should prevent a second research round");
  assert.equal(calls.finalExhausted, true);
  assert.deepEqual(calls.commits, [[1]]);
}

async function assertAbort(loopModule) {
  const controller = new AbortController();
  const calls = { visible: [], commits: [], final: [] };
  const loop = await loopModule.runWebResearchLoop(createBaseOptions({
    callDecisionModel: async () => {
      controller.abort();
      return { contentText: "不应显示的答案", reasoningText: "" };
    },
    callRepairModel: async () => {
      throw new Error("should not repair");
    },
    runResearchRound: async (round, question, _budget, state) => makeRound(round, question, state),
    streamFinalAnswer: async () => {
      calls.final.push("called");
      return "final";
    },
    onVisibleContent: (text) => calls.visible.push(text),
    commitSources: (state) => calls.commits.push(state.pages.map((page) => page.sourceIndex)),
    signal: controller.signal
  }));

  assert.equal(loop.aborted, true);
  assert.equal(loop.finalText, "");
  assert.deepEqual(calls.visible, [], "aborted tasks should not emit visible text");
  assert.deepEqual(calls.commits, [], "aborted tasks should not commit sources");
  assert.deepEqual(calls.final, [], "aborted tasks should not enter final-answer repair");
}

async function main() {
  try {
    const loopModule = await loadBundledModule("src/agent/web-search/research-loop.ts");
    await assertDirectAnswer(loopModule);
    await assertSecondResearchThenAnswer(loopModule);
    await assertMalformedRepair(loopModule);
    await assertRepairEmptyForcesFinalAnswer(loopModule);
    await assertRoundBudgetExhausted(loopModule);
    await assertAbort(loopModule);
    console.log("web research loop logic test passed");
  } finally {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

await main();
