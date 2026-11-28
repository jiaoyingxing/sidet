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
  maxQueries: number
): string {
  return [
    "Sidet 检索规划：",
    `- 当前日期：${formatDate(now)}。`,
    `- 研究问题：${question}`,
    `- 把研究问题拆成 2 到 ${Math.max(2, maxQueries)} 组可直接搜索的查询；每行一组，不要编号、不要解释、不要引号。`,
    "- 覆盖不同角度：直接关键词、正式名称或英文名、时间词（最新或具体年份）、站点线索（官网、GitHub、文档）。",
    "- 如果问题在问最新动态、近期变化或某个时间点之后的事，把当前年份或具体日期写进查询，不要只写“最新”。",
    "- 如果问题只是续接上文，例如“你重新帮我搜一下”，结合当前对话恢复真正主题，不要把续接词本身当成查询。",
    "- 查询行只写自然语言关键词；不要包含 tool、targetPath、title、reason 等协议字段，也不要输出 Markdown。",
    "- 只输出查询行，不要输出任何其它文字。"
  ].join("\n");
}

export function buildSidetResearchEvidenceContext(question: string, maxChars: number): string {
  return [
    "Sidet 证据整理：",
    `- 研究问题：${question}`,
    "- 只使用用户消息里提供的来源，不要补充外部知识。",
    "- 输出四段：结论、关键事实、冲突或不确定、未覆盖。",
    "- 关键事实后用 [n] 标注来源；[n] 只能使用“已读网页”的编号；只有摘要的来源不能标 [n]。",
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
