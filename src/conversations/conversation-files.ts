import { App } from "obsidian";
import { FOLDERS_FILE, PLUGIN_DATA_DIR, THREADS_DIR } from "../constants";
import { ensureFolder } from "../shared/paths";
import type { ConversationFolderRecord, ConversationRecord } from "../types";

function parseFolderPayload(raw: string): ConversationFolderRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as ConversationFolderRecord[];
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { folders?: unknown }).folders)) {
    return (parsed as { folders: ConversationFolderRecord[] }).folders;
  }
  return [];
}

export class ConversationFiles {
  constructor(private readonly app: App) {}

  async loadFolders(): Promise<ConversationFolderRecord[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(FOLDERS_FILE))) {
      return [];
    }

    try {
      const raw = await adapter.read(FOLDERS_FILE);
      return parseFolderPayload(raw);
    } catch (error) {
      console.error("Sidet：读取文件夹索引失败", { filePath: FOLDERS_FILE, error });
      return [];
    }
  }

  async saveFolders(folders: ConversationFolderRecord[]): Promise<void> {
    await ensureFolder(this.app, PLUGIN_DATA_DIR);
    await this.app.vault.adapter.write(FOLDERS_FILE, JSON.stringify({ folders }, null, 2));
  }

  async loadAllConversations(): Promise<ConversationRecord[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(THREADS_DIR))) {
      return [];
    }

    const listed = await adapter.list(THREADS_DIR);
    const conversations: ConversationRecord[] = [];

    for (const filePath of listed.files) {
      if (!filePath.endsWith(".json")) {
        continue;
      }

      try {
        const raw = await adapter.read(filePath);
        const parsed = JSON.parse(raw) as ConversationRecord;
        if (parsed?.id && Array.isArray(parsed.messages)) {
          conversations.push(parsed);
        }
      } catch (error) {
        console.error("Sidet：读取线程文件失败", { filePath, error });
      }
    }

    conversations.sort((left, right) => right.updatedAt - left.updatedAt);
    return conversations;
  }

  async saveConversation(conversation: ConversationRecord): Promise<void> {
    await ensureFolder(this.app, THREADS_DIR);
    const payload = JSON.stringify(conversation, null, 2);
    await this.app.vault.adapter.write(this.getFilePath(conversation.id), payload);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    const filePath = this.getFilePath(conversationId);
    if (!(await adapter.exists(filePath))) {
      return;
    }
    await adapter.remove(filePath);
  }

  private getFilePath(conversationId: string): string {
    return `${THREADS_DIR}/${conversationId}.json`;
  }
}
