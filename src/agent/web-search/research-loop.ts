import type { WebSearchResult } from "../../context/web-search-service";
import type { MessageRecord } from "../../types";
import {
  createResearchBudget,
  type ResearchBudget,
  type ResearchBudgetOptions,
  type ResearchPage,
  type ResearchRoundResult
} from "./research-agent";
import {
  parseSidetResearchBlock,
  stripSidetProtocolBlocks
} from "./sidet-protocol";
import type { ResearchAttemptSummary } from "./web-search-runtime-policy";

export interface ResearchLoopState {
  pages: ResearchPage[];
  lastSearchResults: WebSearchResult[];
  lastProviderLabel: string;
  lastQuestion: string;
  queries: string[];
  /** 每轮试过的查询与命中站点；供下一轮检索前理解换角度。 */
  attempts: ResearchAttemptSummary[];
}

export interface WebResearchLoopOptions {
  initialQuestion: string;
  baseMessages: MessageRecord[];
  decisionContext: string;
  createMessage: (role: MessageRecord["role"], text: string) => MessageRecord;
  callDecisionModel: (messages: MessageRecord[]) => Promise<{
    contentText: string;
    reasoningText: string;
    /** 调用方是否已经把可见正文边生成边写给用户；为 true 时循环不再整段补写。 */
    visibleContentStreamed?: boolean;
  }>;
  callRepairModel: (messages: MessageRecord[]) => Promise<{
    contentText: string;
    reasoningText: string;
    visibleContentStreamed?: boolean;
  }>;
  runResearchRound: (
    round: number,
    question: string,
    budget: ResearchBudget,
    state: ResearchLoopState,
    reason?: string | null
  ) => Promise<ResearchRoundResult>;
  streamFinalAnswer: (
    messages: MessageRecord[],
    state: ResearchLoopState & { exhausted: boolean }
  ) => Promise<string>;
  onVisibleContent: (text: string) => void;
  commitSources: (state: ResearchLoopState) => void;
  /**
   * 决策阶段由调用方边生成边显示正文。开启后来源在每次决策前提交，
   * 最终文本不再由循环整段 append，避免同一段答案出现两次。
   */
  streamDecisionContent?: boolean;
  signal: AbortSignal;
  budgets?: ResearchBudgetOptions;
  now?: () => number;
}

export interface WebResearchLoopResult {
  finalText: string;
  aborted: boolean;
  exhausted: boolean;
  rounds: number;
  state: ResearchLoopState;
}

/**
 * 一轮检索会话的初始状态。显式联网模式与自动联网工具共用同一形态，
 * 保证来源编号、已读 URL 去重和查询累积走同一份状态模型。
 */
export function createResearchLoopState(initialQuestion: string): ResearchLoopState {
  return {
    pages: [],
    lastSearchResults: [],
    lastProviderLabel: "Sidet",
    lastQuestion: initialQuestion,
    queries: [],
    attempts: []
  };
}

const MALFORMED_RESEARCH_ATTEMPT_PATTERN = /(?:^|\n)\s*(?:```)?sidet-(?:search|fetch|research)\b/i;

function isMalformedResearchAttempt(text: string): boolean {
  return MALFORMED_RESEARCH_ATTEMPT_PATTERN.test(text) && parseSidetResearchBlock(text) === null;
}

function appendRoundResult(
  transcript: MessageRecord[],
  state: ResearchLoopState,
  result: ResearchRoundResult,
  createMessage: (role: MessageRecord["role"], text: string) => MessageRecord
): void {
  state.pages.push(...result.pages);
  if (result.results.length > 0) {
    state.lastSearchResults = result.results;
    state.lastProviderLabel = result.providerLabel;
  }
  state.lastQuestion = result.question;
  state.queries = result.queries;
  transcript.push(createMessage("user", result.resultBlock));
}

/**
 * 有界检索循环：运行时先跑一轮研究，之后主模型只决定“继续研究”还是“直接回答”。
 * 与旧 5 步协议循环不同，这里按查询数 / 页数 / 时长 / 模型调用计预算；预算耗尽
 * 时强制基于已有证据给阶段性答案，不再输出失败卡。
 */
export async function runWebResearchLoop(
  options: WebResearchLoopOptions
): Promise<WebResearchLoopResult> {
  const budget = createResearchBudget(options.budgets, options.now);
  const state = createResearchLoopState(options.initialQuestion);
  const transcript: MessageRecord[] = [
    options.createMessage("system", options.decisionContext),
    ...options.baseMessages
  ];

  const finishWithVisibleText = (
    text: string,
    streamed: boolean
  ): WebResearchLoopResult => {
    if (!options.streamDecisionContent) {
      options.commitSources(state);
    }
    if (!streamed) {
      options.onVisibleContent(text);
    }
    return {
      finalText: text,
      aborted: false,
      exhausted: false,
      rounds: budget.rounds,
      state
    };
  };

  const finishExhausted = async (): Promise<WebResearchLoopResult> => {
    options.commitSources(state);
    const finalText = await options.streamFinalAnswer(transcript, {
      ...state,
      exhausted: true
    });
    return {
      finalText,
      aborted: false,
      exhausted: true,
      rounds: budget.rounds,
      state
    };
  };

  if (!budget.chargeRound()) {
    return finishExhausted();
  }

  let roundResult = await options.runResearchRound(1, options.initialQuestion, budget, state);
  if (options.signal.aborted) {
    return {
      finalText: "",
      aborted: true,
      exhausted: false,
      rounds: budget.rounds,
      state
    };
  }
  appendRoundResult(transcript, state, roundResult, options.createMessage);
  if (options.streamDecisionContent) {
    options.commitSources(state);
  }

  let repairUsed = false;
  let pendingReply: {
    contentText: string;
    reasoningText: string;
    visibleContentStreamed?: boolean;
  } | null = null;
  let decisionSteps = 0;
  const maxDecisionSteps = budget.options.maxRounds + 2;

  while (decisionSteps < maxDecisionSteps) {
    decisionSteps += 1;

    if (options.signal.aborted) {
      return {
        finalText: "",
        aborted: true,
        exhausted: false,
        rounds: budget.rounds,
        state
      };
    }

    if (budget.isExpired()) {
      return finishExhausted();
    }

    let reply = pendingReply;
    if (!reply) {
      if (budget.remainingModelCalls() <= 0) {
        return finishExhausted();
      }
      budget.chargeModelCall();
      reply = await options.callDecisionModel(transcript);
    }
    pendingReply = null;

    if (options.signal.aborted) {
      return {
        finalText: "",
        aborted: true,
        exhausted: false,
        rounds: budget.rounds,
        state
      };
    }

    const researchInstruction = parseSidetResearchBlock(reply.contentText);
    const visibleText = isMalformedResearchAttempt(reply.contentText)
      ? ""
      : stripSidetProtocolBlocks(reply.contentText).trim();

    if (researchInstruction) {
      if (!budget.canStartRound()) {
        return finishExhausted();
      }

      transcript.push(options.createMessage("assistant", reply.contentText));
      if (!budget.chargeRound()) {
        return finishExhausted();
      }

      roundResult = await options.runResearchRound(
        budget.rounds,
        researchInstruction.question,
        budget,
        state,
        researchInstruction.reason
      );
      if (options.signal.aborted) {
        return {
          finalText: "",
          aborted: true,
          exhausted: false,
          rounds: budget.rounds,
          state
        };
      }
      appendRoundResult(transcript, state, roundResult, options.createMessage);
      if (options.streamDecisionContent) {
        options.commitSources(state);
      }
      continue;
    }

    if (visibleText) {
      return finishWithVisibleText(visibleText, Boolean(reply.visibleContentStreamed));
    }

    if (repairUsed) {
      return finishExhausted();
    }
    repairUsed = true;

    transcript.push(options.createMessage("assistant", reply.contentText || "（上一条没有给出可执行下一步）"));
    if (budget.remainingModelCalls() <= 0) {
      return finishExhausted();
    }
    budget.chargeModelCall();
    pendingReply = await options.callRepairModel(transcript);
  }

  return finishExhausted();
}
