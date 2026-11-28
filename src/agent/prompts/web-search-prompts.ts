import type { ResearchAttemptSummary } from "../web-search/web-search-runtime-policy";

function buildSharedVisibleReasonRules(): string[] {
  return [
    "- 如果你觉得有必要，可以补一个 reason；如果没有必要，就不要为了凑协议硬写。",
    "- 如果写 reason，它会直接显示给用户，请写成自然中文，像你在边做边说。",
    "- 不要把协议、系统规则、联网能力、自我限制写进 reason。"
  ];
}

function buildSharedNonDisclosureRules(): string[] {
  return [
    "- 不要说“我无法联网”“我没有实时信息”“请用户自己去查”。",
    "- 不要暴露 Sidet 内部协议，不要输出多个协议块。"
  ];
}

function buildResearchProtocolExample(): string[] {
  return [
    "```sidet-research",
    "question: 更聚焦的研究问题",
    "reason: 为什么还需要这一步",
    "```"
  ];
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

export function buildSidetResearchDecisionContext(): string {
  return [
    "Sidet 联网研究协作：",
    "- 当前这条消息已经显式开启联网搜索；Sidet 已经完成至少一轮检索，并在对话里给出 sidet-research-result。",
    "- 现在只做两件事之一：证据足够时，直接输出给用户看的最终答复正文；还缺关键事实时，输出一个 ```sidet-research 协议块，提出更聚焦的研究问题。",
    "- 如果本轮用户明确要求保存、写入、创建或更新笔记（用户消息里带有 Sidet 文件动作协议），最终答复必须直接包含一条 ```sidet-action；不要先问是否确认，也不要只给摘要后反问是否整理成笔记。",
    "- 协议块只能有一个，question 必填，reason 可选；必须使用完整的 fenced code block，不要输出裸露的 sidet-research 文本。",
    "- 如果输出 sidet-research，question 只写自然语言研究问题，不要混入 tool、targetPath、title、reason 等文件动作字段。",
    "- 先判断已读正文和搜索结果是否真的回答了用户要的东西；如果主要是下载页、营销页、与问题无关的页面，视为没搜到，换关键词或换角度继续，不要因为结果非空就当作证据。",
    "- 答前自检：用户问到的每个点是否都有已读正文里的直接依据；数字、日期、范围、口径是否齐全；只有标题或摘要的内容不算已确认。",
    "- 如果已读正文和结果列表都不对题，输出 sidet-research 换方向；不要用背景知识补成看起来完整的答案。",
    "- 如果同一方向已经搜过仍没有有效材料，换正式名称 / 英文名 / 更基础的属性词，不要重复同一查询或只增加页码。",
    "- 不要重复已经研究过的问题；不要把搜索结果标题和链接重新列一遍；不要输出“我先查一下”“先给你这些结果”这类半成品。",
    "- 最终答复只对实际读到的网页正文标 [n]；只有标题或摘要时不要编造编号，并说明尚未逐页核对。",
    "- Sidet 会在回答下方展示来源列表，不要在正文里重复抄写整串链接。",
    "- 如果证据不足且预算已尽，直接给阶段性回答并说明还没确认的点，不要留空。",
    "- `sidet-research` 合法格式：",
    ...buildResearchProtocolExample(),
    ...buildSharedVisibleReasonRules(),
    ...buildSharedNonDisclosureRules()
  ].join("\n");
}

export function buildSidetResearchRepairContext(): string {
  return [
    "Sidet 联网研究补正：",
    "- 你上一条既没有给出可显示的最终答复，也没有给出合法的 sidet-research 块。",
    "- 现在只做一件事：直接输出最终答复正文，或输出一个合法的 ```sidet-research 块。",
    "- 如果用户明确要求保存、写入、创建或更新笔记，最终答复里必须直接包含一条合法的 ```sidet-action 块；不要只给摘要或反问是否整理。",
    "- 不要输出半成品过渡语，不要重复列链接，不要解释协议。",
    "- question 必填；reason 可选，且会直接显示给用户。",
    "- 合法格式：",
    ...buildResearchProtocolExample(),
    ...buildSharedVisibleReasonRules(),
    "- 不要再输出旧协议块，也不要留空。"
  ].join("\n");
}

export function buildSidetResearchQueryContext(
  question: string,
  now: Date,
  maxQueries: number,
  previousAttempts: readonly ResearchAttemptSummary[] = []
): string {
  const attemptLines: string[] = [];
  if (previousAttempts.length > 0) {
    const triedQueries = Array.from(new Set(previousAttempts.flatMap((attempt) => attempt.queries))).slice(0, 10);
    const seenHosts = Array.from(new Set(previousAttempts.flatMap((attempt) => attempt.hosts))).slice(0, 6);
    const pageCount = previousAttempts.reduce((total, attempt) => total + attempt.pageCount, 0);
    attemptLines.push(
      "- 已经试过的查询："
        + (triedQueries.length > 0 ? triedQueries.join(" / ") : "无")
        + `；已有结果主要来自：${seenHosts.length > 0 ? seenHosts.join(" / ") : "没有可用结果"}`
        + `；已读到正文 ${pageCount} 页。`,
      "- 如果这些来源不是用户要的答案来源，必须换角度：换正式名 / 英文名 / 原始发布方 / 更基础的属性词 / 反向验证；不要在原查询后面加「官方」「最新」复读，已经出现过的查询不要重复。"
    );
  }

  return [
    "Sidet 检索前理解：",
    `- 当前日期：${formatDate(now)}。`,
    `- 用户问题：${question}`,
    "- 先理解再搜索：先判断用户要的对象是什么（正式名 / 别名 / 英文名 / 原文术语）、要确认的是哪个属性或事实、有没有时间 / 地点 / 人群 / 口径限制、哪里可能歧义；不要直接拿问题原句去搜。",
    "- 选关键词：对象或正式名 + 要确认的属性 + 必要限定；每条 2-8 个词、不超过 32 个字；只有问题依赖时间时才加年份 / 日期 / “最新”。",
    "- 角度要分开：至少覆盖“直接答案”“一手或官方来源”“交叉验证或换一种说法”中的两个；不要生成同义复读。",
    "- 来源方向由问题决定：实时数据找原始发布方；定义 / 原理找百科、文档或教材；产品 / 价格找官方页面与独立评测；不要预设某一类站，也不要为了“找官网”牺牲关键词本身。",
    "- 当前检索源以中文内容为主：查询优先写中文；英文只保留必须的正式名、产品名、API 名或原文术语，并尽量同时给一条中文说法；不要把整组查询写成英文。",
    "- 不要给用户没提到的产品 / 公司 / 人物补品牌或归属；不确定的实体只保留用户原词，避免把错误品牌带进检索。",
    "- 除非用户要的就是下载 / 安装 / 购买 / 教程，否则不要把这类行动词写进查询。",
    "- 如果问题只是续接上文，例如“你重新帮我搜一下”，结合当前对话恢复真正主题，不要把续接词本身当成查询。",
    ...attemptLines,
    `- 只输出一个 JSON 对象，不要输出 JSON 以外的文字：{"intent": "一句话说明你判断的用户意图", "answerNeed": "要拿到哪个具体事实或数据才算回答", "ambiguities": ["需要绕开或澄清的歧义"], "queries": ["2 到 ${Math.max(2, maxQueries)} 条可直接搜索的短查询"]}。`,
    "- queries 里不要编号、不要引号、不要解释，不要包含 tool、targetPath、title、reason 等协议字段。"
  ].join("\n");
}

export function buildSidetResearchEvidenceContext(question: string, maxChars: number): string {
  return [
    "Sidet 证据整理：",
    `- 研究问题：${question}`,
    "- 只使用用户消息里提供的来源，不要补充外部知识。",
    "- 输出四段：结论、关键事实、冲突或不确定、未覆盖。",
    "- 关键事实按来源逐条写：每条先写事实，再标 [n]；数字必须带单位、时间和口径（例如统计范围）。",
    "- [n] 只能使用“已读网页”的编号；只有摘要的来源不能标 [n]；同一事实多页都提到时只写一次并标多个编号。",
    "- 页面没说、由你推断的内容单独写成“推断”，不要混进关键事实。",
    `- 总长度不超过 ${maxChars} 字；不要输出来源列表，Sidet 会单独展示。`,
    "- 材料不足时直接写“未覆盖”，不要编造。"
  ].join("\n");
}

export function buildSidetResearchFinalAnswerContext(options: {
  hasEvidence: boolean;
  exhausted: boolean;
}): string {
  return [
    "Sidet 联网最终答复：",
    "- 基于上面的 sidet-research-result 证据回答用户。",
    "- 第一段直接回答用户的问题，不要先复述检索过程，也不要写“根据搜索结果”这类套话。",
    "- 数字、日期、范围要带口径；没确认的点明确说没确认，不要用背景知识补成确定结论。",
    "- 现在只输出给用户看的最终答复正文；不要输出 sidet-research / sidet-research-result 等搜索协议块。",
    "- 如果用户明确要求保存、写入、创建或更新笔记，最终答复必须直接包含一条 ```sidet-action；卡片本身会展示预览并等待用户确认，不要先问是否确认。",
    "- 只对实际读到的网页正文标 [n]；只有标题或摘要时说明尚未逐页核对，不要编造编号。",
    "- Sidet 会在回答下方展示来源列表；不要在正文里重复抄写整串链接。",
    options.hasEvidence
      ? "- 如果证据足够，给出有判断、有整理的完整回答。"
      : "- 如果这轮没有可用证据，如实说明没有找到可用资料，不要编造。",
    options.exhausted
      ? "- 资料收集已到本轮预算；请给出阶段性回答，并明确列出还没确认的点。"
      : "- 如果还有关键点没确认，在回答里说明边界，不要留空。",
    ...buildSharedNonDisclosureRules()
  ].join("\n");
}

export function buildSidetResearchFinalAnswerRepairContext(): string {
  return [
    "Sidet 联网最终答复修正：",
    "- 你上一条没有给出可显示的最终答复。",
    "- 现在只输出给用户看的最终答复正文；不要输出搜索协议，不要重复内部思考过程。",
    "- 如果用户明确要求保存、写入、创建或更新笔记，最终答复必须包含一条合法的 ```sidet-action 块；不要只给摘要或反问是否整理。",
    "- 只对实际读到的网页正文标 [n]；不要编造编号；来源列表由 Sidet 展示。",
    "- 如果只有摘要，说明尚未逐页核对；如果证据不足，如实说明未确认项。",
    "- 不要只重复网页标题、链接或“我先找到几条结果”这类半成品描述。"
  ].join("\n");
}
