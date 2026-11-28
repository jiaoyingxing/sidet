import { setIcon } from "obsidian";
import type { MessageAttachment, MessageRecord, WebpageMessageAttachment } from "../types";
import { shouldPreserveFocusedTextEntry } from "./press-focus";

interface RenderMessageAttachmentsOptions {
  onOpenWebpageAttachment?: (attachment: WebpageMessageAttachment) => void;
}

interface RenderDraftAttachmentStripOptions {
  onOpenWebpageAttachment?: (attachment: WebpageMessageAttachment) => void;
  leadingChips?: DraftLeadingChip[];
}

export interface DraftLeadingChip {
  label: string;
  icon: string;
  removeLabel: string;
  onRemove: () => void;
  tone?: "default" | "status";
  clickable?: boolean;
  onClick?: (anchorEl: HTMLElement) => void;
}

export interface ComposerChipRenderOptions {
  label: string;
  icon: string;
  className?: string;
  tone?: "default" | "status";
  clickable?: boolean;
  preserveFocus?: boolean;
  ariaLabel?: string;
  onClick?: (anchorEl: HTMLElement) => void;
  remove?: {
    label: string;
    onRemove: () => void;
  };
}

export function renderComposerChip(
  parentEl: HTMLElement,
  options: ComposerChipRenderOptions
): HTMLDivElement {
  const chipEl = parentEl.createDiv({
    cls: [
      "sidet-composer-attachment-chip",
      options.tone === "status" ? "sidet-composer-status-chip" : "",
      options.clickable ? "is-clickable" : "",
      options.className ?? ""
    ].filter(Boolean).join(" ")
  });
  if (options.clickable && options.onClick) {
    chipEl.setAttribute("role", "button");
    chipEl.setAttribute("tabindex", "0");
    chipEl.setAttribute("aria-label", options.ariaLabel ?? options.label);
    if (options.preserveFocus) {
      // 和工具栏图标按钮同一套：输入框有焦点时，点 chip 不让焦点先跳到
      // chip 上。否则移动端会在取消后把焦点留在 chip，出现“还亮着”的
      // focus 态。
      const preserveFocusForPress = (event: Event) => {
        if (shouldPreserveFocusedTextEntry(event)) {
          event.preventDefault();
        }
      };
      chipEl.addEventListener("pointerdown", preserveFocusForPress);
      chipEl.addEventListener("mousedown", preserveFocusForPress);
    }
    chipEl.addEventListener("click", () => {
      options.onClick?.(chipEl);
    });
    chipEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      options.onClick?.(chipEl);
    });
  }

  const iconEl = chipEl.createSpan({ cls: "sidet-composer-attachment-icon" });
  iconEl.setAttribute("aria-hidden", "true");
  setIcon(iconEl, options.icon);
  chipEl.createSpan({
    cls: "sidet-composer-attachment-name",
    text: options.label
  });

  if (options.remove) {
    const removeButtonEl = chipEl.createEl("button", {
      cls: "clickable-icon sidet-composer-attachment-remove"
    });
    removeButtonEl.type = "button";
    removeButtonEl.setAttribute("aria-label", options.remove.label);
    setIcon(removeButtonEl, "x");
    removeButtonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      options.remove?.onRemove();
    });
  }

  return chipEl;
}

export function renderMessageAttachments(
  parentEl: HTMLElement,
  message: MessageRecord,
  options: RenderMessageAttachmentsOptions = {}
): void {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return;
  }

  const attachmentsEl = parentEl.createDiv({ cls: "sidet-message-attachments" });
  for (const attachment of attachments) {
    if (attachment.type === "image") {
      const imageEl = attachmentsEl.createEl("img", {
        cls: "sidet-message-image",
        attr: {
          src: attachment.dataUrl,
          alt: attachment.name
        }
      });
      imageEl.loading = "lazy";
      continue;
    }

    const isClickableWebpage = attachment.type === "webpage" && Boolean(options.onOpenWebpageAttachment);
    const noteEl = attachmentsEl.createDiv({
      cls: `sidet-message-note-attachment${isClickableWebpage ? " is-clickable" : ""}`
    });
    if (isClickableWebpage && attachment.type === "webpage") {
      noteEl.setAttribute("role", "button");
      noteEl.setAttribute("tabindex", "0");
      noteEl.setAttribute("aria-label", `查看网页附件：${attachment.name}`);
      noteEl.addEventListener("click", () => {
        options.onOpenWebpageAttachment?.(attachment);
      });
      noteEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        options.onOpenWebpageAttachment?.(attachment);
      });
    }
    const iconEl = noteEl.createSpan({ cls: "sidet-message-note-attachment-icon" });
    iconEl.setAttribute("aria-hidden", "true");
    setIcon(iconEl, attachment.type === "webpage" ? "globe" : "file-text");
    const textEl = noteEl.createSpan({ cls: "sidet-message-note-attachment-text" });
    textEl.createSpan({ cls: "sidet-message-note-attachment-name", text: attachment.name });
    textEl.createSpan({
      cls: "sidet-message-note-attachment-path",
      text: attachment.type === "webpage" ? attachment.url : attachment.path
    });
  }
}

export function renderDraftAttachmentStrip(
  stripEl: HTMLDivElement | null,
  attachments: MessageAttachment[],
  onRemove: (attachmentId: string) => void,
  options: RenderDraftAttachmentStripOptions = {}
): void {
  if (!stripEl) {
    return;
  }

  stripEl.empty();
  const leadingChips = options.leadingChips ?? [];
  stripEl.classList.toggle("is-empty", attachments.length === 0 && leadingChips.length === 0);
  for (const leadingChip of leadingChips) {
    renderComposerChip(stripEl, {
      label: leadingChip.label,
      icon: leadingChip.icon,
      tone: leadingChip.tone,
      clickable: leadingChip.clickable,
      onClick: leadingChip.onClick,
      remove: {
        label: leadingChip.removeLabel,
        onRemove: leadingChip.onRemove
      }
    });
  }
  for (const attachment of attachments) {
    const isClickableWebpage = attachment.type === "webpage" && Boolean(options.onOpenWebpageAttachment);
    renderComposerChip(stripEl, {
      label: attachment.type !== "image" && attachment.truncated
        ? `${attachment.name}（已截断）`
        : attachment.name,
      icon: attachment.type === "image"
        ? "image"
        : attachment.type === "webpage"
          ? "globe"
          : "file-text",
      clickable: isClickableWebpage,
      ariaLabel: isClickableWebpage ? `预览网页附件：${attachment.name}` : undefined,
      onClick: attachment.type === "webpage"
        ? () => {
            options.onOpenWebpageAttachment?.(attachment);
          }
        : undefined,
      remove: {
        label: `移除附件：${attachment.name}`,
        onRemove: () => {
          onRemove(attachment.id);
        }
      }
    });
  }
}
