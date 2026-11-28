import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-mobile-keyboard-follow-"));

async function loadKeyboardFollowModule() {
  const outfile = path.join(tempDir, "mobile-keyboard-follow.mjs");
  await build({
    entryPoints: [
      path.join(rootDir, "src", "workspace", "chat-view-mobile-keyboard-follow.ts")
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function loadKeyboardDiagnosticsModule() {
  const outfile = path.join(tempDir, "mobile-keyboard-phase-diagnostics.mjs");
  await build({
    entryPoints: [
      path.join(
        rootDir,
        "src",
        "workspace",
        "chat-view-mobile-keyboard-phase-diagnostics.ts"
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

async function loadMobileHomeLifecycleDiagnosticsModule() {
  const outfile = path.join(tempDir, "mobile-home-lifecycle-diagnostics.mjs");
  await build({
    entryPoints: [
      path.join(
        rootDir,
        "src",
        "workspace",
        "chat-view-mobile-home-lifecycle-diagnostics.ts"
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
  const style = {
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
  Object.defineProperty(style, "transform", {
    configurable: true,
    get() {
      return values.get("transform") ?? "";
    },
    set(value) {
      values.set("transform", String(value));
    }
  });
  return style;
}

function createElement(classNames, rect) {
  return {
    tagName: "DIV",
    className: classNames.join(" "),
    classList: createClassList(classNames),
    style: createStyle(),
    parentNode: null,
    parentElement: null,
    isConnected: true,
    getBoundingClientRect() {
      return { ...rect };
    },
    getAttribute() {
      return null;
    }
  };
}

function installRuntimeEnvironment() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalPerformance = Object.getOwnPropertyDescriptor(
    globalThis,
    "performance"
  );
  const originalGetComputedStyle = Object.getOwnPropertyDescriptor(
    globalThis,
    "getComputedStyle"
  );
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const visualViewportTarget = new EventTarget();
  const timers = new Map();
  const frames = new Map();
  let nextTimerId = 1;
  let nextFrameId = 1;
  let clockMs = 0;

  Object.assign(windowTarget, {
    innerWidth: 390,
    innerHeight: 800,
    setTimeout(callback, delay = 0) {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame(callback) {
      const id = nextFrameId;
      nextFrameId += 1;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    getComputedStyle() {
      return { paddingBottom: "34px" };
    },
    visualViewport: visualViewportTarget
  });
  Object.assign(visualViewportTarget, {
    width: 390,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
    pageLeft: 0,
    pageTop: 0,
    scale: 1
  });
  Object.assign(documentTarget, {
    hidden: false,
    activeElement: null,
    documentElement: {
      clientWidth: 390,
      clientHeight: 800,
      getBoundingClientRect() {
        return {
          top: 0,
          right: 390,
          bottom: 800,
          left: 0,
          width: 390,
          height: 800
        };
      }
    },
    body: {
      getBoundingClientRect() {
        return {
          top: 0,
          right: 390,
          bottom: 800,
          left: 0,
          width: 390,
          height: 800
        };
      }
    }
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowTarget
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentTarget
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      userAgent: "sidet-mobile-test",
      platform: "test",
      maxTouchPoints: 1
    }
  });
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({
      paddingBottom: "34px",
      getPropertyValue: () => ""
    })
  });
  Object.defineProperty(globalThis, "performance", {
    configurable: true,
    value: {
      now: () => clockMs
    }
  });

  return {
    windowTarget,
    documentTarget,
    visualViewportTarget,
    advanceTime(ms) {
      clockMs += Math.max(0, ms);
    },
    setVisualViewportValues({ height, offsetTop }) {
      if (height !== undefined) {
        visualViewportTarget.height = height;
      }
      if (offsetTop !== undefined) {
        visualViewportTarget.offsetTop = offsetTop;
      }
    },
    dispatchVisualViewport(eventType = "scroll") {
      visualViewportTarget.dispatchEvent(new Event(eventType));
    },
    setVisualViewport({ height, offsetTop }, eventType = "scroll") {
      if (height !== undefined) {
        visualViewportTarget.height = height;
      }
      if (offsetTop !== undefined) {
        visualViewportTarget.offsetTop = offsetTop;
      }
      visualViewportTarget.dispatchEvent(new Event(eventType));
    },
    flushTimers() {
      while (timers.size > 0) {
        const pending = Array.from(timers.entries());
        timers.clear();
        for (const [, { callback }] of pending) {
          callback();
        }
      }
    },
    flushFrames() {
      const pending = Array.from(frames.values());
      frames.clear();
      for (const callback of pending) {
        callback(0);
      }
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
      if (originalNavigator) {
        Object.defineProperty(globalThis, "navigator", originalNavigator);
      } else {
        delete globalThis.navigator;
      }
      if (originalPerformance) {
        Object.defineProperty(globalThis, "performance", originalPerformance);
      } else {
        delete globalThis.performance;
      }
      if (originalGetComputedStyle) {
        Object.defineProperty(
          globalThis,
          "getComputedStyle",
          originalGetComputedStyle
        );
      } else {
        delete globalThis.getComputedStyle;
      }
      delete globalThis.__SIDET_MOBILE_KEYBOARD_DIAGNOSTICS__;
      delete globalThis.__SIDET_MOBILE_KEYBOARD_PHASE_DIAGNOSTICS__;
    }
  };
}

function createRuntimeElements({ ios = false } = {}) {
  const contentClassNames = [
    "sidet-chat-view",
    "is-phone-layout",
    "is-mobile-runtime"
  ];
  const hostClassNames = ["sidet-chat-view", "sidet-mobile-composer-layer"];
  if (ios) {
    contentClassNames.push("is-ios-runtime");
    hostClassNames.push("is-ios-runtime");
  }
  const contentEl = createElement(
    contentClassNames,
    { top: 0, right: 390, bottom: 800, left: 0, width: 390, height: 800 }
  );
  const hostEl = createElement(
    hostClassNames,
    { top: 0, right: 390, bottom: 800, left: 0, width: 390, height: 800 }
  );
  const composerEl = createElement(
    ["sidet-composer-wrap", "is-mobile-keyboard-following"],
    { top: 680, right: 390, bottom: 736, left: 0, width: 390, height: 56 }
  );
  if (ios) {
    composerEl.getBoundingClientRect = () => {
      const inlineInset = Number.parseFloat(
        hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset")
      );
      const hostInset = Number.isFinite(inlineInset) ? inlineInset : 64;
      const viewportOffset = window.visualViewport?.offsetTop ?? 0;
      const bottom = 800 - hostInset - viewportOffset;
      return {
        top: bottom - 56,
        right: 390,
        bottom,
        left: 0,
        width: 390,
        height: 56
      };
    };
  }
  composerEl.style.setProperty("bottom", "64px");
  composerEl.parentNode = hostEl;
  composerEl.parentElement = hostEl;
  return { contentEl, hostEl, composerEl };
}

function createRuntime(module, elements, overrides = {}) {
  return new module.ChatViewMobileKeyboardFollowRuntime({
    getContentEl: () => elements.contentEl,
    getStableHostEl: () => elements.hostEl,
    getActiveComposerLayer: () => elements.composerEl,
    getActiveComposerTextarea: () => elements.composerEl,
    isComposerLayerActive: () =>
      elements.composerEl.parentNode === elements.hostEl,
    isPhoneLayout: () => true,
    isMobileRuntime: () => true,
    ...overrides
  });
}

function dispatchKeyboard(windowTarget, type, keyboardHeight) {
  const event = new Event(type);
  if (keyboardHeight !== undefined) {
    event.keyboardHeight = keyboardHeight;
  }
  windowTarget.dispatchEvent(event);
}

function assertHostSurfaceDurationMatchesPhoneModalCurve(module) {
  assert.equal(module.calculateMobileKeyboardHostSurfaceDuration(800), 250);
  assert.equal(module.calculateMobileKeyboardHostSurfaceDuration(400), 140);
  assert.equal(module.calculateMobileKeyboardHostSurfaceDuration(200), 100);
  assert.equal(
    module.calculateMobileKeyboardLayerCutoverDelay(250, 256, 56),
    32,
    "a long keyboard retreat should need only two visual frames before handoff"
  );
  assert.equal(
    module.calculateMobileKeyboardLayerCutoverDelay(250, 100, 120),
    72,
    "a short retreat must keep the bounded visual handoff ceiling"
  );
  assert.equal(
    module.calculateMobileKeyboardLayerCutoverDelay(250, 0, 120),
    0,
    "a surface without retreat travel should restore atomically"
  );
  assert.equal(module.calculateIosHostPanSafeInset(64, 374, 0), 64);
  assert.equal(module.calculateIosHostPanSafeInset(64, 374, 187), 32);
  assert.equal(module.calculateIosHostPanSafeInset(64, 374, 374), 0);
}

function assertSingleOwnerSourceContract() {
  const sourceRoot = path.join(rootDir, "src");
  const source = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-keyboard-follow.ts"),
    "utf8"
  );
  const mobileComposerSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-composer.ts"),
    "utf8"
  );
  const chatViewSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view.ts"),
    "utf8"
  );
  const mainSource = readFileSync(path.join(rootDir, "src", "main.ts"), "utf8");
  const css = readFileSync(path.join(rootDir, "styles.css"), "utf8");
  const phaseDiagnosticSource = readFileSync(
    path.join(
      rootDir,
      "src",
      "workspace",
      "chat-view-mobile-keyboard-phase-diagnostics.ts"
    ),
    "utf8"
  );
  const homeLifecycleDiagnosticSource = readFileSync(
    path.join(
      rootDir,
      "src",
      "workspace",
      "chat-view-mobile-home-lifecycle-diagnostics.ts"
    ),
    "utf8"
  );
  const sourceFiles = readdirSync(sourceRoot, {
    recursive: true,
    withFileTypes: true
  })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.join(entry.parentPath, entry.name));
  const hostInsetWriterFiles = sourceFiles
    .filter((sourceFile) => (
      /style\.setProperty\(\s*["']--sidet-mobile-keyboard-host-inset["']/
        .test(readFileSync(sourceFile, "utf8"))
    ))
    .map((sourceFile) => path.relative(rootDir, sourceFile).replaceAll("\\", "/"));

  assert.deepEqual(
    hostInsetWriterFiles,
    ["src/workspace/chat-view-mobile-keyboard-follow.ts"],
    "the stable keyboard parent inset must keep exactly one production writer"
  );
  assert.equal(
    source.match(
      /style\.setProperty\(\s*["']--sidet-mobile-keyboard-host-inset["']/g
    )?.length,
    1,
    "the keyboard runtime must funnel every persistent endpoint through one write method"
  );
  assert.match(
    source,
    /visualViewport\.addEventListener\("resize"[\s\S]*visualViewport\.addEventListener\("scroll"/,
    "iPhone must observe the host viewport as a read-only arbitration signal"
  );
  assert.doesNotMatch(
    source,
    /IOS_HOST_PAN_ARBITRATION_WINDOW|iosHostPanFallback/,
    "iPhone must not wait behind a timeout while the native keyboard covers the composer"
  );
  assert.doesNotMatch(
    source,
    /virtualKeyboard|geometrychange|MobileKeyboardMotionTracker/,
    "retired geometry source competition must not return"
  );
  assert.doesNotMatch(
    source,
    /applyFollowSample|applyIosHostPanSample|applyAndroidCapacitorEndpoint|isolateLegacyOpeningPosition/,
    "the child fallback implementations must leave the runtime"
  );
  assert.doesNotMatch(
    source,
    /style\.setProperty\(\s*["']bottom["']/,
    "the runtime must never write a composer child bottom"
  );
  assert.doesNotMatch(
    source,
    /window\.addEventListener\(\s*["']resize["']/,
    "layout viewport resize must not start another keyboard timeline"
  );
  assert.doesNotMatch(
    source,
    /captureMobileKeyboard|hostProbe|chat-view-mobile-keyboard-diagnostics/,
    "retired high-volume keyboard diagnostics must not return"
  );
  assert.match(
    phaseDiagnosticSource,
    /const MAX_CYCLES = 2;[\s\S]*const MAX_SAMPLES_PER_CYCLE = 72;/,
    "the iPhone phase probe must stay bounded to two compact focus cycles"
  );
  assert.doesNotMatch(
    phaseDiagnosticSource,
    /inputValue|textContent|innerText/,
    "the iPhone phase probe must never capture message or input content"
  );
  assert.match(
    homeLifecycleDiagnosticSource,
    /const MAX_EVENTS = 96;/,
    "the mobile-home lifecycle probe must remain bounded"
  );
  assert.doesNotMatch(
    homeLifecycleDiagnosticSource,
    /inputValue|textContent|innerText|conversationId|messageRevision/,
    "the mobile-home lifecycle probe must never capture input or conversation content"
  );
  assert.doesNotMatch(
    mainSource,
    /id:\s*["'](?:copy|clear)-sidet-iphone-keyboard-phase-diagnostic["']/,
    "internal keyboard diagnostics must not appear as user-facing commands"
  );
  assert.match(
    mainSource,
    /registerObsidianProtocolHandler\(\s*SIDET_IOS_INPUT_DIAGNOSTIC_ACTION,\s*this\.handleIosInputDiagnosticUri\s*\)/,
    "the bounded iPhone input report must stay reachable through a hidden protocol route"
  );
  assert.match(
    mainSource,
    /private async copyIosKeyboardPhaseDiagnostic\(\)[\s\S]*navigator\.clipboard\?\.writeText[\s\S]*document\.execCommand\("copy"\)/,
    "the hidden iPhone diagnostic implementation must retain the mobile clipboard fallback"
  );
  assert.equal(
    existsSync(
      path.join(
        rootDir,
        "src",
        "workspace",
        "chat-view-mobile-keyboard-host-probe.ts"
      )
    ),
    false,
    "the Quick Switcher host probe must leave the production source tree"
  );
  assert.equal(
    existsSync(
      path.join(
        rootDir,
        "src",
        "workspace",
        "chat-view-mobile-keyboard-diagnostics.ts"
      )
    ),
    false,
    "the temporary keyboard report buffer must leave the production source tree"
  );
  assert.match(
    source,
    /CAPACITOR_KEYBOARD_EVENT_NAMES[\s\S]*keyboardWillShow[\s\S]*keyboardDidHide/,
    "Capacitor keyboard lifecycle must remain the parent host endpoint source"
  );
  assert.match(
    css,
    /\.sidet-mobile-composer-layer[^{}]*\.is-mobile-keyboard-safe-host\s*\{[^}]*display:\s*flex;[^}]*padding-bottom:\s*var\(--sidet-mobile-keyboard-host-inset,\s*0px\);/s,
    "the stable body layer must own the final keyboard safe area"
  );
  assert.match(
    css,
    /\.is-mobile-keyboard-safe-host\s*>\s*\.sidet-composer-wrap\s*\{[^}]*position:\s*relative;[^}]*bottom:\s*auto;[^}]*margin-top:\s*auto;/s,
    "the composer must remain a normal-flow child of the moving surface"
  );
  assert.doesNotMatch(
    css,
    /is-mobile-keyboard-(?:opening-isolated|following)/,
    "retired child-position classes must not remain in CSS"
  );
  assert.match(
    css,
    /\.sidet-mobile-composer-layer\.sidet-chat-view\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*height:\s*auto;/s,
    "the body composer layer must use the same top-and-bottom anchored surface contract as the host modal layer"
  );
  assert.doesNotMatch(
    css,
    /\.sidet-mobile-composer-layer\.sidet-chat-view\s*\{[^}]*(?:position:\s*fixed|height:\s*100%);/s,
    "the iPhone keyboard surface must not keep an over-constrained fixed hundred-percent-height box"
  );
  assert.match(
    css,
    /--sidet-mobile-composer-shadow:\s*0\s+0\s+7px\s+rgba\(0,\s*0,\s*0,\s*0\.09\),\s*0\s+0\s+20px\s+rgba\(0,\s*0,\s*0,\s*0\.13\);/s,
    "light mode must keep a clearly visible centered lift without a downward axis"
  );
  assert.match(
    css,
    /\.theme-dark\s+\.sidet-browser-view,\s*\.theme-dark\s+\.sidet-chat-view\s*\{[^}]*--sidet-mobile-composer-surface:\s*var\([\s\S]*?--background-secondary-alt,[\s\S]*?--background-secondary[\s\S]*?\);/s,
    "dark mode must provide a visible raised surface"
  );
  assert.match(
    css,
    /\.theme-dark\s+\.sidet-browser-view,\s*\.theme-dark\s+\.sidet-chat-view\s*\{[^}]*--sidet-mobile-composer-shadow:\s*0\s+0\s+7px\s+rgba\(0,\s*0,\s*0,\s*0\.18\),\s*0\s+0\s+22px\s+rgba\(0,\s*0,\s*0,\s*0\.24\);/s,
    "dark mode must provide a stronger centered ambient shadow"
  );
  assert.match(
    css,
    /\.sidet-chat-view\.is-phone-layout\.is-mobile-runtime\s+\.sidet-composer\s*\{[^}]*border-color:\s*transparent;[^}]*background:\s*var\(--sidet-mobile-composer-surface\);[^}]*box-shadow:\s*var\(--sidet-mobile-composer-shadow\);/s,
    "the mobile composer must preserve border geometry and use the theme-aware raised surface"
  );
  assert.match(
    css,
    /\.sidet-chat-view\.is-mobile-runtime\s+\.sidet-composer-input-shell\s*\{[^}]*background:\s*var\(--sidet-mobile-composer-surface\);/s,
    "the editable input shell must use exactly the same theme surface as the composer body"
  );
  assert.doesNotMatch(
    mobileComposerSource,
    /keyboardFollowRuntime\.(?:prepareFocus|finishFocusAttempt)\(/,
    "the disproved pre-focus keyboard host path must not return"
  );
  assert.match(
    chatViewSource,
    /prepareComposerLayerForFocus\(\);\s*this\.recordMobileHomeInputLifecycle\("focus\.request\.prepared"\);\s*textareaEl\.focus\(\{\s*preventScroll:\s*true\s*\}\);\s*this\.recordMobileHomeInputLifecycle\("focus\.request\.after"\);\s*return;/s,
    "native focus must occur after only the composer layer and read-only diagnostics are stabilized"
  );
  assert.match(
    mobileComposerSource,
    /if\s*\(isFocused\)\s*\{\s*if\s*\(!this\.layerRuntime\.isActive\(\)\)\s*\{[\s\S]*?this\.mainComposer\.textareaEl\?\.blur\(\);[\s\S]*?this\.keyboardFollowRuntime\.endFocus\(\);[\s\S]*?return;[\s\S]*?this\.keyboardFollowRuntime\.beginFocus\(\);/s,
    "only an explicitly prepared native or programmatic textarea focus may start keyboard following"
  );
  assert.doesNotMatch(
    chatViewSource,
    /finishComposerFocusAttempt/,
    "the native focus call must not retain the failed pre-focus rollback handshake"
  );
  assert.match(
    css,
    /\.is-mobile-keyboard-safe-host\.is-mobile-keyboard-host-opening\s*>\s*\.sidet-composer-wrap,\s*[\s\S]*?\.is-mobile-keyboard-safe-host\.is-mobile-keyboard-host-closing\s*>\s*\.sidet-composer-wrap\s*\{[^}]*animation:\s*sidet-mobile-keyboard-host-surface/s,
    "only the visible composer surface must carry the keyboard compensation animation"
  );
  assert.doesNotMatch(
    css,
    /\.is-mobile-keyboard-safe-host\.is-mobile-keyboard-host-opening,\s*[\s\S]*?\.is-mobile-keyboard-safe-host\.is-mobile-keyboard-host-closing\s*\{[^}]*animation:/s,
    "the full-screen host must not become the iPhone transform carrier"
  );
  assert.match(
    css,
    /\.sidet-composer\s*\{[^}]*border:\s*1px solid color-mix\(in srgb,\s*var\(--background-modifier-border\)\s*86%,\s*transparent\);/s,
    "the composer must retain the published soft boundary instead of an opaque gray frame"
  );
  assert.match(
    css,
    /\.sidet-textarea:hover,\s*\.sidet-textarea:active,\s*\.sidet-textarea:focus,\s*\.sidet-textarea:focus-visible\s*\{[^}]*background-color:\s*transparent;/s,
    "the textarea must not inherit the host form-field background during touch, focus, or sticky hover states"
  );
  assert.match(
    css,
    /--sidet-mobile-resting-composer-bottom:\s*calc\(\s*var\(--navbar-height,\s*80px\)\s*\+\s*var\(--sidet-mobile-composer-navbar-gap\)\s*-\s*var\(--sidet-mobile-composer-bottom-padding\)\s*\);/,
    "the resting composer must derive its non-floating position from the host navbar height"
  );
  assert.match(
    css,
    /--sidet-mobile-composer-navbar-gap:\s*8px;/,
    "the resting composer must keep one explicit eight-pixel visual gap above the host navbar"
  );
  assert.match(
    css,
    /body\.is-floating-nav[\s\S]*?--sidet-mobile-resting-composer-bottom:\s*calc\([\s\S]*?var\(--navbar-height,\s*52px\)[\s\S]*?--navbar-bottom-offset[\s\S]*?--keyboard-height,\s*0px[\s\S]*?2px[\s\S]*?--sidet-mobile-composer-bottom-padding[\s\S]*?--sidet-mobile-composer-navbar-gap[\s\S]*?\);/,
    "the floating resting composer must follow the same host navbar geometry and keyboard inset"
  );
  assert.doesNotMatch(
    css,
    /--sidet-mobile-resting-composer-bottom:\s*(?:max|calc)\([^;]*72px/,
    "the resting position must not fall back to the retired fixed 72px total inset"
  );
  assert.match(
    css,
    /\.sidet-mobile-composer-layer\.sidet-chat-view\s*\{[^}]*z-index:\s*calc\(\s*var\(--layer-cover,\s*5\)\s*-\s*1\s*\);/s,
    "the body composer layer must stay below the host drawer backdrop as well as the drawer"
  );
  assert.doesNotMatch(
    css,
    /\.sidet-mobile-composer-layer\.sidet-chat-view\s*\{[^}]*z-index:\s*(?:10070|calc\(\s*var\(--layer-popover)/s,
    "the composer layer must not leak through the uncovered strip beside a moving drawer"
  );
  assert.match(
    css,
    /\.sidet-mobile-composer-layer\.is-ios-runtime:is\(\s*\.is-mobile-keyboard-caret-pending,\s*\.is-mobile-keyboard-host-opening\s*\)\s+\.sidet-textarea\s*\{[^}]*caret-color:\s*transparent;/s,
    "iPhone must suppress only the caret paint while the keyboard surface is moving"
  );
  assert.match(
    css,
    /\.sidet-chat-view\.sidet-mobile-composer-layer[^{}]*\.is-mobile-keyboard-safe-host\s*>\s*\.sidet-composer-wrap\s*\{[^}]*padding-top:\s*4px;[^}]*padding-bottom:\s*var\(--sidet-mobile-composer-bottom-padding\);/s,
    "the keyboard host must keep the shared mobile composer surface padding"
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*700px\)[\s\S]*?\.sidet-composer-wrap\s*\{[^}]*bottom:\s*var\(--sidet-mobile-resting-composer-bottom\);[^}]*padding-top:\s*4px;[^}]*padding-bottom:\s*var\(--sidet-mobile-composer-bottom-padding\);/s,
    "the restored composer must land on the same surface geometry as the keyboard host"
  );
  assert.doesNotMatch(
    css,
    /@media\s*\(max-width:\s*700px\)[\s\S]*?\.sidet-composer-wrap\s*\{[^}]*padding-bottom:\s*calc\([^}]*safe-area-inset-bottom/s,
    "the restored composer must not count the bottom safe area a second time"
  );
}

function assertIosPhaseProbeSeesViewportUpdateAfterEvent(
  module,
  diagnostics
) {
  const environment = installRuntimeEnvironment();
  try {
    diagnostics.clearIosKeyboardPhaseDiagnostics();
    const elements = createRuntimeElements({ ios: true });
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);

    environment.setVisualViewportValues({ height: 800, offsetTop: 0 });
    environment.dispatchVisualViewport("scroll");
    environment.setVisualViewportValues({ height: 800, offsetTop: 187 });
    environment.flushFrames();
    environment.flushFrames();

    const snapshot =
      diagnostics.getIosKeyboardPhaseDiagnosticsSnapshot();
    const cycle = snapshot.cycles.at(-1);
    assert.ok(cycle, "the iPhone focus must open one diagnostic cycle");
    assert.equal(snapshot.schemaVersion, 2);
    assert.equal(
      cycle.samples[0]?.runtime.activeElementIsTextarea,
      true,
      "the phase probe must compare activeElement with the real textarea target"
    );
    assert.equal(
      cycle.samples[0]?.runtime.composerParentIsHost,
      true,
      "the phase probe must expose whether the composer belongs to the keyboard host"
    );
    assert.equal(
      cycle.samples.find((sample) => sample.trigger === "keyboardWillShow")
        ?.signal.keyboardHeight,
      374,
      "the phase probe must retain the native keyboard height beside each show phase"
    );
    const samples = cycle.samples.filter(
      (sample) => sample.trigger === "visualViewport.scroll"
    );
    assert.deepEqual(
      samples.map((sample) => [
        sample.phase,
        sample.visualViewport.offsetTop
      ]),
      [
        ["event", 0],
        ["rAF1", 187],
        ["rAF2", 187]
      ],
      "the regression must model iOS updating VisualViewport after the event callback"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosPhaseProbeExposesHostActivationFailure(
  module,
  diagnostics
) {
  const environment = installRuntimeEnvironment();
  try {
    diagnostics.clearIosKeyboardPhaseDiagnostics();
    const elements = createRuntimeElements({ ios: true });
    const originalParentEl = createElement(
      ["sidet-chat-root"],
      { top: 0, right: 390, bottom: 800, left: 0, width: 390, height: 800 }
    );
    elements.composerEl.parentNode = originalParentEl;
    elements.composerEl.parentElement = originalParentEl;
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    const snapshot =
      diagnostics.getIosKeyboardPhaseDiagnosticsSnapshot();
    const focusSample = snapshot.cycles.at(-1)?.samples[0];
    assert.ok(focusSample, "a failed host activation must still emit one focus sample");
    assert.equal(
      focusSample.runtime.hostActivationFailure,
      "composer-parent-mismatch"
    );
    assert.equal(focusSample.runtime.composerLayerActive, false);
    assert.equal(focusSample.runtime.composerParentIsHost, false);
    assert.equal(focusSample.runtime.hostHasSafeClass, false);
    assert.equal(focusSample.runtime.activeElementIsTextarea, true);
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosPhaseProbeIsBounded(diagnostics) {
  const environment = installRuntimeEnvironment();
  try {
    diagnostics.clearIosKeyboardPhaseDiagnostics();
    const first = diagnostics.beginIosKeyboardPhaseDiagnosticCycle("first");
    const second = diagnostics.beginIosKeyboardPhaseDiagnosticCycle("second");
    const third = diagnostics.beginIosKeyboardPhaseDiagnosticCycle("third");
    const copyFocus = diagnostics.beginIosKeyboardPhaseDiagnosticCycle(
      "focus.begin"
    );
    const sample = {
      trigger: "test",
      phase: "event",
      signal: { keyboardHeight: null },
      layoutViewport: { innerHeight: 800, scrollY: 0 },
      visualViewport: { height: 800, offsetTop: 0, pageTop: 0 },
      document: { documentElementTop: 0, bodyTop: 0 },
      host: {
        top: 0,
        bottom: 800,
        inlineInset: "",
        computedInset: "",
        inlineOffset: "",
        computedTransform: ""
      },
      composer: {
        top: 680,
        bottom: 736,
        height: 56,
        computedPosition: "relative",
        computedBottom: "auto",
        computedTransform: ""
      },
      runtime: {
        focusActive: true,
        canManageKeyboard: true,
        composerLayerActive: true,
        closing: false,
        awaitingKeyboardDidHide: false,
        openingInset: 64,
        appliedInset: 64,
        presentedHeight: 0,
        hasObservedIosHostPan: false,
        iosHostPanActive: false,
        hostConnected: true,
        composerConnected: true,
        composerParentIsHost: true,
        hostHasSafeClass: true,
        hostActivationFailure: null,
        hostOpening: false,
        hostClosing: false,
        activeElementIsTextarea: true
      }
    };
    assert.equal(
      diagnostics.recordIosKeyboardPhaseDiagnosticSample(first, sample),
      false,
      "a cycle evicted from the two-cycle ring must reject late samples"
    );
    for (let index = 0; index < 80; index += 1) {
      diagnostics.recordIosKeyboardPhaseDiagnosticSample(second, sample);
    }
    for (let index = 0; index < 80; index += 1) {
      diagnostics.recordIosKeyboardPhaseDiagnosticSample(third, sample);
    }
    diagnostics.recordIosKeyboardPhaseDiagnosticSample(copyFocus, {
      ...sample,
      trigger: "focus.begin"
    });
    const snapshot =
      diagnostics.getIosKeyboardPhaseDiagnosticsSnapshot();
    assert.deepEqual(
      snapshot.cycles.map((cycle) => cycle.id),
      [second, third]
    );
    assert.equal(
      snapshot.cycles.some((cycle) => cycle.id === copyFocus),
      false,
      "a fresh command-palette focus restoration must not evict the last two meaningful cycles"
    );
    assert.equal(snapshot.cycles[0].samples.length, 72);
    assert.equal(snapshot.cycles[0].droppedSamples, 8);
    assert.equal(snapshot.cycles[1].samples.length, 72);
    assert.equal(snapshot.cycles[1].droppedSamples, 8);
    const report = diagnostics.serializeIosKeyboardPhaseDiagnostics();
    assert.doesNotMatch(report, /inputValue|textContent|innerText/);
    assert.ok(
      report.length < 175_000,
      `the bounded two-cycle report must remain compact, got ${report.length} characters`
    );
  } finally {
    environment.restore();
  }
}

function assertMobileHomeLifecycleProbeIsBounded(diagnostics) {
  diagnostics.clearMobileHomeLifecycleDiagnostics();
  const sample = {
    activeLeafIsView: true,
    activeElementIsTextarea: true,
    homeState: true,
    layerActive: true,
    rootInputState: true,
    composerInputState: true,
    ownership: {
      composerParent: "mobile-layer",
      capabilityParent: "composer-wrap"
    },
    viewport: {
      innerWidth: 390,
      innerHeight: 844,
      visualViewportWidth: 390,
      visualViewportHeight: 470,
      visualViewportOffsetTop: 0
    },
    geometry: {
      content: null,
      root: null,
      slot: null,
      capability: null,
      composer: null,
      layer: null
    }
  };
  for (let index = 0; index < 110; index += 1) {
    diagnostics.recordMobileHomeLifecycleDiagnostic(`event.${index}`, sample);
  }
  const snapshot = diagnostics.getMobileHomeLifecycleDiagnosticsSnapshot();
  assert.equal(snapshot.events.length, 96);
  assert.equal(snapshot.droppedEvents, 14);
  assert.equal(snapshot.events[0]?.event, "event.14");
  assert.equal(snapshot.events.at(-1)?.event, "event.109");
  const report = diagnostics.serializeMobileHomeLifecycleDiagnostics();
  assert.doesNotMatch(
    report,
    /inputValue|textContent|innerText|conversationId|messageRevision/
  );
  assert.ok(
    report.length < 90_000,
    `the bounded mobile-home lifecycle report must remain compact, got ${report.length} characters`
  );
}

function assertMobileHomeLifecycleProbeCarriesBoundedElementSignatures(
  diagnostics
) {
  diagnostics.clearMobileHomeLifecycleDiagnostics();
  const sample = {
    activeLeafIsView: true,
    activeElementIsTextarea: true,
    homeState: true,
    layerActive: true,
    rootInputState: true,
    composerInputState: true,
    ownership: {
      composerParent: "mobile-layer",
      capabilityParent: "composer-wrap"
    },
    viewport: {
      innerWidth: 390,
      innerHeight: 844,
      visualViewportWidth: 390,
      visualViewportHeight: 470,
      visualViewportOffsetTop: 0
    },
    geometry: {
      content: null,
      root: null,
      slot: null,
      capability: null,
      composer: null,
      layer: null
    }
  };

  const longClass = `${"chip ".repeat(40)}tail-overflow-marker`;
  const targetElement = {
    tagName: "DIV",
    getAttribute(name) {
      if (name === "class") {
        return longClass;
      }
      if (name === "role") {
        return "button";
      }
      return null;
    },
    isConnected: true
  };
  const signature = diagnostics.readMobileHomeElementSignature(targetElement);
  assert.equal(signature?.tag, "div");
  assert.equal(signature?.role, "button");
  assert.equal(signature?.classNameBrief?.length, 96);
  assert.equal(signature?.isConnected, true);
  assert.equal(diagnostics.readMobileHomeElementSignature(null), null);

  const tailEvent = {
    type: "click",
    target: signature,
    targetIsTextarea: false,
    targetContainsTextarea: false,
    textareaContainsTarget: true,
    activeElement: {
      tag: "textarea",
      role: null,
      classNameBrief: "sidet-textarea",
      isConnected: true
    }
  };
  diagnostics.recordMobileHomeLifecycleDiagnostic("native.tail.click", {
    ...sample,
    tailEvent,
    changedActiveElement: tailEvent.activeElement
  });

  // Mutating caller-owned objects must not rewrite the stored event.
  tailEvent.type = "contextmenu";
  signature.classNameBrief = "mutated";

  const snapshot = diagnostics.getMobileHomeLifecycleDiagnosticsSnapshot();
  const stored = snapshot.events.at(-1);
  assert.equal(stored?.event, "native.tail.click");
  assert.equal(stored?.tailEvent?.type, "click");
  assert.equal(stored?.tailEvent?.textareaContainsTarget, true);
  assert.equal(stored?.tailEvent?.target?.classNameBrief?.length, 96);
  assert.equal(stored?.tailEvent?.activeElement?.tag, "textarea");
  assert.equal(stored?.changedActiveElement?.classNameBrief, "sidet-textarea");

  const report = diagnostics.serializeMobileHomeLifecycleDiagnostics();
  assert.doesNotMatch(
    report,
    /inputValue|textContent|innerText|conversationId|messageRevision/
  );
  assert.ok(
    !report.includes("tail-overflow-marker"),
    "the element signature must truncate over-long class lists"
  );
  assert.ok(
    !report.includes("mutated"),
    "stored element signatures must be cloned from the caller-owned input"
  );
}

function assertHostStartsOnlyAfterFocusEvent(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();

    assert.equal(environment.documentTarget.activeElement, null);
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      false,
      "the keyboard host must not be prepared before the native focus event"
    );
    assert.equal(runtime.isManagingKeyboardViewport(), false);

    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      true,
      "the real focus event must establish the single parent keyboard host"
    );
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "64px"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertRuntimeUsesOnlyParentSafeArea(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "64px"
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      true
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-caret-pending"),
      true,
      "focus must suppress iPhone caret paint before the first keyboard frame"
    );
    assert.equal(runtime.isManagingKeyboardViewport(), true);

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "320px"
    );
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-offset"),
      "256px"
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    assert.equal(runtime.isFollowing(), true);
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-caret-pending"),
      false,
      "the opening surface class must take over caret suppression"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      true
    );

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "320px",
      "a repeated WillShow in the same focus cycle must not start a second rise"
    );

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 388);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "320px",
      "a later DidShow height must not start a random second iPhone rise"
    );
    environment.flushTimers();
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      false,
      "caret paint may resume only after the opening surface settles"
    );

    let restoreCalls = 0;
    environment.documentTarget.activeElement = null;
    runtime.endFocus();
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restoreCalls += 1;
    });
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "320px",
      "blur alone must not start a second keyboard-close timeline"
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    assert.equal(restoreCalls, 0);

    environment.flushTimers();
    assert.equal(restoreCalls, 0, "a blind blur timer must not restore the layer");

    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "64px",
      "the native hide lifecycle must drive the surface back to its resting endpoint"
    );
    environment.flushTimers();
    assert.equal(
      restoreCalls,
      1,
      "the composer layer must hand off during the retreat instead of waiting for keyboardDidHide"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      true,
      "the empty keyboard host may finish native cleanup after the visible composer has returned"
    );

    dispatchKeyboard(environment.windowTarget, "keyboardDidHide");
    environment.flushTimers();
    assert.equal(restoreCalls, 1);
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      false
    );
    assert.equal(runtime.isManagingKeyboardViewport(), false);
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosHostPanConsumesOneVisualDisplacement(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "374px",
      "iPhone must start the visible parent endpoint immediately instead of waiting behind the keyboard"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      true,
      "the visible wrapper must begin moving in the WillShow task"
    );

    environment.setVisualViewport({ height: 800, offsetTop: 187 });
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "32px",
      "the parent inset must collapse as the host consumes half of the movement"
    );
    assert.equal(
      800 - 32 - 187,
      581,
      "the visible composer endpoint must include only one half-pan displacement"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      false
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");

    environment.setVisualViewport({ height: 800, offsetTop: 374 });
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "0px"
    );
    assert.equal(
      800 - 0 - 374,
      426,
      "a 374px host pan and a 374px keyboard target must finish at one 374px endpoint"
    );

    environment.setVisualViewport({ height: 426, offsetTop: 0 }, "resize");
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "374px",
      "when the host pan ends, the parent must atomically take over the same endpoint"
    );
    assert.equal(800 - 374, 426);
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosWithoutHostPanStartsParentEndpointImmediately(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 306);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "306px",
      "a host without full-height pan must reach the Capacitor endpoint without an 80ms cover window"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      true
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    environment.flushFrames();
    environment.flushFrames();
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "306px"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosResidualViewportOffsetCannotStrandComposerHigh(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    environment.setVisualViewport({ height: 800, offsetTop: 187 });
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "32px"
    );

    environment.setVisualViewport(
      { height: 426, offsetTop: 56 },
      "resize"
    );
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "318px",
      "handoff must subtract the host movement still visible after viewport mode changes"
    );
    assert.equal(
      elements.composerEl.getBoundingClientRect().bottom,
      426,
      "a residual viewport offset must not strand the composer one surface above the keyboard"
    );

    environment.setVisualViewport({ height: 426, offsetTop: 0 }, "scroll");
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "374px",
      "the parent must continuously retake the residual distance when the host offset clears"
    );
    assert.equal(elements.composerEl.getBoundingClientRect().bottom, 426);

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 374);
    environment.flushFrames();
    environment.flushFrames();
    assert.equal(elements.composerEl.getBoundingClientRect().bottom, 426);
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosPanAlreadyVisibleAtShowIsConsumed(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    environment.setVisualViewport({ height: 800, offsetTop: 187 });

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "32px",
      "the show snapshot must consume a host pan that started before Capacitor WillShow"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      false
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosPanCloseUsesTheAppliedParentInset(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    environment.setVisualViewport({ height: 800, offsetTop: 374 });

    environment.documentTarget.activeElement = null;
    runtime.endFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "64px"
    );
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-offset"),
      "64px",
      "closing compensation must start from the applied zero inset, not the 374px target"
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertDidShowRecoversWhenWillShowIsMissing(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 306);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "306px",
      "DidShow must remain a fallback when the platform omits WillShow"
    );
    assert.equal(runtime.isFollowing(), true);
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertKeyboardHideWhileFocusedKeepsOneHost(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 285);
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    environment.flushTimers();
    dispatchKeyboard(environment.windowTarget, "keyboardDidHide");
    environment.flushTimers();

    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "64px"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      true,
      "a still-focused textarea keeps the same body host ready for a later show"
    );
    assert.equal(runtime.isFollowing(), false);

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 300);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "300px"
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertLateShowCannotReenterAfterBlur(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 300);
    runtime.endFocus();
    let restoreCalls = 0;
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restoreCalls += 1;
    });

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 300);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "300px",
      "a late show signal after blur must not start another position write"
    );
    environment.flushTimers();
    assert.equal(restoreCalls, 0);
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    environment.flushTimers();
    assert.equal(
      restoreCalls,
      1,
      "a late-show blur must still hand off during keyboardWillHide"
    );
    dispatchKeyboard(environment.windowTarget, "keyboardDidHide");
    environment.flushTimers();
    assert.equal(restoreCalls, 1);
    assert.equal(runtime.isManagingKeyboardViewport(), false);
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertRefocusCancelsPendingRestore(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 300);
    environment.flushTimers();
    runtime.endFocus();
    let restoreCalls = 0;
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restoreCalls += 1;
    });

    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 356);
    environment.flushTimers();
    assert.equal(restoreCalls, 0, "refocus must cancel the previous blur restore");
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "300px",
      "refocus before a native hide must not accept a one-composer-height show rewrite"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      false,
      "a confirmation show after refocus must not restart the opening surface"
    );
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "");
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertRefocusDuringRetreatCancelsVisualCutover(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 300);
    runtime.endFocus();
    let restoreCalls = 0;
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restoreCalls += 1;
    });
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");

    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    environment.flushTimers();

    assert.equal(
      restoreCalls,
      0,
      "refocus before the early visual cutover must keep the live composer layer"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertRefocusWithoutFreshShowKeepsPresentedEndpoint(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 300);
    runtime.endFocus();
    let restoreCalls = 0;
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restoreCalls += 1;
    });

    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    environment.flushTimers();

    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-inset"),
      "300px",
      "a transient blur/refocus without a fresh show signal must keep the stable keyboard endpoint"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      true,
      "refocus must keep the same body host instead of releasing and rebuilding it"
    );
    assert.equal(runtime.isFollowing(), true);
    assert.equal(restoreCalls, 0);
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertMissingStableHostFailsClosed(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements, {
      getStableHostEl: () => null
    });
    runtime.bind();
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.equal(runtime.isManagingKeyboardViewport(), false);
    assert.equal(elements.composerEl.style.getPropertyValue("bottom"), "64px");

    runtime.endFocus();
    let restoreCalls = 0;
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restoreCalls += 1;
    });
    environment.flushTimers();
    assert.equal(restoreCalls, 1);
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertEnvironmentResetCannotStrandLayer(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    runtime.endFocus();
    let restoreCalls = 0;
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restoreCalls += 1;
    });

    environment.windowTarget.dispatchEvent(new Event("orientationchange"));
    assert.equal(restoreCalls, 1);
    assert.equal(runtime.isManagingKeyboardViewport(), false);
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      false
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertWorkspaceOwnershipLossDoesNotWaitForKeyboardHide(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    runtime.endFocus();
    let deferredRestoreCalls = 0;
    runtime.scheduleLayerRestoreAfterBlur(() => {
      deferredRestoreCalls += 1;
    });

    runtime.interruptForHostOwnershipLoss("intersection");
    assert.equal(
      runtime.isManagingKeyboardViewport(),
      false,
      "a drawer ownership break must release the keyboard host immediately"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-safe-host"),
      false
    );
    environment.flushTimers();
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    dispatchKeyboard(environment.windowTarget, "keyboardDidHide");
    environment.flushTimers();
    assert.equal(
      deferredRestoreCalls,
      0,
      "the abandoned normal-blur restore must not fire after the owner-loss terminal handoff"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertPresentationSettledFiresOnDidShow(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const triggers = [];
    const runtime = createRuntime(module, elements, {
      onPresentationSettled: (trigger) => triggers.push(trigger)
    });
    runtime.bind();

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 320);
    assert.deepEqual(
      triggers,
      [],
      "a DidShow without focus must not settle a presentation"
    );

    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.deepEqual(
      triggers,
      [],
      "WillShow alone is not a settled keyboard endpoint"
    );

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 320);
    assert.deepEqual(
      triggers,
      ["keyboardDidShow"],
      "the Android endpoint settles on DidShow"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosDockSettleDefersPresentationSettled(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const triggers = [];
    const runtime = createRuntime(module, elements, {
      onPresentationSettled: (trigger) => triggers.push(trigger)
    });
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 306);
    assert.deepEqual(
      triggers,
      [],
      "iPhone must wait for the dock-settle passes before reporting the endpoint"
    );
    environment.flushFrames();
    assert.deepEqual(
      triggers,
      [],
      "one settle pass is not the final dock endpoint"
    );
    environment.flushFrames();
    assert.deepEqual(
      triggers,
      ["keyboardDidShow"],
      "the settled iPhone endpoint must notify exactly once"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosPanHandoffEmitsPresentationSettled(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const triggers = [];
    const runtime = createRuntime(module, elements, {
      onPresentationSettled: (trigger) => triggers.push(trigger)
    });
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    assert.deepEqual(triggers, []);

    environment.setVisualViewport({ height: 800, offsetTop: 187 });
    assert.deepEqual(triggers, []);
    environment.setVisualViewport({ height: 800, offsetTop: 374 });
    assert.deepEqual(
      triggers,
      [],
      "a host pan in progress must not report a settled endpoint"
    );

    environment.setVisualViewport({ height: 426, offsetTop: 0 }, "resize");
    assert.deepEqual(
      triggers,
      ["visualViewport.resize.pan-handoff"],
      "the pan handoff is the iPhone endpoint the view layer may follow"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertPresentationClosedFiresOnHide(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    let closed = 0;
    const runtime = createRuntime(module, elements, {
      onPresentationClosed: () => {
        closed += 1;
      }
    });
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    assert.equal(closed, 0, "focus alone must not close a presentation");

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.equal(closed, 0, "WillShow must not report a closed presentation");

    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    assert.equal(
      closed,
      1,
      "hide must release the keyboard-state reserved space exactly once"
    );

    runtime.release();
    assert.equal(
      closed,
      1,
      "release after hide must not double-close the presentation"
    );
  } finally {
    environment.restore();
  }
}

function assertOpeningAnimationEndRecomputesReservedSpace(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    let ended = 0;
    const runtime = createRuntime(module, elements, {
      onPresentationAnimationEnded: () => {
        ended += 1;
      }
    });
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.equal(
      ended,
      0,
      "the opening animation must not report its end immediately"
    );
    environment.flushTimers();
    assert.equal(
      ended,
      1,
      "the composer endpoint is final only after the surface animation ends"
    );
    runtime.release();
    assert.equal(ended, 1, "release after the opening must not double-report");
  } finally {
    environment.restore();
  }
}

function assertContentKeyboardPaddingIsNeutralized(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    assert.equal(
      elements.contentEl.style.getPropertyValue("padding-bottom"),
      "34px",
      "the host keyboard padding must be replaced by the resting content padding"
    );

    runtime.release();
    assert.equal(
      elements.contentEl.style.getPropertyValue("padding-bottom"),
      "",
      "release must hand the content padding back to the host"
    );
  } finally {
    environment.restore();
  }
}

function assertPresentationStartedFiresOnce(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    let started = 0;
    const runtime = createRuntime(module, elements, {
      onPresentationStarted: () => {
        started += 1;
      }
    });
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    assert.equal(started, 0, "focus alone must not start a keyboard presentation");

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.equal(
      started,
      1,
      "the content must start moving when the composer surface starts rising"
    );

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 374);
    assert.equal(
      started,
      1,
      "a confirmed or repeated show must not start a second presentation"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertLearnedKeyboardSurfaceDurationMatchesNativeAnimation(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-duration"),
      "250ms",
      "the first presentation keeps the existing surface-height fallback"
    );

    environment.advanceTime(280);
    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 320);

    runtime.endFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    environment.advanceTime(280);
    dispatchKeyboard(environment.windowTarget, "keyboardDidHide");
    environment.flushTimers();

    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-duration"),
      "280ms",
      "the measured WillShow-to-DidShow time must drive the next surface animation"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertIosFirstPresentationUsesKeyboardLikeDuration(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    const runtime = createRuntime(module, elements);
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();

    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-duration"),
      "320ms",
      "the first iPhone presentation must cap the open duration for a crisper travel"
    );

    environment.advanceTime(300);
    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 374);
    environment.flushFrames();
    environment.flushFrames();

    runtime.endFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-duration"),
      "300ms",
      "the legacy closing surface must reuse the learned keyboard rhythm"
    );
    environment.advanceTime(300);
    dispatchKeyboard(environment.windowTarget, "keyboardDidHide");
    environment.flushTimers();

    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 374);
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-duration"),
      "300ms",
      "a later focus must reuse the learned opening duration when it is below the cap"
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertLearnedSurfaceDurationIsClamped(module) {
  assert.equal(module.normalizeLearnedKeyboardSurfaceDuration(40), 150);
  assert.equal(module.normalizeLearnedKeyboardSurfaceDuration(360), 360);
  assert.equal(module.normalizeLearnedKeyboardSurfaceDuration(900), 520);
  assert.equal(
    module.normalizeLearnedKeyboardSurfaceDuration(Number.NaN),
    150,
    "a missing measurement must fall back to the shortest usable duration"
  );
  assert.equal(module.easeOutQuart(0), 0);
  assert.equal(module.easeOutQuart(0.5), 0.9375);
  assert.equal(module.easeOutQuart(1), 1);
  assert.equal(module.easeOutSine(0), 0);
  assert.ok(
    Math.abs(module.easeOutSine(0.5) - Math.SQRT1_2) < 1e-9,
    "the closing curve must keep a more even mid-flight speed"
  );
  assert.equal(module.easeOutSine(1), 1);
}

function assertFramedOpeningDrivesComposerInOneFrame(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements();
    const syncedVisualTops = [];
    const runtime = createRuntime(module, elements, {
      onPresentationFrame: (visualComposerTop) => {
        syncedVisualTops.push(visualComposerTop);
      }
    });
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);

    assert.equal(
      runtime.isFramedOpeningActive(),
      true,
      "the opening must be driven frame-by-frame instead of a detached CSS animation"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-framed"),
      true
    );
    assert.match(
      elements.composerEl.style.transform,
      /^translate3d\(0, 256\.00px, 0\)$/,
      "the composer must rise through its own compositor-friendly transform"
    );
    assert.equal(
      syncedVisualTops.length,
      1,
      "the content must sync in the same frame as the first composer write"
    );
    assert.equal(
      syncedVisualTops[0],
      680 + 256,
      "the first frame must report the resting visual top to the content"
    );

    environment.advanceTime(200);
    environment.flushFrames();
    const remaining = Number.parseFloat(
      /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(elements.composerEl.style.transform)?.[1]
    );
    assert.ok(
      Number.isFinite(remaining) && remaining > 0 && remaining < 2,
      `the quart easing must leave only a short tail, got ${remaining}`
    );
    assert.ok(
      syncedVisualTops.length >= 2 &&
        syncedVisualTops.at(-1) < 680 + remaining + 1,
      "every driven frame must report the live visual top to the content"
    );

    environment.advanceTime(300);
    environment.flushFrames();
    assert.equal(runtime.isFramedOpeningActive(), false);
    assert.equal(
      elements.composerEl.style.transform,
      "",
      "the inline transform must be cleared at the endpoint"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-opening"),
      false
    );
    runtime.release();
  } finally {
    environment.restore();
  }
}

function assertFramedCloseLandsWithComposer(module) {
  const environment = installRuntimeEnvironment();
  try {
    const elements = createRuntimeElements({ ios: true });
    let closeStarted = 0;
    let closeFinished = 0;
    let closed = 0;
    let restores = 0;
    const closeTops = [];
    const runtime = createRuntime(module, elements, {
      shouldFollowClose: () => true,
      onPresentationCloseStarted: () => {
        closeStarted += 1;
      },
      onPresentationCloseFrame: (visualComposerTop) => {
        closeTops.push(visualComposerTop);
      },
      onPresentationCloseFinished: () => {
        closeFinished += 1;
      },
      onPresentationClosed: () => {
        closed += 1;
      }
    });
    runtime.bind();
    environment.documentTarget.activeElement = elements.composerEl;
    runtime.beginFocus();
    dispatchKeyboard(environment.windowTarget, "keyboardWillShow", 320);
    environment.advanceTime(400);
    dispatchKeyboard(environment.windowTarget, "keyboardDidShow", 320);
    environment.flushFrames();
    environment.flushFrames();

    runtime.endFocus();
    runtime.scheduleLayerRestoreAfterBlur(() => {
      restores += 1;
    });
    dispatchKeyboard(environment.windowTarget, "keyboardWillHide");

    assert.equal(closeStarted, 1, "the framed close must capture its start geometry");
    assert.equal(
      closed,
      0,
      "the framed close must not collapse the keyboard reserved space at hide start"
    );
    assert.equal(restores, 0, "the layer must stay live while the composer falls");
    assert.equal(
      elements.hostEl.style.getPropertyValue("--sidet-mobile-keyboard-host-duration"),
      "210ms",
      "the framed close must cap its duration instead of trailing the full keyboard hide"
    );
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-framed"),
      true
    );
    const startTransform = Number.parseFloat(
      /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(elements.composerEl.style.transform)?.[1]
    );
    assert.ok(
      Number.isFinite(startTransform) && startTransform < 0,
      `the composer must start above its resting position, got ${startTransform}`
    );
    assert.equal(closeTops[0], 424, "the first close frame must report the presented top");

    environment.advanceTime(150);
    environment.flushFrames();
    const midTransform = Number.parseFloat(
      /translate3d\(0, (-?[\d.]+)px, 0\)/.exec(elements.composerEl.style.transform)?.[1]
    );
    assert.ok(
      midTransform > startTransform && midTransform < 0,
      "the composer must fall monotonically toward the resting position"
    );
    assert.ok(closeTops.length >= 2, "each close frame must report the live visual top");

    environment.advanceTime(400);
    environment.flushFrames();
    assert.equal(closeFinished, 1, "the framed close must finish once");
    assert.equal(
      closed,
      0,
      "the framed close replaces the legacy immediate reserved-space restore"
    );
    assert.equal(elements.composerEl.style.transform, "");
    assert.equal(
      elements.hostEl.classList.contains("is-mobile-keyboard-host-framed"),
      false
    );
    assert.equal(
      restores,
      1,
      "the layer must hand off only after the composer lands at its resting position"
    );

    dispatchKeyboard(environment.windowTarget, "keyboardDidHide");
    environment.flushTimers();
    assert.equal(runtime.isManagingKeyboardViewport(), false);
    runtime.release();
  } finally {
    environment.restore();
  }
}

async function main() {
  try {
    const module = await loadKeyboardFollowModule();
    const diagnostics = await loadKeyboardDiagnosticsModule();
    const homeLifecycleDiagnostics =
      await loadMobileHomeLifecycleDiagnosticsModule();
    assertHostSurfaceDurationMatchesPhoneModalCurve(module);
    assertSingleOwnerSourceContract();
    assertHostStartsOnlyAfterFocusEvent(module);
    assertRuntimeUsesOnlyParentSafeArea(module);
    assertIosHostPanConsumesOneVisualDisplacement(module);
    assertIosWithoutHostPanStartsParentEndpointImmediately(module);
    assertIosPanAlreadyVisibleAtShowIsConsumed(module);
    assertIosResidualViewportOffsetCannotStrandComposerHigh(module);
    assertIosPanCloseUsesTheAppliedParentInset(module);
    assertDidShowRecoversWhenWillShowIsMissing(module);
    assertKeyboardHideWhileFocusedKeepsOneHost(module);
    assertLateShowCannotReenterAfterBlur(module);
    assertRefocusCancelsPendingRestore(module);
    assertRefocusDuringRetreatCancelsVisualCutover(module);
    assertRefocusWithoutFreshShowKeepsPresentedEndpoint(module);
    assertMissingStableHostFailsClosed(module);
    assertEnvironmentResetCannotStrandLayer(module);
    assertWorkspaceOwnershipLossDoesNotWaitForKeyboardHide(module);
    assertPresentationSettledFiresOnDidShow(module);
    assertIosDockSettleDefersPresentationSettled(module);
    assertIosPanHandoffEmitsPresentationSettled(module);
    assertPresentationClosedFiresOnHide(module);
    assertOpeningAnimationEndRecomputesReservedSpace(module);
    assertContentKeyboardPaddingIsNeutralized(module);
    assertPresentationStartedFiresOnce(module);
    assertLearnedKeyboardSurfaceDurationMatchesNativeAnimation(module);
    assertIosFirstPresentationUsesKeyboardLikeDuration(module);
    assertLearnedSurfaceDurationIsClamped(module);
    assertFramedOpeningDrivesComposerInOneFrame(module);
    assertFramedCloseLandsWithComposer(module);
    assertIosPhaseProbeSeesViewportUpdateAfterEvent(module, diagnostics);
    assertIosPhaseProbeExposesHostActivationFailure(module, diagnostics);
    assertIosPhaseProbeIsBounded(diagnostics);
    assertMobileHomeLifecycleProbeIsBounded(homeLifecycleDiagnostics);
    assertMobileHomeLifecycleProbeCarriesBoundedElementSignatures(
      homeLifecycleDiagnostics
    );
    console.log("mobile keyboard follow logic test passed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
