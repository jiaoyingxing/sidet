function normalizeWebpageAttachmentContent(content: string): string {
  return content.replace(/\r\n/g, "\n").trim();
}

function normalizeTitleComparable(text: string): string {
  return normalizeWebpageAttachmentContent(text)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[>*\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function extractWebpageAttachmentMarkdown(content: string): string {
  const normalized = normalizeWebpageAttachmentContent(content);
  const lines = normalized.split("\n");
  const openingFenceIndex = lines.findIndex((line) => line.trim().startsWith("```"));
  const closingFenceIndex = (() => {
    for (let index = lines.length - 1; index > openingFenceIndex; index -= 1) {
      if (lines[index]?.trim() === "```") {
        return index;
      }
    }
    return -1;
  })();

  if (openingFenceIndex >= 0 && closingFenceIndex > openingFenceIndex) {
    const fencedContent = lines
      .slice(openingFenceIndex + 1, closingFenceIndex)
      .join("\n")
      .trim();
    if (fencedContent) {
      return fencedContent;
    }
  }

  const filteredLines = lines.filter((line, index) => {
    if (index === 0 && line.trim() === "引用网页：") {
      return false;
    }
    return !/^(标题|来源|站点|说明)：/.test(line.trim());
  });

  const fallback = filteredLines.join("\n").trim();
  if (fallback) {
    return fallback;
  }

  return normalized;
}

export function stripLeadingWebpageTitle(markdown: string, title: string): string {
  const normalized = normalizeWebpageAttachmentContent(markdown);
  const comparableTitle = normalizeTitleComparable(title);
  if (!normalized || !comparableTitle) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex < 0) {
    return normalized;
  }

  const firstLine = lines[firstContentIndex]?.trim() ?? "";
  if (normalizeTitleComparable(firstLine) !== comparableTitle) {
    return normalized;
  }

  const consumedLineCount = (() => {
    const nextLine = lines[firstContentIndex + 1]?.trim() ?? "";
    if (/^(=+|-+)$/.test(nextLine)) {
      return 2;
    }
    return 1;
  })();

  lines.splice(firstContentIndex, consumedLineCount);
  while (firstContentIndex < lines.length && lines[firstContentIndex]?.trim() === "") {
    lines.splice(firstContentIndex, 1);
  }
  return lines.join("\n").trimStart();
}
