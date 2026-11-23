import { TFile, setIcon } from "obsidian";
import { extractWebUrlMatches, type WebUrlMatch } from "../context/webpage-context";
import type { MessageAttachment } from "../types";
import type { WorkspaceController } from "./workspace-controller";

interface MentionQuery {
  start: number;
  end: number;
  query: string;
}

interface ChatViewInlineSuggestsOptions {
  controller: WorkspaceController;
  getContainerDocument: () => Document;
  getTextareaElements: () => Array<HTMLTextAreaElement | null>;
  getPreferredComposerTextarea: () => HTMLTextAreaElement | null;
  getDraftAttachments: () => MessageAttachment[];
  getLocalDraft: () => string;
  setLocalDraft: (
    draft: string,
    options?: {
      syncController?: boolean;
      suppressEchoToOrigin?: boolean;
      immediatePersistence?: boolean;
    }
  ) => void;
  isEditingDraftActive: () => boolean;
  focusComposerTextarea: (textareaEl: HTMLTextAreaElement | null) => void;
  addMarkdownAttachment: (file: TFile) => Promise<void>;
  addWebpageAttachmentFromUrl: (
    url: string,
    options?: {
      draftSnapshot?: string;
      matchedUrl?: WebUrlMatch;
      textareaEl?: HTMLTextAreaElement | null;
    }
  ) => Promise<void>;
}

export class ChatViewInlineSuggests {
  private mentionSuggestEl: HTMLDivElement | null = null;
  private mentionOutsidePointerDown: ((event: PointerEvent) => void) | null = null;
  private mentionQuery: MentionQuery | null = null;
  private mentionCandidates: TFile[] = [];
  private mentionSelectedIndex = 0;
  private linkSuggestEl: HTMLDivElement | null = null;
  private linkOutsidePointerDown: ((event: PointerEvent) => void) | null = null;
  private linkCandidates: WebUrlMatch[] = [];
  private linkSelectedIndex = 0;

  constructor(private readonly options: ChatViewInlineSuggestsOptions) {}

  closeAll(): void {
    this.closeMentionSuggest();
    this.closeLinkSuggest();
  }

  reposition(): void {
    this.positionMentionSuggest(this.options.getPreferredComposerTextarea());
    this.positionLinkSuggest(this.options.getPreferredComposerTextarea());
  }

  removeSelectedLinkText(match: WebUrlMatch, draftSnapshot: string): string {
    const currentDraft = this.options.getLocalDraft();
    if (currentDraft === draftSnapshot) {
      return this.removeDraftSegment(currentDraft, match.start, match.end);
    }

    const rawIndex = currentDraft.indexOf(match.rawUrl);
    if (rawIndex >= 0) {
      return this.removeDraftSegment(currentDraft, rawIndex, rawIndex + match.rawUrl.length);
    }

    const normalizedIndex = currentDraft.indexOf(match.normalizedUrl);
    if (normalizedIndex >= 0) {
      return this.removeDraftSegment(currentDraft, normalizedIndex, normalizedIndex + match.normalizedUrl.length);
    }

    return currentDraft;
  }

  syncInlineSuggests(textareaEl: HTMLTextAreaElement | null): void {
    this.updateMentionSuggest(textareaEl);
    if (this.mentionSuggestEl) {
      this.closeLinkSuggest();
      return;
    }
    this.updateLinkSuggest(textareaEl);
  }

  handleMentionSuggestKeydown(event: KeyboardEvent): boolean {
    if (!this.mentionSuggestEl || this.mentionCandidates.length === 0) {
      return false;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeMentionSuggest();
      return true;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      this.mentionSelectedIndex = (this.mentionSelectedIndex + 1) % this.mentionCandidates.length;
      this.renderMentionSuggest(this.options.getPreferredComposerTextarea());
      return true;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.mentionSelectedIndex =
        (this.mentionSelectedIndex + this.mentionCandidates.length - 1) % this.mentionCandidates.length;
      this.renderMentionSuggest(this.options.getPreferredComposerTextarea());
      return true;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      void this.selectMentionCandidate(this.mentionSelectedIndex, this.options.getPreferredComposerTextarea());
      return true;
    }

    return false;
  }

  handleLinkSuggestKeydown(event: KeyboardEvent): boolean {
    if (!this.linkSuggestEl || this.linkCandidates.length === 0) {
      return false;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.closeLinkSuggest();
      return true;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      this.linkSelectedIndex = (this.linkSelectedIndex + 1) % this.linkCandidates.length;
      this.renderLinkSuggest(this.options.getPreferredComposerTextarea());
      return true;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this.linkSelectedIndex = (this.linkSelectedIndex + this.linkCandidates.length - 1) % this.linkCandidates.length;
      this.renderLinkSuggest(this.options.getPreferredComposerTextarea());
      return true;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      void this.selectLinkCandidate(this.linkSelectedIndex, this.options.getPreferredComposerTextarea());
      return true;
    }

    return false;
  }

  private resolveMentionQuery(textareaEl: HTMLTextAreaElement | null): MentionQuery | null {
    if (!textareaEl || textareaEl.selectionStart !== textareaEl.selectionEnd) {
      return null;
    }

    const caret = textareaEl.selectionStart;
    const beforeCaret = textareaEl.value.slice(0, caret);
    const atIndex = beforeCaret.lastIndexOf("@");
    if (atIndex < 0) {
      return null;
    }

    const query = beforeCaret.slice(atIndex + 1);
    if (query.length > 48 || /[\s\n\r]/.test(query)) {
      return null;
    }

    const previous = atIndex > 0 ? beforeCaret[atIndex - 1] : "";
    if (previous && /[A-Za-z0-9_./\\-]/.test(previous)) {
      return null;
    }

    return {
      start: atIndex,
      end: caret,
      query
    };
  }

  private updateMentionSuggest(textareaEl: HTMLTextAreaElement | null): void {
    const query = this.resolveMentionQuery(textareaEl);
    if (!query) {
      this.closeMentionSuggest();
      return;
    }

    const candidates = this.getMentionCandidates(query.query);
    if (candidates.length === 0) {
      this.closeMentionSuggest();
      return;
    }

    const shouldResetSelection =
      !this.mentionQuery ||
      this.mentionQuery.start !== query.start ||
      this.mentionQuery.query !== query.query;
    this.mentionQuery = query;
    this.mentionCandidates = candidates;
    this.mentionSelectedIndex = shouldResetSelection
      ? 0
      : Math.min(this.mentionSelectedIndex, candidates.length - 1);
    this.renderMentionSuggest(textareaEl);
  }

  private getMentionCandidates(query: string): TFile[] {
    const normalizedQuery = query.trim().toLowerCase();
    const files = this.options.controller.getApp().vault.getMarkdownFiles();
    const scored = files
      .map((file) => {
        const basename = file.basename.toLowerCase();
        const path = file.path.toLowerCase();
        if (!normalizedQuery) {
          return {
            file,
            score: Math.max(0, file.stat.mtime)
          };
        }
        if (basename === normalizedQuery) {
          return { file, score: 100000 + file.stat.mtime };
        }
        if (basename.startsWith(normalizedQuery)) {
          return { file, score: 80000 + file.stat.mtime };
        }
        if (basename.includes(normalizedQuery)) {
          return { file, score: 60000 + file.stat.mtime };
        }
        if (path.includes(normalizedQuery)) {
          return { file, score: 40000 + file.stat.mtime };
        }
        return { file, score: -1 };
      })
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path));

    return scored.slice(0, 6).map((item) => item.file);
  }

  private renderMentionSuggest(textareaEl: HTMLTextAreaElement | null): void {
    const doc = this.options.getContainerDocument();
    if (!this.mentionSuggestEl) {
      this.mentionSuggestEl = doc.body.createDiv({ cls: "sidet-mention-suggest" });
      this.mentionOutsidePointerDown = (event) => {
        const target = event.target;
        if (!(target instanceof Node)) {
          this.closeMentionSuggest();
          return;
        }
        if (this.mentionSuggestEl?.contains(target) || this.isTextareaTarget(target)) {
          return;
        }
        this.closeMentionSuggest();
      };
      doc.addEventListener("pointerdown", this.mentionOutsidePointerDown, true);
    }

    this.mentionSuggestEl.empty();
    this.mentionSuggestEl.setAttribute("role", "listbox");
    this.mentionCandidates.forEach((file, index) => {
      const itemEl = this.mentionSuggestEl?.createDiv({
        cls: [
          "sidet-mention-suggest-item",
          index === this.mentionSelectedIndex ? "is-selected" : ""
        ].filter(Boolean).join(" ")
      });
      if (!itemEl) {
        return;
      }
      itemEl.setAttribute("role", "option");
      itemEl.setAttribute("aria-selected", index === this.mentionSelectedIndex ? "true" : "false");
      const iconEl = itemEl.createSpan({ cls: "sidet-mention-suggest-icon" });
      iconEl.setAttribute("aria-hidden", "true");
      setIcon(iconEl, "file-text");
      const textEl = itemEl.createSpan({ cls: "sidet-mention-suggest-text" });
      textEl.createSpan({ cls: "sidet-mention-suggest-title", text: file.basename });
      textEl.createSpan({ cls: "sidet-mention-suggest-path", text: file.path });
      itemEl.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.selectMentionCandidate(index, textareaEl);
      });
      itemEl.addEventListener("mouseenter", () => {
        this.mentionSelectedIndex = index;
        this.renderMentionSuggest(textareaEl);
      });
    });
    this.positionMentionSuggest(textareaEl);
  }

  private positionMentionSuggest(textareaEl: HTMLTextAreaElement | null): void {
    if (!this.mentionSuggestEl || !textareaEl) {
      return;
    }

    const anchorRect = textareaEl.getBoundingClientRect();
    const panelRect = this.mentionSuggestEl.getBoundingClientRect();
    const viewportPadding = 10;
    const gap = 8;
    const maxLeft = window.innerWidth - panelRect.width - viewportPadding;
    const left = Math.min(Math.max(anchorRect.left, viewportPadding), Math.max(viewportPadding, maxLeft));
    let top = anchorRect.top - panelRect.height - gap;
    if (top < viewportPadding) {
      top = Math.min(window.innerHeight - panelRect.height - viewportPadding, anchorRect.bottom + gap);
    }

    this.mentionSuggestEl.style.left = `${left}px`;
    this.mentionSuggestEl.style.top = `${Math.max(viewportPadding, top)}px`;
  }

  private async selectMentionCandidate(index: number, textareaEl: HTMLTextAreaElement | null): Promise<void> {
    const file = this.mentionCandidates[index];
    const query = this.mentionQuery;
    if (!file || !query) {
      this.closeMentionSuggest();
      return;
    }

    const currentDraft = this.options.getLocalDraft();
    const nextDraft = `${currentDraft.slice(0, query.start)}${currentDraft.slice(query.end)}`;
    this.closeMentionSuggest();
    this.options.setLocalDraft(nextDraft, {
      syncController: !this.options.isEditingDraftActive(),
      suppressEchoToOrigin: true
    });
    const targetTextarea = textareaEl ?? this.options.getPreferredComposerTextarea();
    this.options.focusComposerTextarea(targetTextarea);
    targetTextarea?.setSelectionRange(query.start, query.start);
    await this.options.addMarkdownAttachment(file);
  }

  private closeMentionSuggest(): void {
    if (this.mentionOutsidePointerDown) {
      this.options.getContainerDocument().removeEventListener("pointerdown", this.mentionOutsidePointerDown, true);
      this.mentionOutsidePointerDown = null;
    }
    this.mentionSuggestEl?.remove();
    this.mentionSuggestEl = null;
    this.mentionQuery = null;
    this.mentionCandidates = [];
    this.mentionSelectedIndex = 0;
  }

  private getLinkSuggestCandidates(textareaEl: HTMLTextAreaElement | null): WebUrlMatch[] {
    if (!textareaEl || textareaEl.selectionStart !== textareaEl.selectionEnd) {
      return [];
    }

    const attachedUrls = new Set(
      this.options.getDraftAttachments()
        .filter((attachment) => attachment.type === "webpage")
        .map((attachment) => attachment.url)
    );
    const matches = extractWebUrlMatches(textareaEl.value).filter(
      (match) => !attachedUrls.has(match.normalizedUrl)
    );
    if (matches.length === 0) {
      return [];
    }

    const caret = textareaEl.selectionStart;
    const activeMatches = matches.filter(
      (match) => caret >= match.start && caret <= Math.min(textareaEl.value.length, match.end + 1)
    );
    if (activeMatches.length === 0) {
      return [];
    }

    const passiveMatches = matches.filter((match) => !activeMatches.includes(match));
    return [...activeMatches, ...passiveMatches].slice(0, 6);
  }

  private updateLinkSuggest(textareaEl: HTMLTextAreaElement | null): void {
    const candidates = this.getLinkSuggestCandidates(textareaEl);
    if (candidates.length === 0) {
      this.closeLinkSuggest();
      return;
    }

    const shouldResetSelection =
      candidates.length !== this.linkCandidates.length
      || candidates.some((candidate, index) => {
        const previous = this.linkCandidates[index];
        return (
          !previous
          || previous.start !== candidate.start
          || previous.end !== candidate.end
          || previous.normalizedUrl !== candidate.normalizedUrl
        );
      });
    this.linkCandidates = candidates;
    this.linkSelectedIndex = shouldResetSelection
      ? 0
      : Math.min(this.linkSelectedIndex, candidates.length - 1);
    this.renderLinkSuggest(textareaEl);
  }

  private renderLinkSuggest(textareaEl: HTMLTextAreaElement | null): void {
    const doc = this.options.getContainerDocument();
    if (!this.linkSuggestEl) {
      this.linkSuggestEl = doc.body.createDiv({ cls: "sidet-mention-suggest" });
      this.linkOutsidePointerDown = (event) => {
        const target = event.target;
        if (!(target instanceof Node)) {
          this.closeLinkSuggest();
          return;
        }
        if (this.linkSuggestEl?.contains(target) || this.isTextareaTarget(target)) {
          return;
        }
        this.closeLinkSuggest();
      };
      doc.addEventListener("pointerdown", this.linkOutsidePointerDown, true);
    }

    this.linkSuggestEl.empty();
    this.linkSuggestEl.setAttribute("role", "listbox");
    this.linkCandidates.forEach((candidate, index) => {
      const itemEl = this.linkSuggestEl?.createDiv({
        cls: [
          "sidet-mention-suggest-item",
          index === this.linkSelectedIndex ? "is-selected" : ""
        ].filter(Boolean).join(" ")
      });
      if (!itemEl) {
        return;
      }
      itemEl.setAttribute("role", "option");
      itemEl.setAttribute("aria-selected", index === this.linkSelectedIndex ? "true" : "false");
      const iconEl = itemEl.createSpan({ cls: "sidet-mention-suggest-icon" });
      iconEl.setAttribute("aria-hidden", "true");
      setIcon(iconEl, "globe");
      const textEl = itemEl.createSpan({ cls: "sidet-mention-suggest-text" });
      textEl.createSpan({
        cls: "sidet-mention-suggest-title",
        text: candidate.host.replace(/^www\./i, "")
      });
      textEl.createSpan({
        cls: "sidet-mention-suggest-path",
        text: candidate.normalizedUrl
      });
      itemEl.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.selectLinkCandidate(index, textareaEl);
      });
      itemEl.addEventListener("mouseenter", () => {
        this.linkSelectedIndex = index;
        this.renderLinkSuggest(textareaEl);
      });
    });
    this.positionLinkSuggest(textareaEl);
  }

  private positionLinkSuggest(textareaEl: HTMLTextAreaElement | null): void {
    if (!this.linkSuggestEl || !textareaEl) {
      return;
    }

    const anchorRect = textareaEl.getBoundingClientRect();
    const panelRect = this.linkSuggestEl.getBoundingClientRect();
    const viewportPadding = 10;
    const gap = 8;
    const maxLeft = window.innerWidth - panelRect.width - viewportPadding;
    const left = Math.min(Math.max(anchorRect.left, viewportPadding), Math.max(viewportPadding, maxLeft));
    let top = anchorRect.top - panelRect.height - gap;
    if (top < viewportPadding) {
      top = Math.min(window.innerHeight - panelRect.height - viewportPadding, anchorRect.bottom + gap);
    }

    this.linkSuggestEl.style.left = `${left}px`;
    this.linkSuggestEl.style.top = `${Math.max(viewportPadding, top)}px`;
  }

  private removeDraftSegment(text: string, start: number, end: number): string {
    const prefix = text.slice(0, start);
    const suffix = text.slice(end);
    if (prefix.endsWith(" ") && suffix.startsWith(" ")) {
      return `${prefix}${suffix.slice(1)}`;
    }
    if (prefix.endsWith("\n") && suffix.startsWith("\n")) {
      return `${prefix}${suffix.slice(1)}`;
    }
    return `${prefix}${suffix}`;
  }

  private async selectLinkCandidate(index: number, textareaEl: HTMLTextAreaElement | null): Promise<void> {
    const match = this.linkCandidates[index];
    if (!match) {
      this.closeLinkSuggest();
      return;
    }

    const draftSnapshot = this.options.getLocalDraft();
    this.closeLinkSuggest();
    await this.options.addWebpageAttachmentFromUrl(match.normalizedUrl, {
      matchedUrl: match,
      draftSnapshot,
      textareaEl
    });
  }

  private closeLinkSuggest(): void {
    if (this.linkOutsidePointerDown) {
      this.options.getContainerDocument().removeEventListener("pointerdown", this.linkOutsidePointerDown, true);
      this.linkOutsidePointerDown = null;
    }
    this.linkSuggestEl?.remove();
    this.linkSuggestEl = null;
    this.linkCandidates = [];
    this.linkSelectedIndex = 0;
  }

  private isTextareaTarget(target: Node): boolean {
    return this.options.getTextareaElements().some((textareaEl) => textareaEl?.contains(target));
  }
}
