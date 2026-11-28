import { Platform, TFile, WorkspaceLeaf } from "obsidian";
import type { ActiveContextService } from "../context/active-context";
import type { VaultAgentService } from "../agent/vault-agent";
import { ChatContextInsertionService } from "./chat-context-insertion";
import { WorkspaceLeafNavigation } from "./workspace-leaf-navigation";
import type { ChatLeafRuntime } from "./chat-leaf-runtime";

interface UriOpenChatOptions {
  focusComposer?: boolean;
  text?: string;
  append?: boolean;
  clipboard?: boolean;
}

interface ChatDraftIntakeOptions {
  activeContext: ActiveContextService;
  vaultAgent: VaultAgentService;
  leafNavigation: WorkspaceLeafNavigation;
  runtime: ChatLeafRuntime;
}

export class ChatDraftIntake {
  private readonly contextInsertion: ChatContextInsertionService;

  constructor(private readonly options: ChatDraftIntakeOptions) {
    this.contextInsertion = new ChatContextInsertionService({
      activeContext: options.activeContext,
      vaultAgent: options.vaultAgent,
      resolveDraftTargetLeaf: (targetLeaf) => this.options.leafNavigation.resolveDraftTargetLeaf(targetLeaf),
      mergeContextIntoComposerDraft: (leaf, result) => this.options.runtime.mergeContextIntoComposerDraft(leaf, result),
      getConversationForLeaf: (leaf) => this.options.runtime.getConversationForLeaf(leaf),
      getNavigationChatLeaf: () => this.options.leafNavigation.getNavigationChatLeaf()
    });
  }

  async openChatFromUri(options: UriOpenChatOptions = {}): Promise<WorkspaceLeaf> {
    const {
      focusComposer = true,
      text
    } = options;
    const trimmedText = text?.trim() ?? "";
    const isUrl = this.isUrlLike(trimmedText);

    if (options.clipboard) {
      const clipboardText = await this.readClipboardText();
      const normalizedClipboard = clipboardText.trim();
      if (normalizedClipboard) {
        if (this.isUrlLike(normalizedClipboard)) {
          return this.openExternalUrlImport(normalizedClipboard, {
            focusComposer
          });
        }
        return this.openTextImport(normalizedClipboard, {
          focusComposer,
          append: options.append === true
        });
      }
    }

    if (isUrl) {
      return this.openExternalUrlImport(trimmedText, {
        focusComposer
      });
    }

    if (trimmedText.length === 0) {
      return this.options.leafNavigation.openNewChatTab({
        focusComposer,
        reuseHomepage: true
      });
    }

    return this.openTextImport(trimmedText, {
      focusComposer,
      append: options.append === true
    });
  }

  async insertCurrentNoteIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.contextInsertion.insertCurrentNoteIntoDraft(targetLeaf);
  }

  async insertCurrentSelectionIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.contextInsertion.insertCurrentSelectionIntoDraft(targetLeaf);
  }

  async insertMarkdownFileIntoDraft(file: TFile, targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.contextInsertion.insertMarkdownFileIntoDraft(file, targetLeaf);
  }


  async insertDraftNotePreviewPromptIntoDraft(targetLeaf?: WorkspaceLeaf): Promise<void> {
    await this.contextInsertion.insertDraftNotePreviewPromptIntoDraft(targetLeaf);
  }

  private async openExternalUrlImport(
    url: string,
    options: { focusComposer: boolean }
  ): Promise<WorkspaceLeaf> {
    const leaf = await this.options.leafNavigation.openNewChatTab({
      focusComposer: options.focusComposer,
      reuseHomepage: false
    });
    this.options.runtime.queueExternalImportRequest(leaf, {
      kind: "url",
      url,
      focusComposer: options.focusComposer,
      source: "uri"
    });
    this.options.runtime.focusComposer(leaf);
    return leaf;
  }

  private async openTextImport(
    text: string,
    options: { focusComposer: boolean; append: boolean }
  ): Promise<WorkspaceLeaf> {
    const leaf = await this.options.leafNavigation.openNewChatTab({
      focusComposer: options.focusComposer,
      reuseHomepage: false
    });
    this.options.runtime.setComposerDraft(leaf, text, {
      immediatePersistence: true
    });
    if (options.focusComposer) {
      this.options.runtime.focusComposer(leaf);
    }
    return leaf;
  }

  private isUrlLike(text: string): boolean {
    if (!text) {
      return false;
    }
    try {
      const url = new URL(text);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }

  private async readClipboardText(): Promise<string> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text.trim()) {
          return text;
        }
      } catch (error) {
        console.warn("Sidet：读取系统剪贴板失败，尝试桌面兜底。", error);
      }
    }

    if (!Platform.isDesktopApp) {
      return "";
    }

    try {
      const runtimeRequire = (window as Window & { require?: (moduleName: string) => unknown }).require
        ?? (typeof require === "function" ? require : null);
      if (!runtimeRequire) {
        return "";
      }
      const electron = runtimeRequire("electron") as {
        clipboard?: { readText?: () => string };
        remote?: { clipboard?: { readText?: () => string } };
      };
      return electron.remote?.clipboard?.readText?.() ?? electron.clipboard?.readText?.() ?? "";
    } catch {
      return "";
    }
  }
}
