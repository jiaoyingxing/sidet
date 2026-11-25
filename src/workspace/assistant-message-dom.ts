/**
 * 单一出口：assistant 消息补丁依赖的 DOM 选择器。
 *
 * 这些类名同时出现在渲染、补丁查询和 styles.css 三处。改标记结构时先改这里，
 * 再改渲染/样式；新增补丁查询优先从渲染结果拿元素引用，不要把类名字符串散回
 * chat-view-assistant-rendering.ts。
 */

const MESSAGE_CONTENT_SELECTOR = ".sidet-message-content";
const INLINE_ACTION_SELECTOR = ".sidet-agent-inline-action, .sidet-wiki-plan-followup";
const ANSWER_SOURCES_SELECTOR = ".sidet-answer-sources";
const ANSWER_VERSIONS_SELECTOR = ".sidet-answer-versions";
const ANSWER_ACTIONS_SELECTOR = ".sidet-answer-actions, .sidet-answer-error";
const STATUS_LINE_SELECTOR = ".sidet-message-status-line";
const META_PANEL_SELECTOR = ".sidet-message-meta-panel";
const META_PANEL_ICON_SELECTOR = ".sidet-message-meta-panel-icon";
const META_PANEL_PREVIEW_SELECTOR = ".sidet-message-meta-panel-preview";
const META_PANEL_BODY_SELECTOR = ".sidet-message-meta-panel-body";
const META_PANEL_LABEL_SELECTOR = ".sidet-message-meta-panel-label";
const MESSAGE_LINK_SELECTOR = "a[href]";

export interface AssistantMetaPanelParts {
  iconEl: Element | null;
  previewEl: Element | null;
  bodyEl: Element | null;
  labelEl: Element | null;
}

export function findAssistantMessageContent(root: ParentNode): Element | null {
  return root.querySelector(MESSAGE_CONTENT_SELECTOR);
}

export function findAssistantInlineActions(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(INLINE_ACTION_SELECTOR));
}

export function findAssistantAnswerSources(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(ANSWER_SOURCES_SELECTOR));
}

export function findAssistantAnswerVersions(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(ANSWER_VERSIONS_SELECTOR));
}

export function findAssistantAnswerActions(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(ANSWER_ACTIONS_SELECTOR));
}

export function findAssistantStatusLines(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(STATUS_LINE_SELECTOR));
}

export function findAssistantMetaPanels(root: ParentNode): Element[] {
  return Array.from(root.querySelectorAll(META_PANEL_SELECTOR));
}

export function findAssistantMetaPanelParts(root: ParentNode): AssistantMetaPanelParts {
  return {
    iconEl: root.querySelector(META_PANEL_ICON_SELECTOR),
    previewEl: root.querySelector(META_PANEL_PREVIEW_SELECTOR),
    bodyEl: root.querySelector(META_PANEL_BODY_SELECTOR),
    labelEl: root.querySelector(META_PANEL_LABEL_SELECTOR)
  };
}

export function findAssistantLinks(root: ParentNode): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>(MESSAGE_LINK_SELECTOR));
}
