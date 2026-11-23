export function normalizeHomeCommandSourceLabel(sourceLabel: string): string {
  return sourceLabel
    .trim()
    .replace(/^(?:核心)?插件\s*[：:]\s*/u, "")
    .trim();
}
