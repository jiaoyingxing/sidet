import type { MessageSource } from "../types";
import { splitCitationSegments } from "./chat-view-answer-presentation";
import type { AnswerSourceTarget } from "./chat-view-source-modal";

const CITATION_SKIP_SELECTOR = [
  "a",
  "code",
  "pre",
  "button",
  "textarea",
  "input",
  "script",
  "style",
  ".sidet-citation",
  "mjx-container",
  ".math",
  "[contenteditable='true']"
].join(", ");

/**
 * 把 Markdown 渲染结果里的 [n] 变成可点的来源胶囊。
 *
 * 只处理纯文本节点；链接、代码块、公式和已有按钮一律跳过。未知编号
 * 留在原文里，不伪装成可点来源。
 */
export function decorateCitationMarkers(
  root: HTMLElement,
  sources: readonly MessageSource[],
  onOpenSource: (target: AnswerSourceTarget) => void
): void {
  if (sources.length === 0) {
    return;
  }

  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent || parent.closest(CITATION_SKIP_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }
      return /\[\d{1,3}\]/.test((node as Text).data)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }

  for (const textNode of textNodes) {
    const segments = splitCitationSegments(textNode.data, sources.length);
    if (!segments.some((segment) => segment.type === "citation")) {
      continue;
    }

    const fragment = createFragment();
    for (const segment of segments) {
      if (segment.type === "text") {
        fragment.appendChild(doc.createTextNode(segment.text));
        continue;
      }

      const source = sources[segment.index - 1];
      if (!source) {
        fragment.appendChild(doc.createTextNode(segment.raw));
        continue;
      }

      const sup = createEl("sup");
      const link = sup.createEl("a", {
        cls: "footnote-ref sidet-citation",
        href: `#sidet-source-${segment.index}`,
        text: String(segment.index)
      });
      link.setAttribute("aria-label", `查看来源 ${segment.index}`);
      link.addEventListener("click", (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenSource({
          source,
          index: segment.index
        });
      });
      fragment.appendChild(sup);
    }

    textNode.replaceWith(fragment);
  }
}
