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

function buildSearchProtocolExample(): string[] {
  return [
    "```sidet-search",
    "intent: web_search",
    "round: 1",
    "query1: GitHub Trending 最新",
    "query2: GitHub 热门项目 最新",
    "reason: 我先用更直接的关键词找最近的热门项目。",
    "```"
  ];
}

function buildFetchProtocolExample(): string[] {
  return [
    "```sidet-fetch",
    "round: 2",
    "pick1: 1",
    "pick2: 3",
    "reason: 第 1 条和第 3 条更贴近当前问题，我先抓这两条正文确认细节。",
    "```"
  ];
}

export function buildSidetWebSearchRoutingContext(): string {
  return [
    "Sidet 联网协作：",
    "- 当前这条消息已经显式开启联网搜索。",
    "- 这一轮只输出一个 ```sidet-search``` 代码块；Sidet 会替你执行搜索。",
    "- 必须使用完整的 fenced code block，不要输出裸露的 sidet-search 文本。",
    "- 不要直接输出给用户看的正文答案。",
    "- 把用户当前这句自然语言转换成可直接搜索的文本，再写进 query1 到 query3。",
    "- 保留真正有用的主题词、时间词、站点词；去掉寒暄、问句外壳和动作词。",
    "- 如果这句话只是续接上文，例如“你重新帮我搜一下”，要结合当前对话恢复真正主题，不要把续接词本身当成搜索词。",
    "- 下面是合法格式示范：",
    ...buildSearchProtocolExample(),
    ...buildSharedVisibleReasonRules(),
    ...buildSharedNonDisclosureRules()
  ].join("\n");
}

export function buildSidetWebSearchRoutingRepairContext(): string {
  return [
    "Sidet 联网协作补正：",
    "- 你上一条没有按内部协议返回搜索词。",
    "- 现在只补一个 ```sidet-search``` 协议块。",
    "- 必须使用完整的 fenced code block，不要输出裸露的 sidet-search 文本。",
    "- 把当前自然语言转换成可直接搜索的文本，再写进 query1 到 query3。",
    "- 如果这句话只是续接上文，要结合当前对话恢复真正主题，不要把续接词本身当成搜索词。",
    "- 合法格式示范：",
    ...buildSearchProtocolExample(),
    ...buildSharedVisibleReasonRules(),
    "- 不要再输出正文答案。"
  ].join("\n");
}

export function buildSidetWebSearchInstructionContext(): string {
  return [
    "Sidet 联网协作：",
    "- 这条消息已经进入联网过程；你负责决定继续搜索、抓取网页，还是直接回答。",
    "- Sidet 会替你执行搜索和网页抓取；你只需要输出正确的内部协议块，或直接给出最终答复。",
    "- 在搜索过程轮次里，不要输出“我先找到几条网页”“先给你这些链接”“我先查到这些结果”这类半成品正文。",
    "- 如果材料还不够，就继续输出协议块；只有准备好一版面向用户的答复时，才输出正常正文。",
    "- 如果要继续搜索，只输出一个 ```sidet-search```；字段用 intent、round、query1 到 query3，reason 按需补。",
    "- `sidet-search` 必须使用完整的 fenced code block，不要输出裸露的 sidet-search 文本。",
    "- 把当前自然语言转换成可直接搜索的文本，再写进 query1 到 query3。",
    "- query1 优先给最直接的一组搜索文本；query2、query3 再补别名、正式名称、英文名或站点线索。",
    "- 如果这句话只是续接上文，例如“你重新帮我搜一下”，要结合当前对话恢复真正主题，不要把续接词本身当成搜索词。",
    "- 收到 sidet-search-result 或 sidet-web-context 后，如果现有材料已经足够，就直接输出给用户看的最终答复正文。",
    "- 只有还需要工具时，才输出 ```sidet-fetch``` 或新的 ```sidet-search```。",
    "- 如果要抓取网页，只输出一个 ```sidet-fetch```；字段用 round、pick1 到 pick3，reason 按需补。",
    "- `sidet-fetch` 必须使用完整的 fenced code block。",
    "- `pick1` 到 `pick3` 填的是“上一轮搜索结果的序号”，不是 URL。",
    "- 如果 1 个网页已经够，优先只抓 1 个；只有多个网页分别补不同事实时，才抓 2 到 3 个。",
    "- 如果当前问题是在问最新动态、阶段变化、盘点、对比、原因或总结，而你手里只有标题和摘要，优先先抓 1 到 3 个网页正文，再整理答复。",
    "- 不要只把搜索结果标题和链接重新列一遍就停下；如果材料不够，就继续抓取或继续搜索。",
    "- 只有当你已经能给出一版有判断、有整理的结论时，才直接输出最终答复正文。",
    "- `sidet-search` 合法格式示范：",
    ...buildSearchProtocolExample(),
    "- `sidet-fetch` 合法格式示范：",
    ...buildFetchProtocolExample(),
    ...buildSharedVisibleReasonRules(),
    ...buildSharedNonDisclosureRules(),
    "- 只有在进入最终答复阶段时，才输出给用户看的正常正文。"
  ].join("\n");
}

export function buildSidetWebSearchContinuationRepairContext(): string {
  return [
    "Sidet 联网继续处理补正：",
    "- 你上一条没有给出可执行下一步，也没有给出可显示的最终答复。",
    "- 现在按当前材料只做一件事：直接输出最终答复正文；或输出一个 ```sidet-fetch```；或输出一个新的 ```sidet-search```。",
    "- 如果当前只有搜索结果标题和摘要，而问题明显需要事实、动态、盘点、对比、原因或总结，优先输出 ```sidet-fetch``` 抓 1 到 3 个网页正文。",
    "- 如果搜索词明显不准，再输出新的 ```sidet-search``` 换词继续搜。",
    "- 如果现有材料已经够，就直接输出给用户看的最终答复正文。",
    "- 如果输出协议，必须使用完整的 fenced code block。",
    "- 如果输出 `sidet-fetch`，`pick1` 到 `pick3` 填的是搜索结果序号，不是 URL。",
    "- 不要只回一句“我先找到了几条网页”或只重复列出链接；这不算最终答复。",
    "- 不要输出“先给你结果”“先看这几条”“我先列一下网页”这类过渡话。",
    "- `sidet-search` 合法格式示范：",
    ...buildSearchProtocolExample(),
    "- `sidet-fetch` 合法格式示范：",
    ...buildFetchProtocolExample(),
    "- 不要输出 sidet-direct，不要解释协议，不要留空。"
  ].join("\n");
}

export function buildSidetDirectAnswerContext(): string {
  return [
    "Sidet 直接回答模式：",
    "- 这轮没有进入联网搜索，请直接基于当前上下文回答。",
    "- 不要向用户解释你是否联网、是否具备联网能力，也不要暴露 Sidet 内部协议。",
    "- 不要说“我无法联网”“我没有实时信息”“我没有浏览能力”这类话。",
    "- 如果问题本身依赖最新事实，而当前上下文里没有这些事实，就如实说明现在无法确认最新进展，不要编造。"
  ].join("\n");
}

export function buildSidetWebSearchFinalAnswerContext(): string {
  return [
    "Sidet 联网最终答复：",
    "- 上面的搜索结果和网页正文已经准备好。",
    "- 现在只输出给用户看的最终答复正文。",
    "- 不要输出 sidet-search / sidet-fetch / sidet-direct。",
    "- 不要解释内部协议，也不要复述内部流程规则。",
    "- 如果需要引用来源，可以在正文里少量提到关键来源；不要把上面已经列过的一整串链接再重复抄一遍。",
    "- 如果目前只有搜索结果标题和摘要，也要先给出一个阶段性回答，明确哪些点还没完全确认，不要留空。"
  ].join("\n");
}

export function buildSidetWebSearchFinalAnswerRepairContext(): string {
  return [
    "Sidet 联网最终答复修正：",
    "- 你上一条没有给出可显示的最终答复。",
    "- 现在只输出给用户看的最终答复正文。",
    "- 不要输出 sidet-search / sidet-fetch / sidet-direct。",
    "- 不要重复内部思考过程，不要解释协议。",
    "- 如果当前上下文已经足够，就直接整理成完整答复。",
    "- 不要只重复网页标题、链接或“我先找到几条结果”这类半成品描述。",
    "- 如果目前只有搜索结果标题和摘要，也先据此给出阶段性回答，不要留空。"
  ].join("\n");
}
