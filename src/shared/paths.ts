import { App, normalizePath } from "obsidian";

export function makeId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function sanitizeFileName(input: string): string {
  const normalized = input
    // eslint-disable-next-line no-control-regex -- 该正则的用途就是匹配并清除文件名中的控制字符（消毒）
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const safe = normalized.replace(/[. ]+$/g, "");
  return safe.length > 0 ? safe.slice(0, 80) : "未命名";
}

export async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const adapter = app.vault.adapter;
  const normalized = normalizePath(folderPath);
  const parts = normalized.split("/").filter(Boolean);
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (await adapter.exists(current)) {
      continue;
    }
    await adapter.mkdir(current);
  }
}
