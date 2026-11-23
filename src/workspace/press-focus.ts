export function shouldPreserveFocusedTextEntry(event: Event): boolean {
  const doc = resolveEventDocument(event);
  const activeEl = doc?.activeElement;
  if (!isFocusedTextEntry(activeEl)) {
    return false;
  }

  if (event instanceof PointerEvent) {
    return event.pointerType === "mouse" || event.pointerType === "touch" || event.pointerType === "pen";
  }

  return event instanceof MouseEvent;
}

function resolveEventDocument(event: Event): Document | null {
  const target = event.target;
  if (target instanceof Node) {
    return target.ownerDocument;
  }
  return typeof document !== "undefined" ? document : null;
}

function isFocusedTextEntry(element: Element | null | undefined): boolean {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }
  if (element instanceof HTMLInputElement) {
    return true;
  }
  return element instanceof HTMLElement && element.isContentEditable;
}
