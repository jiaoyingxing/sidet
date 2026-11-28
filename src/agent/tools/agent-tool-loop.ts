import { MAX_AGENT_TOOL_ROUNDS } from "../../constants";
import type { MessageRecord } from "../../types";
import {
  buildAgentToolFinalAnswerContext,
  buildAgentToolFinalAnswerRepairContext,
  buildAgentToolRepairContext,
  buildAgentToolSystemContext
} from "../prompts/tool-loop-prompts";
import { createDisplayableAnswerStreamer } from "../web-search/displayable-answer-stream";
import {
  buildAgentToolResultBlock,
  isAgentToolInvocationBlockComplete,
  isAgentToolInvocationMalformed,
  parseAgentToolInvocation
} from "./tool-protocol";
import { AGENT_TOOL_DEFINITIONS } from "./tool-registry";
import type { AgentToolDefinition } from "./tool-registry";
import type {
  AgentToolExecutionResult,
  AgentToolInvocation,
  AgentToolName
} from "./tool-types";

export const AGENT_TOOL_LOOP_FALLBACK_TEXT = "当前没有得到可显示的回复。";

const REPAIR_EMPTY_ASSISTANT_TEXT = "（上一条没有按工具协议返回）";
const DUPLICATE_TOOL_RESULT_TEXT = "本次工具调用与之前的调用重复，已跳过。请基于已有结果直接回答，不要再调用工具。";
const MAX_TOOL_STEP_DETAIL_CHARS = 4000;

export interface AgentToolStep {
  tool: AgentToolName;
  status: "running" | "ok" | "error";
  summary: string;
  detail?: string;
}

export interface AgentToolModelCallState {
  contentText: string;
  reasoningText: string;
}

export interface AgentToolModelCallOptions {
  onReasoningChunk?: (chunk: string, state: AgentToolModelCallState) => void;
  onContentChunk?: (chunk: string, state: AgentToolModelCallState) => void;
  shouldStop?: (state: AgentToolModelCallState) => boolean;
}

export interface AgentToolModelReply {
  contentText: string;
  reasoningText: string;
  stoppedEarly?: boolean;
}

export interface AgentToolLoopOptions {
  baseMessages: MessageRecord[];
  createMessage: (role: MessageRecord["role"], text: string) => MessageRecord;
  callModel: (messages: MessageRecord[], options: AgentToolModelCallOptions) => Promise<AgentToolModelReply>;
  executeTool: (invocation: AgentToolInvocation) => Promise<AgentToolExecutionResult>;
  onVisibleContent: (chunk: string) => void;
  onReasoning: (chunk: string) => void;
  onToolStep: (step: AgentToolStep) => void;
  maxRounds?: number;
  /** 本轮工具结果总字符预算；省略时不限制（测试 / 特殊调用）。 */
  maxToolResultChars?: number;
  /**
   * 测试 / 特殊调用可替换本轮工具注册表；提供后作为完整表，未列出的工具按未注册处理。
   * 省略时使用 `AGENT_TOOL_DEFINITIONS`。
   */
  toolDefinitions?: Partial<Record<AgentToolName, AgentToolDefinition>>;
  signal?: AbortSignal;
}

export interface AgentToolLoopResult {
  finalText: string;
  toolCalls: number;
  aborted: boolean;
  exhausted: boolean;
}

interface ModelInvocationSuccess {
  aborted: false;
  reply: AgentToolModelReply;
  callVisibleText: string;
}

interface ModelInvocationAborted {
  aborted: true;
}

type ModelInvocation = ModelInvocationSuccess | ModelInvocationAborted;

type ToolRoundOutcome = "executed" | "duplicate" | "budget" | "aborted";

/**
 * 通用有界工具循环：只负责控制流、协议解析、转录拼装与失败语义。
 *
 * 不依赖 Obsidian / ChatView / WorkspaceController / ConversationSession；
 * 模型调用、工具执行与可见输出全部由调用方注入。
 */
export async function runAgentToolLoop(options: AgentToolLoopOptions): Promise<AgentToolLoopResult> {
  const maxRounds = resolveMaxRounds(options.maxRounds);
  const toolDefinitions = options.toolDefinitions ?? AGENT_TOOL_DEFINITIONS;
  const webResearchEnabled = toolDefinitions.web_research !== undefined;
  const transcript: MessageRecord[] = [
    options.createMessage("system", buildAgentToolSystemContext({ webResearch: webResearchEnabled })),
    ...options.baseMessages
  ];
  const executedInvocations = new Set<string>();

  let toolCalls = 0;
  let completedRounds = 0;
  let toolResultChars = 0;
  let repairUsed = false;
  let visibleText = "";

  const emitVisible = (chunk: string): void => {
    if (!chunk) {
      return;
    }
    visibleText += chunk;
    options.onVisibleContent(chunk);
  };

  const buildLoopResult = (aborted: boolean, exhausted: boolean): AgentToolLoopResult => ({
    finalText: visibleText.trim(),
    toolCalls,
    aborted,
    exhausted
  });

  const invokeModel = async (messages: MessageRecord[]): Promise<ModelInvocation> => {
    const streamer = createDisplayableAnswerStreamer(emitVisible);
    try {
      const reply = await options.callModel(messages, {
        onReasoningChunk: (chunk) => {
          options.onReasoning(chunk);
        },
        onContentChunk: (_chunk, state) => {
          streamer.sync(state.contentText);
        },
        shouldStop: (state) => shouldStopOnToolBlock(state.contentText)
      });
      return {
        aborted: false,
        reply,
        callVisibleText: streamer.finish(reply.contentText)
      };
    } catch (error) {
      if (isAbortError(error)) {
        return { aborted: true };
      }
      throw error;
    }
  };

  const runForcedFinalAnswer = async (exhausted: boolean): Promise<AgentToolLoopResult> => {
    if (options.signal?.aborted) {
      return buildLoopResult(true, false);
    }

    const invocation = await invokeModel([
      options.createMessage("system", buildAgentToolFinalAnswerContext()),
      ...transcript
    ]);
    if (invocation.aborted) {
      return buildLoopResult(true, false);
    }

    // 真实模型会在“不能再调工具”的这一轮继续输出工具块；工具块被隐藏后
    // 用户只剩一句“下面是我整理的内容”加半截围栏。补一次只输出正文的调用，
    // 让用户拿到真正的最终回答。
    const triedToolAgain = parseAgentToolInvocation(invocation.reply.contentText) !== null
      || isAgentToolInvocationMalformed(invocation.reply.contentText);
    let visibleText = invocation.callVisibleText;
    if ((triedToolAgain || !visibleText.trim()) && !options.signal?.aborted) {
      // 前一次已经流出说明句时先断开段落，避免修复正文接在句号后面。
      if (visibleText.trim()) {
        emitVisible("\n\n");
      }
      const repaired = await invokeModel([
        options.createMessage(
          "system",
          buildAgentToolFinalAnswerRepairContext({ webResearch: webResearchEnabled })
        ),
        ...transcript,
        options.createMessage(
          "assistant",
          invocation.reply.contentText.trim() || REPAIR_EMPTY_ASSISTANT_TEXT
        ),
        options.createMessage("user", "请直接给出给用户看的最终回答，不要再调用工具。")
      ]);
      if (repaired.aborted) {
        return buildLoopResult(true, false);
      }
      visibleText = repaired.callVisibleText;
      // 补正仍然只给工具块 / 空正文时明确告诉用户，而不是留下半句承诺。
      const stillNoAnswer = parseAgentToolInvocation(repaired.reply.contentText) !== null
        || isAgentToolInvocationMalformed(repaired.reply.contentText);
      if (!visibleText.trim() || stillNoAnswer) {
        emitVisible(`${visibleText.trim() ? "\n\n" : ""}${AGENT_TOOL_LOOP_FALLBACK_TEXT}`);
      }
      return buildLoopResult(false, exhausted);
    }

    if (!visibleText.trim()) {
      emitVisible(AGENT_TOOL_LOOP_FALLBACK_TEXT);
    }
    return buildLoopResult(false, exhausted);
  };

  const executeInvocation = async (
    invocation: AgentToolInvocation,
    assistantRawText: string,
    countsAgainstRounds: boolean
  ): Promise<ToolRoundOutcome> => {
    transcript.push(options.createMessage("assistant", assistantRawText));

    if (options.signal?.aborted) {
      return "aborted";
    }

    const key = buildInvocationKey(invocation);
    const summary = buildToolStepSummary(invocation);
    if (executedInvocations.has(key)) {
      options.onToolStep({
        tool: invocation.tool,
        status: "error",
        summary,
        detail: "重复调用已跳过"
      });
      transcript.push(options.createMessage("user", buildAgentToolResultBlock({
        tool: invocation.tool,
        status: "error",
        content: DUPLICATE_TOOL_RESULT_TEXT
      })));
      return "duplicate";
    }

    executedInvocations.add(key);
    const resultBudget = resolveToolResultBudget(options.maxToolResultChars);
    if (toolResultChars >= resultBudget) {
      options.onToolStep({
        tool: invocation.tool,
        status: "error",
        summary,
        detail: "工具结果预算已用尽"
      });
      transcript.push(options.createMessage("user", buildAgentToolResultBlock({
        tool: invocation.tool,
        status: "error",
        content: "本轮工具结果预算已用尽，请基于已有结果直接回答。"
      })));
      return "budget";
    }

    options.onToolStep({ tool: invocation.tool, status: "running", summary });

    const definition = resolveToolDefinition(toolDefinitions, invocation.tool);
    let result: AgentToolExecutionResult;
    if (definition) {
      result = await executeToolWithTimeout(invocation, definition, options.executeTool);
    } else {
      result = {
        tool: invocation.tool,
        status: "error",
        content: `工具「${invocation.tool}」未注册或当前不可执行，已跳过本次调用。`
      };
    }

    let finalResult = result;
    const remainingChars = resultBudget - toolResultChars;
    if (Number.isFinite(remainingChars) && result.content.length > remainingChars) {
      const note = "\n…（工具结果已按上下文预算截断）";
      const allowedChars = Math.max(0, remainingChars - note.length);
      finalResult = {
        ...result,
        content: `${result.content.slice(0, allowedChars).trimEnd()}${note}`
      };
    }

    const detail = extractToolStepDetail(finalResult.content);
    options.onToolStep({
      tool: invocation.tool,
      status: finalResult.status === "ok" ? "ok" : "error",
      summary,
      ...(detail === null ? {} : { detail })
    });
    transcript.push(options.createMessage("user", buildAgentToolResultBlock(finalResult)));
    toolResultChars += finalResult.content.length;
    toolCalls += 1;
    if (countsAgainstRounds) {
      completedRounds += 1;
    }
    return "executed";
  };

  while (true) {
    if (options.signal?.aborted) {
      return buildLoopResult(true, false);
    }
    if (completedRounds >= maxRounds) {
      return runForcedFinalAnswer(true);
    }

    const invocation = await invokeModel(transcript);
    if (invocation.aborted) {
      return buildLoopResult(true, false);
    }

    const toolInvocation = parseAgentToolInvocation(invocation.reply.contentText);
    if (toolInvocation) {
      const outcome = await executeInvocation(toolInvocation, invocation.reply.contentText, true);
      if (outcome === "aborted") {
        return buildLoopResult(true, false);
      }
      if (outcome === "budget") {
        return runForcedFinalAnswer(true);
      }
      if (outcome === "duplicate") {
        return runForcedFinalAnswer(false);
      }
      continue;
    }

    if (!isAgentToolInvocationMalformed(invocation.reply.contentText)) {
      if (!invocation.callVisibleText.trim()) {
        emitVisible(AGENT_TOOL_LOOP_FALLBACK_TEXT);
      }
      return buildLoopResult(false, false);
    }

    transcript.push(options.createMessage(
      "assistant",
      invocation.reply.contentText.trim() ? invocation.reply.contentText : REPAIR_EMPTY_ASSISTANT_TEXT
    ));

    if (repairUsed) {
      if (!invocation.callVisibleText.trim()) {
        emitVisible(AGENT_TOOL_LOOP_FALLBACK_TEXT);
      }
      return buildLoopResult(false, false);
    }
    repairUsed = true;

    if (options.signal?.aborted) {
      return buildLoopResult(true, false);
    }

    const repairedInvocation = await invokeModel([
      options.createMessage("system", buildAgentToolRepairContext({ webResearch: webResearchEnabled })),
      ...transcript
    ]);
    if (repairedInvocation.aborted) {
      return buildLoopResult(true, false);
    }

    const repairedToolInvocation = parseAgentToolInvocation(repairedInvocation.reply.contentText);
    if (repairedToolInvocation) {
      const outcome = await executeInvocation(
        repairedToolInvocation,
        repairedInvocation.reply.contentText,
        false
      );
      if (outcome === "aborted") {
        return buildLoopResult(true, false);
      }
      if (outcome === "budget") {
        return runForcedFinalAnswer(true);
      }
      if (outcome === "duplicate") {
        return runForcedFinalAnswer(false);
      }
      continue;
    }

    if (!repairedInvocation.callVisibleText.trim()) {
      emitVisible(AGENT_TOOL_LOOP_FALLBACK_TEXT);
    }
    return buildLoopResult(false, false);
  }
}

function resolveMaxRounds(rawMaxRounds: number | undefined): number {
  if (rawMaxRounds === undefined || !Number.isFinite(rawMaxRounds)) {
    return MAX_AGENT_TOOL_ROUNDS;
  }
  return Math.max(0, Math.floor(rawMaxRounds));
}

function resolveToolResultBudget(rawBudget: number | undefined): number {
  if (rawBudget === undefined || !Number.isFinite(rawBudget)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.floor(rawBudget));
}

function resolveToolDefinition(
  definitions: Partial<Record<AgentToolName, AgentToolDefinition>>,
  name: AgentToolName
): AgentToolDefinition | null {
  return definitions[name] ?? null;
}

class AgentToolTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`工具执行超时：${timeoutMs} 毫秒`);
    this.name = "AgentToolTimeoutError";
  }
}

async function executeToolWithTimeout(
  invocation: AgentToolInvocation,
  definition: AgentToolDefinition,
  executeTool: (invocation: AgentToolInvocation) => Promise<AgentToolExecutionResult>
): Promise<AgentToolExecutionResult> {
  let timer: number | undefined;
  try {
    const execution = executeTool(invocation);
    // 超时后原 promise 仍可能迟到 reject；这里立即挂上处理器，避免 unhandled rejection。
    void execution.catch(() => undefined);

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = window.setTimeout(() => {
        reject(new AgentToolTimeoutError(definition.timeoutMs));
      }, definition.timeoutMs);
    });

    return await Promise.race([execution, timeout]);
  } catch (error) {
    if (error instanceof AgentToolTimeoutError) {
      return {
        tool: invocation.tool,
        status: "error",
        content: `工具「${invocation.tool}」执行超时（${definition.timeoutMs} 毫秒），已跳过本次结果。`
      };
    }
    return {
      tool: invocation.tool,
      status: "error",
      content: `工具执行失败：${describeError(error)}`
    };
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

function shouldStopOnToolBlock(contentText: string): boolean {
  // 只有完整块才提前停止；出现 opener 就停会把未写完的工具块截断，
  // 反而让完整块永远解析不到。
  return parseAgentToolInvocation(contentText) !== null
    || (isAgentToolInvocationBlockComplete(contentText)
      && isAgentToolInvocationMalformed(contentText));
}

function buildInvocationKey(invocation: AgentToolInvocation): string {
  return JSON.stringify([
    invocation.tool,
    normalizeKeyPart(invocation.query),
    normalizeKeyPart(invocation.path)?.replace(/\\/g, "/") ?? null,
    normalizeKeyPart(invocation.heading),
    invocation.limit
  ]);
}

function normalizeKeyPart(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function buildToolStepSummary(invocation: AgentToolInvocation): string {
  const usesQuery = invocation.tool === "search_notes"
    || invocation.tool === "web_research";
  const target = (usesQuery ? invocation.query : invocation.path)?.trim() ?? "";
  switch (invocation.tool) {
    case "search_notes":
      return `检索笔记：${target}`;
    case "read_note":
      return `读取笔记：${target}`;
    case "note_links":
      return `查询双链：${target}`;
    case "web_research":
      return `联网搜索：${target}`;
  }
}

function extractToolStepDetail(content: string): string | null {
  // 面板里要能回看工具结果，不再只留第一行；单次结果本身已有 4k 预算。
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= MAX_TOOL_STEP_DETAIL_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_TOOL_STEP_DETAIL_CHARS - 3).trimEnd()}...`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}
