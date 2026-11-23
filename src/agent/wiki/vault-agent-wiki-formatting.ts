import type { WikiKnowledgeBaseInfo, WikiKnowledgeMatch } from "./wiki-memory-index";

export function getWikiKindLabel(match: WikiKnowledgeMatch): string {
  if (match.kind === "knowledge-base") {
    return "知识库根页";
  }
  if (match.kind === "concept-page") {
    return "概念页";
  }
  if (match.kind === "supporting-note") {
    return "详页";
  }
  if (match.kind === "knowledge-card") {
    return "知识卡";
  }
  return "Wiki";
}

export function buildKnowledgeBaseRouteLine(knowledgeBase: WikiKnowledgeBaseInfo, index: number): string {
  const scope = knowledgeBase.rootPath.endsWith("/")
    ? knowledgeBase.rootPath
    : `${knowledgeBase.rootPath}/`;
  return [
    `${index + 1}. [[${knowledgeBase.indexPath}]]`,
    `显示：${knowledgeBase.displayName}`,
    `范围：${scope}`,
    `摘要：${knowledgeBase.summary || "无摘要"}`,
    "阶段：只读识别 + 同目录关键词检索"
  ].join("；");
}

export function buildWikiMaintenanceCandidateLine(match: WikiKnowledgeMatch, index: number): string {
  const matched = match.matchedTerms.slice(0, 8).join(" / ") || "标题或路径相关";
  return [
    `${index + 1}. [[${match.file.path}]]`,
    `类型：${getWikiKindLabel(match)}`,
    `摘要：${match.summary || "无摘要"}`,
    `匹配：${matched}`,
    `读取：${match.routeHint}`
  ].join("；");
}

export function formatWikiMatchContent(match: WikiKnowledgeMatch): string {
  const sections = [`摘要：${match.summary || "无摘要"}`];
  if (match.kind === "knowledge-base") {
    sections.push(`定位：${match.routeHint}`);
  }
  if (match.outline.length > 0) {
    sections.push(["大纲：", ...match.outline.map((item) => `- ${item}`)].join("\n"));
  }
  if (match.relatedLinks.length > 0) {
    sections.push(`相关：${match.relatedLinks.map((item) => `[[${item}]]`).join("，")}`);
  }
  if (match.sourceLinks.length > 0) {
    sections.push(`来源：${match.sourceLinks.map((item) => item.startsWith("http") ? item : `[[${item}]]`).join("，")}`);
  }
  if (match.kind !== "concept-page" && match.kind !== "knowledge-base") {
    sections.push(`正文摘录：\n${match.excerpt}`);
  }
  return sections.join("\n\n");
}
