interface DragHandlers {
  move: (clientY: number, event: Event) => void;
  commit: (event: Event) => void;
  cancel: (event: Event) => void;
}

interface HomePinnedCommandDragRuntimeOptions {
  canDrag: () => boolean;
  onCommitOrder: (rowsEl: HTMLElement) => Promise<void>;
}

export class HomePinnedCommandDragRuntime {
  constructor(private readonly options: HomePinnedCommandDragRuntimeOptions) {}

  bindHandle(
    handleEl: HTMLElement,
    rowEl: HTMLElement,
    rowsEl: HTMLElement
  ): void {
    let isDragging = false;

    const beginDrag = (
      clientY: number,
      bindMoveListeners: (handlers: DragHandlers) => () => void,
      releaseCapture: () => void = () => undefined
    ): void => {
      if (isDragging || !this.options.canDrag()) {
        return;
      }

      isDragging = true;
      const startY = clientY;
      const rowRect = rowEl.getBoundingClientRect();
      const pointerOffsetY = clientY - rowRect.top;
      const placeholderEl = rowsEl.createDiv({ cls: "sidet-settings-home-command-placeholder" });
      placeholderEl.style.height = `${Math.max(44, rowRect.height)}px`;
      rowEl.insertAdjacentElement("afterend", placeholderEl);

      const previewEl = rowEl.cloneNode(true) as HTMLElement;
      previewEl.addClass("sidet-settings-home-command-drag-preview");
      previewEl.setAttr("aria-hidden", "true");
      previewEl.style.width = `${rowRect.width}px`;
      previewEl.style.left = `${rowRect.left}px`;
      previewEl.style.top = `${rowRect.top}px`;
      document.body.appendChild(previewEl);

      let hasMoved = false;
      rowEl.addClass("is-drag-source");
      rowsEl.addClass("is-dragging");
      document.body.addClass("sidet-settings-home-command-is-dragging");

      const scrollParent = this.getScrollParent(rowsEl);

      const movePreview = (nextClientY: number): void => {
        previewEl.style.transform = `translate3d(0, ${nextClientY - pointerOffsetY - rowRect.top}px, 0)`;
      };

      const movePlaceholder = (nextClientY: number): void => {
        const rows = Array.from(rowsEl.querySelectorAll<HTMLElement>(".sidet-settings-home-command-row:not(.is-drag-source)"));
        let beforeRow: HTMLElement | null = null;
        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          if (nextClientY < rect.top + rect.height / 2) {
            beforeRow = row;
            break;
          }
        }

        rowsEl.insertBefore(placeholderEl, beforeRow);
      };

      let unbindMoveListeners = (): void => undefined;

      const finish = (commit: boolean): void => {
        unbindMoveListeners();
        window.removeEventListener("keydown", handleKeyDown, { capture: true });
        releaseCapture();
        if (commit && hasMoved) {
          rowsEl.insertBefore(rowEl, placeholderEl);
        }
        previewEl.detach();
        placeholderEl.detach();
        rowEl.removeClass("is-drag-source");
        rowsEl.removeClass("is-dragging");
        document.body.removeClass("sidet-settings-home-command-is-dragging");
        isDragging = false;
        if (commit && hasMoved) {
          void this.options.onCommitOrder(rowsEl);
        }
      };

      const handleKeyDown = (keyEvent: KeyboardEvent): void => {
        if (keyEvent.key !== "Escape") {
          return;
        }
        keyEvent.preventDefault();
        finish(false);
      };

      movePreview(clientY);
      unbindMoveListeners = bindMoveListeners({
        move: (nextClientY, moveEvent) => {
          moveEvent.preventDefault();
          if (Math.abs(nextClientY - startY) > 2) {
            hasMoved = true;
          }
          movePreview(nextClientY);
          movePlaceholder(nextClientY);
          this.autoScroll(nextClientY, scrollParent);
        },
        commit: (endEvent) => {
          endEvent.preventDefault();
          finish(true);
        },
        cancel: () => {
          finish(false);
        }
      });
      window.addEventListener("keydown", handleKeyDown, { capture: true });
    };

    handleEl.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "touch") {
        return;
      }
      if (event.pointerType === "mouse" && event.button !== 0) {
        return;
      }
      if (!this.options.canDrag()) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const pointerId = event.pointerId;
      handleEl.setPointerCapture(pointerId);

      beginDrag(
        event.clientY,
        ({ move, commit, cancel }) => {
          const handleMove = (moveEvent: PointerEvent): void => {
            if (moveEvent.pointerId !== pointerId) {
              return;
            }
            move(moveEvent.clientY, moveEvent);
          };

          const handlePointerUp = (upEvent: PointerEvent): void => {
            if (upEvent.pointerId !== pointerId) {
              return;
            }
            commit(upEvent);
          };

          const handlePointerCancel = (cancelEvent: PointerEvent): void => {
            if (cancelEvent.pointerId !== pointerId) {
              return;
            }
            cancel(cancelEvent);
          };

          window.addEventListener("pointermove", handleMove, { capture: true });
          window.addEventListener("pointerup", handlePointerUp, { capture: true });
          window.addEventListener("pointercancel", handlePointerCancel, { capture: true });
          return () => {
            window.removeEventListener("pointermove", handleMove, { capture: true });
            window.removeEventListener("pointerup", handlePointerUp, { capture: true });
            window.removeEventListener("pointercancel", handlePointerCancel, { capture: true });
          };
        },
        () => {
          if (handleEl.hasPointerCapture(pointerId)) {
            handleEl.releasePointerCapture(pointerId);
          }
        }
      );
    });

    handleEl.addEventListener("touchstart", (event) => {
      if (!this.options.canDrag() || event.changedTouches.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const startTouch = event.changedTouches[0];
      const touchId = startTouch.identifier;
      const getTouch = (touches: TouchList): Touch | null => {
        for (let index = 0; index < touches.length; index += 1) {
          const touch = touches.item(index);
          if (touch?.identifier === touchId) {
            return touch;
          }
        }
        return null;
      };

      beginDrag(startTouch.clientY, ({ move, commit, cancel }) => {
        const handleTouchMove = (moveEvent: TouchEvent): void => {
          const touch = getTouch(moveEvent.touches);
          if (!touch) {
            return;
          }
          move(touch.clientY, moveEvent);
        };

        const handleTouchEnd = (endEvent: TouchEvent): void => {
          if (!getTouch(endEvent.changedTouches)) {
            return;
          }
          commit(endEvent);
        };

        const handleTouchCancel = (cancelEvent: TouchEvent): void => {
          if (!getTouch(cancelEvent.changedTouches)) {
            return;
          }
          cancel(cancelEvent);
        };

        window.addEventListener("touchmove", handleTouchMove, { capture: true, passive: false });
        window.addEventListener("touchend", handleTouchEnd, { capture: true });
        window.addEventListener("touchcancel", handleTouchCancel, { capture: true });
        return () => {
          window.removeEventListener("touchmove", handleTouchMove, { capture: true });
          window.removeEventListener("touchend", handleTouchEnd, { capture: true });
          window.removeEventListener("touchcancel", handleTouchCancel, { capture: true });
        };
      });
    }, { passive: false });
  }

  private getScrollParent(rowsEl: HTMLElement): HTMLElement | null {
    let current = rowsEl.parentElement;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      const canScrollY = style.overflowY === "auto" || style.overflowY === "scroll";
      if (canScrollY && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  private autoScroll(clientY: number, scrollParent: HTMLElement | null): void {
    if (!scrollParent) {
      return;
    }

    const rect = scrollParent.getBoundingClientRect();
    const edgeSize = 72;
    const maxStep = 18;
    if (clientY < rect.top + edgeSize) {
      const ratio = (rect.top + edgeSize - clientY) / edgeSize;
      scrollParent.scrollTop -= Math.ceil(maxStep * Math.min(1, ratio));
      return;
    }
    if (clientY > rect.bottom - edgeSize) {
      const ratio = (clientY - (rect.bottom - edgeSize)) / edgeSize;
      scrollParent.scrollTop += Math.ceil(maxStep * Math.min(1, ratio));
    }
  }
}
