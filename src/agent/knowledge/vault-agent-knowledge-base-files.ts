import { App, TFile, TFolder } from "obsidian";
import { DEFAULT_AGENT_WIKI_FOLDER } from "../../constants";
import { ensureFolder } from "../../shared/paths";
import {
  WIKI_INDEX_FILE_NAME,
  WIKI_NOTE_KIND_KNOWLEDGE_BASE,
  buildNormalizedWikiMarkdownFromPath,
  buildWikiIndexTemplate,
  buildWikiNoteMarkdown
} from "../wiki/wiki-note-schema";

function normalizeKnowledgeBaseFolderPath(path: string): string {
  return path.replace(/\\/g, "/").trim().replace(/^\/+|\/+$/g, "");
}

function resolveKnowledgeBaseIndexPath(folderPath: string): string {
  const normalized = normalizeKnowledgeBaseFolderPath(folderPath);
  return normalized ? `${normalized}/${WIKI_INDEX_FILE_NAME}` : WIKI_INDEX_FILE_NAME;
}

function resolveKnowledgeBaseDisplayName(folder: Pick<TFolder, "name" | "path">): string {
  const name = folder.name.trim();
  if (name) {
    return name;
  }

  const normalizedPath = normalizeKnowledgeBaseFolderPath(folder.path);
  return normalizedPath.split("/").pop()?.trim() || "知识库";
}

function buildKnowledgeBaseIndexTemplateForFolder(folder: Pick<TFolder, "name" | "path">): string {
  const displayName = resolveKnowledgeBaseDisplayName(folder);
  return buildWikiNoteMarkdown({
    title: "Index",
    body: [
      "## 概要",
      `- 这页只做 ${displayName} 的知识库根路由，不堆长正文。`,
      "",
      "## 先读",
      "- `[[概念页标题]]`",
      "- `[[高价值知识卡]]`",
      "",
      "## 主题",
      "### 当前主主题",
      "- 写当前最重要的主题入口。",
      "",
      "### 正在生长",
      "- 放正在继续扩展的概念页或主题分支。",
      "",
      "## 相关",
      "- `[[相关知识卡]]`",
      "- `[[相关概念页]]`"
    ].join("\n"),
    fields: {
      kind: WIKI_NOTE_KIND_KNOWLEDGE_BASE,
      summary: `${displayName} 的知识库根页，负责当前主题入口、先读顺序和库内路由。`,
      aliases: displayName ? [displayName] : [],
      related: [],
      sources: []
    }
  });
}

export class VaultAgentKnowledgeBaseFiles {
  constructor(private readonly app: App) {}

  async createIndexForFolder(folder: TFolder): Promise<{ path: string; created: boolean }> {
    const { indexPath, indexCreated } = await this.ensureKnowledgeBaseIndexFile(
      folder.path,
      () => buildKnowledgeBaseIndexTemplateForFolder(folder)
    );
    return {
      path: indexPath,
      created: indexCreated
    };
  }

  async repairMalformedWikiNotes(): Promise<{ scanned: number; repaired: string[]; indexCreated: boolean }> {
    const { indexCreated } = await this.ensureKnowledgeBaseIndexFile(
      DEFAULT_AGENT_WIKI_FOLDER,
      () => buildWikiIndexTemplate()
    );

    const prefix = DEFAULT_AGENT_WIKI_FOLDER.endsWith("/")
      ? DEFAULT_AGENT_WIKI_FOLDER
      : `${DEFAULT_AGENT_WIKI_FOLDER}/`;
    const files = this.app.vault
      .getMarkdownFiles()
      .filter((file) => file.path.startsWith(prefix))
      .sort((left, right) => left.path.localeCompare(right.path));
    const repaired: string[] = [];

    for (const file of files) {
      const raw = await this.app.vault.cachedRead(file);
      const normalized = buildNormalizedWikiMarkdownFromPath(file.path, raw, {}, {
        preserveUpdatedAt: true
      });
      const comparableRaw = `${raw.replace(/\r\n/g, "\n").trimEnd()}\n`;
      if (normalized === comparableRaw) {
        continue;
      }

      await this.app.vault.modify(file, normalized);
      repaired.push(file.path);
    }

    return {
      scanned: files.length,
      repaired,
      indexCreated
    };
  }

  private async ensureKnowledgeBaseIndexFile(
    folderPath: string,
    buildTemplate: () => string
  ): Promise<{ indexPath: string; indexCreated: boolean }> {
    const normalizedFolderPath = normalizeKnowledgeBaseFolderPath(folderPath);
    const indexPath = resolveKnowledgeBaseIndexPath(normalizedFolderPath);
    const existingIndex = this.app.vault.getAbstractFileByPath(indexPath);

    if (existingIndex instanceof TFile) {
      if (existingIndex.extension !== "md") {
        throw new Error(`目标位置已存在非 Markdown 文件：${indexPath}`);
      }
      return {
        indexPath,
        indexCreated: false
      };
    }

    if (existingIndex) {
      throw new Error(`目标位置已存在同名项目：${indexPath}`);
    }

    await ensureFolder(this.app, normalizedFolderPath);
    await this.app.vault.create(indexPath, buildTemplate());
    return {
      indexPath,
      indexCreated: true
    };
  }
}
