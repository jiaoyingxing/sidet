import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-mobile-composer-layer-"));

async function loadMobileComposerLayerModule() {
  const outfile = path.join(tempDir, "mobile-composer-layer.mjs");
  await build({
    entryPoints: [path.join(rootDir, "src", "workspace", "chat-view-mobile-composer-layer.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function loadMobileWorkspaceOwnershipModule() {
  const outfile = path.join(tempDir, "mobile-workspace-ownership.mjs");
  await build({
    entryPoints: [
      path.join(
        rootDir,
        "src",
        "workspace",
        "chat-view-mobile-workspace-ownership.ts"
      )
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function loadMobileComposerModule() {
  const outfile = path.join(tempDir, "mobile-composer.mjs");
  await build({
    entryPoints: [
      path.join(rootDir, "src", "workspace", "chat-view-mobile-composer.ts")
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

function createClassList(initial = []) {
  const names = new Set(initial);
  return {
    add(...values) {
      for (const value of values) {
        names.add(value);
      }
    },
    remove(...values) {
      for (const value of values) {
        names.delete(value);
      }
    },
    contains(value) {
      return names.has(value);
    },
    toggle(value, force) {
      const next = force ?? !names.has(value);
      if (next) {
        names.add(value);
      } else {
        names.delete(value);
      }
      return next;
    }
  };
}

function createStyle() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    removeProperty(name) {
      values.delete(name);
    },
    getPropertyValue(name) {
      return values.get(name) ?? "";
    }
  };
}

function createElement(tagName, classNames = []) {
  const element = {
    tagName: tagName.toUpperCase(),
    classList: createClassList(classNames),
    className: classNames.join(" "),
    style: createStyle(),
    parentNode: null,
    childNodes: [],
    isConnected: true,
    capturedPointers: [],
    failPointerCapture: false,
    setPointerCapture(pointerId) {
      if (this.failPointerCapture) {
        throw new Error("stub pointer capture rejected");
      }
      this.capturedPointers.push(pointerId);
    },
    releasePointerCapture(pointerId) {
      this.capturedPointers = this.capturedPointers.filter(
        (candidate) => candidate !== pointerId
      );
    },
    hasPointerCapture(pointerId) {
      return this.capturedPointers.includes(pointerId);
    },
    appendChild(child) {
      child.parentNode?.removeChild(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, reference) {
      child.parentNode?.removeChild(child);
      const index = this.childNodes.indexOf(reference);
      if (index < 0) {
        return this.appendChild(child);
      }
      this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) {
        this.childNodes.splice(index, 1);
        child.parentNode = null;
      }
      return child;
    },
    remove() {
      this.parentNode?.removeChild(this);
      this.isConnected = false;
    }
  };
  Object.defineProperty(element, "nextSibling", {
    get() {
      if (!this.parentNode) {
        return null;
      }
      const index = this.parentNode.childNodes.indexOf(this);
      return this.parentNode.childNodes[index + 1] ?? null;
    }
  });
  return element;
}

function installEnvironment() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalIntersectionObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "IntersectionObserver"
  );
  const frameQueue = [];
  const observers = [];
  let nextFrameId = 1;
  let createdTextareaCount = 0;

  const body = createElement("body");
  const ownerDocument = {
    body,
    activeElement: null,
    createElement(tagName) {
      if (tagName.toLowerCase() === "textarea") {
        createdTextareaCount += 1;
      }
      const element = createElement(tagName);
      element.ownerDocument = ownerDocument;
      return element;
    }
  };
  body.ownerDocument = ownerDocument;

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      innerWidth: 390,
      requestAnimationFrame(callback) {
        const id = nextFrameId;
        nextFrameId += 1;
        frameQueue.push({ id, callback });
        return id;
      },
      cancelAnimationFrame(id) {
        const index = frameQueue.findIndex((entry) => entry.id === id);
        if (index >= 0) {
          frameQueue.splice(index, 1);
        }
      },
      setTimeout(callback) {
        callback();
        return 1;
      },
      clearTimeout() {}
    }
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: ownerDocument
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    configurable: true,
    value: class FakeIntersectionObserver {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = new Set();
        this.disconnected = false;
        observers.push(this);
      }

      observe(target) {
        this.targets.add(target);
      }

      disconnect() {
        this.disconnected = true;
        this.targets.clear();
      }

      trigger(target, boundingClientRect) {
        if (this.disconnected || !this.targets.has(target)) {
          return;
        }
        this.callback([
          {
            target,
            boundingClientRect
          }
        ]);
      }
    }
  });

  return {
    ownerDocument,
    body,
    observers,
    flushFrames() {
      while (frameQueue.length > 0) {
        frameQueue.shift().callback();
      }
    },
    getCreatedTextareaCount() {
      return createdTextareaCount;
    },
    restore() {
      if (originalWindow) {
        Object.defineProperty(globalThis, "window", originalWindow);
      } else {
        delete globalThis.window;
      }
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", originalDocument);
      } else {
        delete globalThis.document;
      }
      if (originalIntersectionObserver) {
        Object.defineProperty(
          globalThis,
          "IntersectionObserver",
          originalIntersectionObserver
        );
      } else {
        delete globalThis.IntersectionObserver;
      }
    }
  };
}

function assertSameComposerMovesIntoStableBodyLayer(module) {
  const environment = installEnvironment();
  try {
    const contentEl = createElement("div", [
      "sidet-chat-view",
      "is-phone-layout",
      "is-mobile-runtime",
      "is-ios-runtime"
    ]);
    contentEl.ownerDocument = environment.ownerDocument;
    contentEl.scrollTop = 420;

    const rootEl = createElement("div", ["sidet-chat-root"]);
    const composerWrapEl = createElement("div", ["sidet-composer-wrap"]);
    const sentinelEl = createElement("div", ["sentinel"]);
    const textareaEl = createElement("textarea", ["sidet-textarea"]);
    textareaEl.value = "same draft";
    textareaEl.focusCalls = 0;
    textareaEl.selection = null;
    const focusLifecycleOrder = [];
    textareaEl.focus = () => {
      textareaEl.focusCalls += 1;
      focusLifecycleOrder.push("focus");
      environment.ownerDocument.activeElement = textareaEl;
    };
    textareaEl.blur = () => {
      environment.ownerDocument.activeElement = null;
    };
    textareaEl.setSelectionRange = (start, end) => {
      textareaEl.selection = [start, end];
    };
    composerWrapEl.appendChild(textareaEl);
    rootEl.appendChild(composerWrapEl);
    rootEl.appendChild(sentinelEl);
    contentEl.appendChild(rootEl);

    let layerChanges = 0;
    const layerOwnershipAtChange = [];
    const runtime = new module.ChatViewMobileComposerLayerRuntime({
      getContentEl: () => contentEl,
      getRootEl: () => rootEl,
      getComposerWrapEl: () => composerWrapEl,
      getComposerTextareaEl: () => textareaEl,
      focusComposerTextarea: (target) => target?.focus({ preventScroll: true }),
      syncComposerLayout: () => {},
      syncComposerButtons: () => {},
      scheduleViewportSync: () => {},
      updatePinnedToBottom: () => {},
      syncScrollBottomButtonVisibility: () => {},
      onLayerChange: () => {
        layerChanges += 1;
        focusLifecycleOrder.push("layer-change");
        layerOwnershipAtChange.push(
          composerWrapEl.parentNode === rootEl ? "home" : "layer"
        );
      },
      isPhoneLayout: () => true,
      isMobileRuntime: () => true
    });

    assert.equal(runtime.isActive(), false);
    assert.equal(
      runtime.prepareForFocus(),
      true,
      "the native textarea pointer hook must only prepare the existing body layer"
    );
    assert.equal(
      runtime.isActive(),
      true,
      "layer preparation must establish ownership before the browser performs native focus"
    );
    assert.equal(
      composerWrapEl.parentNode,
      runtime.getLayerEl(),
      "the existing composer wrapper must move into the stable body layer"
    );
    assert.equal(
      environment.getCreatedTextareaCount(),
      0,
      "opening the mobile layer must not create a second textarea"
    );
    assert.equal(textareaEl.value, "same draft", "moving the node must preserve the live draft");
    assert.equal(contentEl.scrollTop, 420, "opening the layer must preserve the reading position");
    assert.equal(runtime.getLayerEl().parentNode, environment.body);
    assert.equal(
      runtime.getLayerEl().style.getPropertyValue("--sidet-mobile-resting-composer-bottom"),
      "",
      "the stable host must use the shared CSS baseline instead of a copied inline offset"
    );
    assert.deepEqual(
      focusLifecycleOrder,
      ["layer-change"],
      "layer preparation must not synthesize focus, selection, or a click lifecycle"
    );
    assert.equal(textareaEl.focusCalls, 0);
    assert.equal(textareaEl.selection, null);

    textareaEl.focus();
    assert.equal(textareaEl.focusCalls, 1);
    assert.equal(
      environment.ownerDocument.activeElement,
      textareaEl,
      "the browser-native textarea focus remains the only direct touch activation"
    );
    assert.equal(contentEl.scrollTop, 420);

    runtime.close({ blur: true });
    assert.equal(runtime.isActive(), false);
    assert.equal(composerWrapEl.parentNode, rootEl, "closing must restore the original composer parent");
    assert.equal(
      rootEl.childNodes[1],
      sentinelEl,
      "closing must restore the composer before its original next sibling"
    );
    assert.equal(environment.getCreatedTextareaCount(), 0);
    assert.equal(layerChanges, 2, "opening and closing must each notify keyboard ownership once");
    assert.deepEqual(
      layerOwnershipAtChange.slice(0, 2),
      ["layer", "home"],
      "the close notification must run only after the composer has returned to its home parent"
    );

    assert.equal(runtime.prepareForFocus(), true);
    assert.equal(
      textareaEl.focusCalls,
      1,
      "programmatic layer preparation must leave focus ownership with its caller"
    );

    rootEl.appendChild(composerWrapEl);
    assert.equal(
      runtime.isActive(),
      false,
      "layer activity must reflect the real composer ownership instead of a stale flag"
    );
    assert.equal(
      runtime.prepareForFocus(),
      true,
      "a host-restored focus must repair stale composer ownership before keyboard management starts"
    );
    assert.equal(
      composerWrapEl.parentNode,
      runtime.getLayerEl(),
      "repairing stale ownership must move the same composer back into the stable layer"
    );
    assert.equal(
      textareaEl.focusCalls,
      1,
      "ownership repair must not blur or refocus the textarea"
    );
    assert.equal(
      environment.getCreatedTextareaCount(),
      0,
      "ownership repair must not create a second textarea"
    );

    runtime.close({ blur: false });
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertComposerUsesNativeTextareaActivation() {
  const chatViewSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view.ts"),
    "utf8"
  );
  const mobileComposerSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-composer.ts"),
    "utf8"
  );
  const layerSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-composer-layer.ts"),
    "utf8"
  );
  const css = readFileSync(path.join(rootDir, "styles.css"), "utf8");
  const nativePointerStart = chatViewSource.indexOf(
    'this.textareaEl.addEventListener("pointerdown"'
  );
  const nativePointerEnd = chatViewSource.indexOf(
    'this.textareaEl.addEventListener("blur"',
    nativePointerStart
  );
  const nativePointerSource = chatViewSource.slice(nativePointerStart, nativePointerEnd);
  const nativeActivationStart = mobileComposerSource.indexOf(
    "beginComposerActivationFromNativePointer"
  );
  const nativeActivationEnd = mobileComposerSource.indexOf(
    "completeComposerActivationPointer",
    nativeActivationStart
  );
  const nativeActivationSource = mobileComposerSource.slice(
    nativeActivationStart,
    nativeActivationEnd
  );

  assert.match(
    nativePointerSource,
    /this\.textareaEl\.addEventListener\("pointerdown", \(event\) => \{[\s\S]*const activationOwned\s*=\s*this\.mobileComposer\.beginComposerActivationFromNativePointer\(\s*event\.pointerId\s*\);[\s\S]*if \(!activationOwned\) \{[\s\S]*return;[\s\S]*event\.preventDefault\(\);[\s\S]*\}\);/,
    "the real textarea must suppress early native focus only after the mobile pointer owner accepts this activation"
  );
  assert.match(
    nativePointerSource,
    /recordMobileHomeInputLifecycle\("native\.pointerdown\.before"\)[\s\S]*beginComposerActivationFromNativePointer\([\s\S]*recordMobileHomeInputLifecycle\(\s*"native\.pointerdown\.default-prevented"\s*\)[\s\S]*recordMobileHomeInputLifecycle\("native\.pointerdown\.after"\)/,
    "the privacy-bounded probe must expose accepted pointer ownership before browser default focus is suppressed"
  );
  assert.doesNotMatch(
    nativeActivationSource,
    /layerRuntime\.prepareForFocus\(\)/,
    "pointerdown must keep the real textarea mounted through the physical press"
  );
  assert.match(
    nativePointerSource,
    /this\.textareaEl\.addEventListener\("pointerup", \(event\) => \{[\s\S]*recordMobileHomeInputLifecycle\("native\.pointerup\.before"\)[\s\S]*completeComposerActivationPointer\(event\.pointerId\)[\s\S]*recordMobileHomeInputLifecycle\("native\.pointerup\.after"\)[\s\S]*this\.textareaEl\.addEventListener\("pointercancel", \(event\) => \{[\s\S]*cancelComposerActivationPointer\(event\.pointerId\)/,
    "the same real textarea pointerup must complete or cancel its own activation"
  );
  assert.doesNotMatch(
    chatViewSource,
    /window\.addEventListener\(\s*"(?:pointerup|pointercancel)"|confirmComposerActivationFromNativeClick/,
    "direct textarea activation must not depend on a window bridge or compatibility click"
  );
  const chatViewWindowClickListeners = chatViewSource.match(
    /window\.addEventListener\(\s*"click",\s*recordNativeTailEvent/g
  ) ?? [];
  assert.equal(
    chatViewWindowClickListeners.length,
    1,
    "the only window click listener must be the single read-only delayed-blur tail probe"
  );
  const tailProbeStart = chatViewSource.indexOf("const recordNativeTailEvent");
  const tailProbeEnd = chatViewSource.indexOf(
    'window.addEventListener("click", recordNativeTailEvent, true)',
    tailProbeStart
  );
  const tailProbeSource = chatViewSource.slice(tailProbeStart, tailProbeEnd);
  assert.doesNotMatch(
    tailProbeSource,
    /preventDefault|stopPropagation|stopImmediatePropagation/,
    "the tail probe must observe compatibility events without ever blocking them"
  );
  assert.match(
    tailProbeSource,
    /recordMobileHomeInputLifecycle\(\s*event\.type === "contextmenu"\s*\?\s*"native\.tail\.contextmenu"\s*:\s*"native\.tail\.click"/,
    "the tail probe must record through the bounded lifecycle report"
  );
  assert.match(
    mobileComposerSource,
    /completeComposerActivationPointer\(pointerId: number\)[\s\S]*native\.pointerup\.accepted[\s\S]*layerRuntime\.activateForFocus\(\)[\s\S]*native\.pointerup\.focused/,
    "pointerup must reuse the proven atomic layer-and-focus path"
  );
  assert.match(
    layerSource,
    /activateForFocus\(\): boolean \{[\s\S]*const anchorScrollTop = contentEl\.scrollTop;[\s\S]*this\.prepareForFocus\(\)[\s\S]*focusComposerTextarea\(textareaEl\)[\s\S]*contentEl\.scrollTop = anchorScrollTop;/,
    "direct activation must restore the reading anchor after focus, matching the 90-point mobile baseline"
  );
  assert.doesNotMatch(
    mobileComposerSource,
    /native-click-missing|native\.click\.accepted|native\.click\.focused|nativeActivationCompletionFrame/,
    "the retired compatibility-click wait must not remain as a second activation path"
  );
  assert.match(
    mobileComposerSource,
    /native\.focus\.clears-pending[\s\S]*native\.blur\.clears-pending[\s\S]*native\.activation\.abort\.\$\{reason\}/,
    "the probe must expose whether native focus clears the pending click handshake"
  );
  assert.doesNotMatch(
    chatViewSource,
    /this\.composerInputShellEl\.addEventListener\("(?:pointerdown|pointermove|pointerup|pointercancel|click|contextmenu)"/,
    "the visual shell must not remain a parallel touch trigger"
  );
  assert.doesNotMatch(
    nativePointerSource,
    /setPointerCapture|stopPropagation\(\)/,
    "the chat-view pointer listeners must stay free of capture and propagation blocking; the user-authorized self-capture lives in the activation owner"
  );
  assert.match(
    mobileComposerSource,
    /beginComposerActivationFromNativePointer\(pointerId: number\): boolean \{[\s\S]*setPointerCapture\(pointerId\)[\s\S]*native\.activation\.pointer-captured[\s\S]*native\.activation\.pending/,
    "the activation owner must capture the textarea's own pointer inside its own gesture, and nowhere else"
  );
  assert.doesNotMatch(
    mobileComposerSource,
    /releasePointerCapture/,
    "self-capture must release implicitly with the gesture instead of adding teardown state"
  );
  assert.equal(
    nativePointerSource.match(/preventDefault\(\)/g)?.length,
    1,
    "the real textarea may suppress only the accepted activation's early default focus"
  );
  assert.match(
    mobileComposerSource,
    /if \(isFocused\) \{\s*if \(!this\.layerRuntime\.isActive\(\)\) \{[\s\S]*this\.mainComposer\.textareaEl\?\.blur\(\);[\s\S]*return;[\s\S]*this\.keyboardFollowRuntime\.beginFocus\(\);/,
    "a host-restored focus without explicit layer ownership must be rejected instead of starting keyboard follow"
  );
  assert.doesNotMatch(
    layerSource,
    /PointerIntent|handlePointer|handleClick|handleContextMenu|MOBILE_COMPOSER_TAP_MAX/,
    "the retired custom tap state machine must not remain in the layer runtime"
  );
  assert.doesNotMatch(
    css,
    /\.sidet-chat-view\.is-phone-layout\.is-mobile-runtime \.sidet-composer-input-shell::before/,
    "the input shell must not retain an invisible expanded hit band"
  );
}

function assertNativePointerUpCompletesWithoutCompatibilityClick(module) {
  const environment = installEnvironment();
  try {
    const contentEl = createElement("div", [
      "sidet-chat-view",
      "is-phone-layout",
      "is-mobile-runtime",
      "is-ios-runtime"
    ]);
    contentEl.ownerDocument = environment.ownerDocument;
    contentEl.scrollTop = 275;
    contentEl.scrollHeight = 800;
    contentEl.clientHeight = 800;
    const rootEl = createElement("div", ["sidet-chat-root"]);
    rootEl.getBoundingClientRect = () => ({
      top: 0,
      right: 378,
      bottom: 800,
      left: 12,
      width: 366,
      height: 800
    });
    const composerWrapEl = createElement("div", ["sidet-composer-wrap"]);
    const textareaEl = createElement("textarea", ["sidet-textarea"]);
    textareaEl.value = "";
    textareaEl.readOnly = false;
    textareaEl.focusCalls = 0;
    textareaEl.focus = () => {
      textareaEl.focusCalls += 1;
      environment.ownerDocument.activeElement = textareaEl;
      contentEl.scrollTop = 18;
    };
    textareaEl.blur = () => {
      environment.ownerDocument.activeElement = null;
    };
    composerWrapEl.appendChild(textareaEl);
    rootEl.appendChild(composerWrapEl);
    contentEl.appendChild(rootEl);

    const layerChanges = [];
    const nativeActivationEvents = [];
    const runtime = new module.ChatViewMobileComposer({
      desktopBottomMessageGap: 24,
      getContentEl: () => contentEl,
      getRootEl: () => rootEl,
      getMessagesBottomSpacerEl: () => null,
      getScrollHost: () => contentEl,
      setScrollHostTop: () => {},
      updatePinnedToBottom: () => {},
      syncScrollBottomButtonVisibility: () => {},
      syncScrollAffordances: () => {},
      positionFloatingControls: () => {},
      syncLayoutClasses: () => {},
      getDraftText: () => "",
      getComposerPlaceholder: () => "输入消息",
      focusComposerTextarea: (target) => target?.focus({ preventScroll: true }),
      syncComposerButtons: () => {},
      isComposerReadOnly: () => false,
      isPhoneLayout: () => true,
      isMobileRuntime: () => true,
      getPendingScrollIntent: () => "none",
      hasComposerResizeObserver: () => true,
      isHomeState: () => true,
      onComposerLayerChange: (active) => {
        layerChanges.push(active);
      },
      onNativeActivationEvent: (event) => {
        nativeActivationEvents.push(event);
      }
    });
    runtime.attachMainComposerElements({
      composerWrapEl,
      composerEl: null,
      attachmentStripEl: null,
      inputShellEl: null,
      textareaEl,
      textareaMirrorEl: null,
      expandButtonEl: null
    });

    assert.equal(
      runtime.beginComposerActivationFromNativePointer(7),
      true,
      "an unfocused editable mobile textarea must accept one pointer activation"
    );
    assert.deepEqual(
      textareaEl.capturedPointers,
      [7],
      "the owned activation must capture the textarea's own pointer so the compatibility mousedown and click retarget back to it after the reparent"
    );
    assert.ok(
      nativeActivationEvents.includes("native.activation.pointer-captured"),
      "the probe must expose whether the activation self-capture succeeded"
    );
    assert.equal(
      runtime.isComposerLayerActive(),
      false,
      "pointerdown must not move the real textarea before pointerup"
    );
    assert.equal(
      composerWrapEl.parentNode,
      rootEl,
      "the real textarea target must stay in its original tree through pointer completion"
    );
    assert.equal(
      textareaEl.focusCalls,
      0,
      "pointerdown must not focus before the physical press completes"
    );
    assert.equal(
      nativeActivationEvents.at(-1),
      "native.activation.pending",
      "the probe must expose the pending native activation"
    );
    environment.flushFrames();
    assert.equal(
      runtime.isComposerLayerActive(),
      false,
      "a normal press may span multiple frames without moving the textarea"
    );
    runtime.completeComposerActivationPointer(7);
    assert.equal(
      textareaEl.focusCalls,
      1,
      "pointerup must focus without waiting for a compatibility click"
    );
    assert.equal(
      contentEl.scrollTop,
      275,
      "pointerup must restore the pre-focus reading anchor after iOS focus scrolls the host"
    );
    assert.equal(environment.ownerDocument.activeElement, textareaEl);
    assert.deepEqual(
      nativeActivationEvents.slice(-2),
      ["native.pointerup.accepted", "native.pointerup.focused"],
      "the probe must expose a successful pointerup focus"
    );
    environment.flushFrames();
    assert.equal(
      runtime.isComposerLayerActive(),
      true,
      "a pointerup-confirmed focus must keep the prepared body layer"
    );
    assert.equal(
      composerWrapEl.parentNode?.parentNode,
      environment.body,
      "a pointerup-confirmed focus must keep the same composer inside the body layer"
    );

    // The delayed-blur evidence gate: an ownership-loss trigger must be
    // observable through the same bounded activation probe before the layer
    // hands the composer back.
    const driftRootRect = {
      top: 0,
      right: 706,
      bottom: 800,
      left: 340,
      width: 366,
      height: 800
    };
    rootEl.getBoundingClientRect = () => ({ ...driftRootRect });
    runtime.requestWorkspaceOwnershipCheck("layout-change");
    environment.flushFrames();
    assert.ok(
      nativeActivationEvents.includes("ownership.loss.layout-change"),
      "the workspace ownership-loss trigger must be visible to the bounded probe"
    );
    assert.equal(
      runtime.isComposerLayerActive(),
      false,
      "a real workspace drift must end the active layer through the shared interruption path"
    );
    assert.equal(
      composerWrapEl.parentNode,
      rootEl,
      "the drift interruption must restore the same composer to its chat root"
    );
    assert.equal(
      environment.ownerDocument.activeElement,
      null,
      "the drift interruption must blur the real textarea exactly once"
    );

    environment.ownerDocument.activeElement = null;
    runtime.closeMobileComposerLayer({ blur: false });
    environment.ownerDocument.activeElement = textareaEl;
    assert.equal(
      runtime.beginComposerActivationFromNativePointer(8),
      false,
      "an already focused textarea must keep native caret and selection behavior"
    );
    environment.ownerDocument.activeElement = null;
    assert.equal(
      runtime.beginComposerActivationFromNativePointer(8),
      true,
      "a later unfocused press must be able to acquire activation ownership again"
    );
    runtime.cancelComposerActivationPointer(8);

    assert.equal(
      runtime.beginComposerActivationFromNativePointer(9),
      true
    );
    runtime.cancelComposerActivationPointer(9);
    assert.equal(
      runtime.isComposerLayerActive(),
      false,
      "pointercancel must leave the resting composer untouched"
    );

    const successfulFocus = textareaEl.focus;
    textareaEl.focus = () => {};
    assert.equal(
      runtime.beginComposerActivationFromNativePointer(10),
      true
    );
    runtime.completeComposerActivationPointer(10);
    assert.equal(
      runtime.isComposerLayerActive(),
      false,
      "a pointerup whose focus request fails must not leave a half-active layer"
    );
    textareaEl.focus = successfulFocus;

    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertDrawerOwnershipDriftRestoresOriginalComposerParent(
  layerModule,
  workspaceOwnershipModule
) {
  const environment = installEnvironment();
  try {
    const contentEl = createElement("div", [
      "sidet-chat-view",
      "is-phone-layout",
      "is-mobile-runtime"
    ]);
    contentEl.ownerDocument = environment.ownerDocument;
    contentEl.scrollTop = 0;
    const rootEl = createElement("div", ["sidet-chat-root"]);
    const composerWrapEl = createElement("div", ["sidet-composer-wrap"]);
    const textareaEl = createElement("textarea", ["sidet-textarea"]);
    let rootRect = {
      top: 0,
      right: 378,
      bottom: 800,
      left: 12,
      width: 366,
      height: 800
    };
    rootEl.getBoundingClientRect = () => ({ ...rootRect });
    textareaEl.blur = () => {
      environment.ownerDocument.activeElement = null;
    };
    composerWrapEl.appendChild(textareaEl);
    rootEl.appendChild(composerWrapEl);
    contentEl.appendChild(rootEl);

    const layerRuntime =
      new layerModule.ChatViewMobileComposerLayerRuntime({
        getContentEl: () => contentEl,
        getRootEl: () => rootEl,
        getComposerWrapEl: () => composerWrapEl,
        getComposerTextareaEl: () => textareaEl,
        focusComposerTextarea: () => {},
        syncComposerLayout: () => {},
        syncComposerButtons: () => {},
        scheduleViewportSync: () => {},
        updatePinnedToBottom: () => {},
        syncScrollBottomButtonVisibility: () => {},
        onLayerChange: () => {},
        isPhoneLayout: () => true,
        isMobileRuntime: () => true
      });
    const interrupts = [];
    const ownershipGuard =
      new workspaceOwnershipModule.ChatViewMobileWorkspaceOwnershipGuard({
        getRootEl: () => rootEl,
        getViewportWidth: () => window.innerWidth,
        isLayerActive: () => layerRuntime.isActive(),
        onOwnershipLoss: (trigger) => {
          interrupts.push(trigger);
          layerRuntime.close({ blur: true });
        }
      });

    const openAndObserve = () => {
      assert.equal(layerRuntime.prepareForFocus(), true);
      assert.equal(composerWrapEl.parentNode, layerRuntime.getLayerEl());
      ownershipGuard.start();
      const observer = environment.observers.at(-1);
      assert.ok(observer, "an active body layer must observe its own chat root");
      observer.trigger(rootEl, rootRect);
      return observer;
    };

    let observer = openAndObserve();
    assert.equal(interrupts.length, 0, "the stable home geometry must keep focus");
    rootRect = {
      ...rootRect,
      left: 340,
      right: 706
    };
    observer.trigger(rootEl, rootRect);
    assert.equal(
      composerWrapEl.parentNode,
      rootEl,
      "a left drawer workspace shift must restore the same composer to its original root"
    );
    assert.equal(layerRuntime.isActive(), false);

    rootRect = {
      ...rootRect,
      left: 12,
      right: 378
    };
    observer = openAndObserve();
    rootRect = {
      ...rootRect,
      left: -316,
      right: 50
    };
    observer.trigger(rootEl, rootRect);
    assert.equal(
      composerWrapEl.parentNode,
      rootEl,
      "a right drawer workspace shift must share the same original-parent terminal state"
    );
    assert.equal(layerRuntime.isActive(), false);
    assert.deepEqual(
      interrupts,
      ["intersection", "intersection"],
      "left and right drawers must use one ownership-loss path"
    );

    ownershipGuard.stop();
    layerRuntime.release();
  } finally {
    environment.restore();
  }
}

function assertActivationSurvivesPointerCaptureFailure(mobileComposerModule) {
  const environment = installEnvironment();
  try {
    const contentEl = createElement("div", [
      "sidet-chat-view",
      "is-phone-layout",
      "is-mobile-runtime"
    ]);
    contentEl.ownerDocument = environment.ownerDocument;
    contentEl.scrollTop = 275;
    contentEl.scrollHeight = 800;
    contentEl.clientHeight = 800;
    const rootEl = createElement("div", ["sidet-chat-root"]);
    rootEl.getBoundingClientRect = () => ({
      top: 0,
      right: 378,
      bottom: 800,
      left: 12,
      width: 366,
      height: 800
    });
    const composerWrapEl = createElement("div", ["sidet-composer-wrap"]);
    const textareaEl = createElement("textarea", ["sidet-textarea"]);
    textareaEl.value = "";
    textareaEl.readOnly = false;
    textareaEl.focus = () => {
      environment.ownerDocument.activeElement = textareaEl;
      contentEl.scrollTop = 18;
    };
    textareaEl.blur = () => {
      environment.ownerDocument.activeElement = null;
    };
    composerWrapEl.appendChild(textareaEl);
    rootEl.appendChild(composerWrapEl);
    contentEl.appendChild(rootEl);

    const nativeActivationEvents = [];
    const runtime = new mobileComposerModule.ChatViewMobileComposer({
      desktopBottomMessageGap: 24,
      getContentEl: () => contentEl,
      getRootEl: () => rootEl,
      getMessagesBottomSpacerEl: () => null,
      getScrollHost: () => contentEl,
      setScrollHostTop: () => {},
      updatePinnedToBottom: () => {},
      syncScrollBottomButtonVisibility: () => {},
      syncScrollAffordances: () => {},
      positionFloatingControls: () => {},
      syncLayoutClasses: () => {},
      getDraftText: () => "",
      getComposerPlaceholder: () => "输入消息",
      focusComposerTextarea: (target) => target?.focus({ preventScroll: true }),
      syncComposerButtons: () => {},
      isComposerReadOnly: () => false,
      isPhoneLayout: () => true,
      isMobileRuntime: () => true,
      getPendingScrollIntent: () => "none",
      hasComposerResizeObserver: () => true,
      isHomeState: () => true,
      onComposerLayerChange: () => {},
      onNativeActivationEvent: (event) => {
        nativeActivationEvents.push(event);
      }
    });
    runtime.attachMainComposerElements({
      composerWrapEl,
      composerEl: null,
      attachmentStripEl: null,
      inputShellEl: null,
      textareaEl,
      textareaMirrorEl: null,
      expandButtonEl: null
    });

    textareaEl.failPointerCapture = true;
    assert.equal(
      runtime.beginComposerActivationFromNativePointer(11),
      true,
      "a failed self-capture must not abort the owned activation"
    );
    assert.deepEqual(
      textareaEl.capturedPointers,
      [],
      "a rejected capture must not pretend the pointer was captured"
    );
    assert.deepEqual(
      nativeActivationEvents.slice(-2),
      ["native.activation.capture-failed", "native.activation.pending"],
      "the probe must expose the capture failure while keeping the pending activation terminal"
    );
    runtime.completeComposerActivationPointer(11);
    assert.equal(
      environment.ownerDocument.activeElement,
      textareaEl,
      "the activation must still focus through to the textarea without capture"
    );
    assert.ok(
      nativeActivationEvents.includes("native.pointerup.focused"),
      "pointerup must complete its atomic activation even when capture failed"
    );
  } finally {
    environment.restore();
  }
}

async function main() {
  try {
    const layerModule = await loadMobileComposerLayerModule();
    const workspaceOwnershipModule =
      await loadMobileWorkspaceOwnershipModule();
    const mobileComposerModule = await loadMobileComposerModule();
    assertSameComposerMovesIntoStableBodyLayer(layerModule);
    assertComposerUsesNativeTextareaActivation();
    assertNativePointerUpCompletesWithoutCompatibilityClick(
      mobileComposerModule
    );
    assertActivationSurvivesPointerCaptureFailure(mobileComposerModule);
    assertDrawerOwnershipDriftRestoresOriginalComposerParent(
      layerModule,
      workspaceOwnershipModule
    );
    console.log("mobile composer layer logic test passed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
