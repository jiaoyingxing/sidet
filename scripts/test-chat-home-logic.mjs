import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "sidet-chat-home-"));

async function loadChatHomeModule() {
  const outfile = path.join(tempDir, "chat-home.mjs");
  await build({
    entryPoints: [path.join(rootDir, "src", "workspace", "chat-home.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    alias: {
      obsidian: path.join(rootDir, "scripts", "test-stubs", "obsidian.ts")
    },
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function loadHomePinnedCommandModule() {
  const outfile = path.join(tempDir, "home-pinned-command.mjs");
  await build({
    entryPoints: [path.join(rootDir, "src", "workspace", "home-pinned-command.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent"
  });
  return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
}

async function loadMobileHomeRestGeometryModule() {
  const outfile = path.join(tempDir, "mobile-home-rest-geometry.mjs");
  await build({
    entryPoints: [
      path.join(
        rootDir,
        "src",
        "workspace",
        "chat-view-mobile-home-rest-geometry.ts"
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

class FakeClassList {
  constructor(initial = "") {
    this.names = new Set(initial.split(/\s+/).filter(Boolean));
  }

  add(...names) {
    for (const name of names) {
      this.names.add(name);
    }
  }

  contains(name) {
    return this.names.has(name);
  }

  toggle(name, force) {
    const next = force ?? !this.names.has(name);
    if (next) {
      this.names.add(name);
    } else {
      this.names.delete(name);
    }
    return next;
  }
}

class FakeElement {
  constructor(tagName = "div", options = {}) {
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList(options.cls ?? "");
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.textContent = options.text ?? "";
    this.hidden = false;
    this.disabled = false;
    this.type = "";
  }

  createDiv(options = {}) {
    return this.createEl("div", options);
  }

  createSpan(options = {}) {
    return this.createEl("span", options);
  }

  createEl(tagName, options = {}) {
    const child = new FakeElement(tagName, options);
    this.children.push(child);
    return child;
  }

  setAttr(name, value) {
    this.setAttribute(name, value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  toggleAttribute(name, force) {
    const next = force ?? !this.attributes.has(name);
    if (next) {
      this.attributes.set(name, "");
    } else {
      this.attributes.delete(name);
    }
    if (name === "hidden") {
      this.hidden = next;
    }
    return next;
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({
        currentTarget: this,
        preventDefault() {},
        stopPropagation() {},
        ...event
      });
    }
  }

  findByClass(className) {
    const result = [];
    if (this.classList.contains(className)) {
      result.push(this);
    }
    for (const child of this.children) {
      result.push(...child.findByClass(className));
    }
    return result;
  }

  allText() {
    return [this.textContent, ...this.children.map((child) => child.allText())].join(" ");
  }
}

function assertHomeRendersReusableCapabilitiesAndLabeledLaunchers(module) {
  const root = new FakeElement();
  let selectedCapability = null;
  let executedCommand = null;
  const controller = {
    getHomePinnedCommandInfos: () => [
      {
        commandId: "sidet:bookmark",
        label: "书签",
        commandName: "打开书签",
        sourceLabel: "Sidet",
        icon: "bookmark",
        available: true
      }
    ],
    executeHomePinnedCommand: async (commandId) => {
      executedCommand = commandId;
    }
  };

  const result = module.renderChatHome(root, controller, {
    capabilities: [
      {
        id: "web-clipping",
        label: "网页剪藏",
        icon: "clipboard",
        selected: false,
        onSelect: () => {
          selectedCapability = "web-clipping";
        }
      },
      {
        id: "web-search",
        label: "联网搜索",
        icon: "globe",
        selected: true,
        onSelect: () => {
          selectedCapability = "web-search";
        }
      }
    ]
  });

  assert.ok(result.composerSlotEl.classList.contains("sidet-home-composer-slot"));
  assert.ok(
    result.capabilityRowEl.classList.contains("sidet-home-capability-row")
  );
  assert.equal(result.capabilityEls.size, 2);
  assert.equal(result.capabilityEls.get("web-clipping").hidden, false);
  assert.equal(result.capabilityEls.get("web-search").hidden, false);
  assert.equal(
    result.capabilityEls.get("web-search").classList.contains("is-home-capability-selected"),
    true,
    "selected home capabilities need a persistent selected presentation class"
  );
  assert.equal(result.capabilityEls.get("web-search").attributes.get("aria-pressed"), "true");
  assert.equal(
    result.capabilityEls.get("web-search").attributes.get("aria-label"),
    "取消联网搜索",
    "a selected home capability must announce the cancel action"
  );
  assert.equal(
    result.capabilityEls.get("web-clipping").attributes.get("aria-label"),
    "选择网页剪藏",
    "an unselected home capability must announce the select action"
  );
  module.setChatHomeCapabilitySelected(
    result.capabilityEls.get("web-clipping"),
    true,
    "网页剪藏"
  );
  assert.equal(
    result.capabilityEls.get("web-clipping").attributes.get("aria-label"),
    "取消网页剪藏",
    "the home capability label must follow the live selected state"
  );
  module.setChatHomeCapabilitySelected(
    result.capabilityEls.get("web-clipping"),
    false,
    "知识库"
  );
  assert.equal(
    result.capabilityEls.get("web-clipping").attributes.get("aria-label"),
    "选择知识库",
    "the home capability label must return to the select action when cleared"
  );
  assert.ok(
    result.capabilityEls.get("web-clipping").classList.contains("sidet-composer-attachment-chip"),
    "home capabilities must reuse the composer chip surface"
  );
  assert.equal(
    result.capabilityEls.get("web-clipping").findByClass("sidet-composer-attachment-remove").length,
    0,
    "home capability candidates must not render a remove control"
  );

  result.capabilityEls.get("web-clipping").dispatch("click");
  assert.equal(selectedCapability, "web-clipping");

  const commandLabels = root.findByClass("sidet-home-command-label");
  assert.deepEqual(commandLabels.map((element) => element.textContent), ["书签"]);
  assert.doesNotMatch(root.allText(), /快捷程序/);
  const commandButtons = root.findByClass("sidet-home-command");
  assert.equal(commandButtons.length, 1);
  commandButtons[0].dispatch("click");
  assert.equal(executedCommand, "sidet:bookmark");
}

function assertSingleComposerHomeStateProtection() {
  const chatViewSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view.ts"),
    "utf8"
  );
  const layoutMetricsSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-layout-metrics.ts"),
    "utf8"
  );
  const homeSettingsSource = readFileSync(
    path.join(rootDir, "src", "settings", "setting-tab-home-section.ts"),
    "utf8"
  );
  const layerSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-composer-layer.ts"),
    "utf8"
  );
  const mobileComposerSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-mobile-composer.ts"),
    "utf8"
  );
  const workspaceOwnershipSource = readFileSync(
    path.join(
      rootDir,
      "src",
      "workspace",
      "chat-view-mobile-workspace-ownership.ts"
    ),
    "utf8"
  );
  const keyboardFollowSource = readFileSync(
    path.join(
      rootDir,
      "src",
      "workspace",
      "chat-view-mobile-keyboard-follow.ts"
    ),
    "utf8"
  );
  const css = readFileSync(path.join(rootDir, "styles.css"), "utf8");
  const contextIntakeSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-view-context-intake.ts"),
    "utf8"
  );
  const chatHomeSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-home.ts"),
    "utf8"
  );
  const attachmentRenderingSource = readFileSync(
    path.join(rootDir, "src", "workspace", "chat-attachment-rendering.ts"),
    "utf8"
  );

  assert.equal(
    [...chatViewSource.matchAll(/createEl\("textarea"/g)].length,
    1,
    "the home state must keep the single existing chat textarea"
  );
  assert.match(
    chatViewSource,
    /classList\.toggle\("is-home-state"/,
    "the existing chat root must own the home presentation state"
  );
  assert.match(
    css,
    /\.sidet-chat-view:not\(\.is-mobile-runtime\) \.sidet-chat-root\.is-home-state\s*>\s*\.sidet-composer-wrap/,
    "desktop home layout must reposition the existing composer wrapper"
  );
  assert.match(
    css,
    /\.sidet-chat-view\.is-phone-layout\.is-mobile-runtime \.sidet-chat-root\.is-home-state\s*>\s*\.sidet-composer-wrap/,
    "mobile resting home layout must reposition the existing composer wrapper"
  );
  assert.doesNotMatch(
    layerSource,
    /"is-home-composer-focused"/,
    "home presentation state must not enter the stable mobile focus layer"
  );
  assert.match(
    css,
    /\.sidet-home-capability-chip\.is-home-capability-selected[\s\S]*?background:/,
    "selected home capabilities must remain visible with a stable selected surface"
  );
  const buildHomeCapabilitiesSource = chatViewSource.slice(
    chatViewSource.indexOf("private buildHomeCapabilities()"),
    chatViewSource.indexOf("private isHomeCapabilitySelected(")
  );
  assert.match(
    buildHomeCapabilitiesSource,
    /if \(this\.isHomeCapabilitySelected\("web-search"\)\) \{\s*this\.controller\.setWebSearchEnabled\(this\.leaf, false\);/,
    "clicking a selected web-search chip must disable the mode"
  );
  assert.match(
    buildHomeCapabilitiesSource,
    /if \(this\.isHomeCapabilitySelected\("web-clipping"\)\) \{\s*this\.contextIntake\.clearDraftWebpageAttachments\(\);/,
    "clicking a selected web-clipping chip must remove the attached webpages"
  );
  assert.match(
    contextIntakeSource,
    /clearDraftWebpageAttachments\(\): void \{[\s\S]{0,260}?attachment\.type !== "webpage"[\s\S]{0,260}?this\.draftAttachments = nextAttachments;/,
    "clearing web-clipping must keep non-webpage attachments"
  );
  assert.match(
    chatHomeSource,
    /preserveFocus: true/,
    "home capability chips must not steal focus from a focused composer"
  );
  assert.match(
    attachmentRenderingSource,
    /if \(options\.preserveFocus\) \{[\s\S]{0,360}?chipEl\.addEventListener\("pointerdown", preserveFocusForPress\);[\s\S]{0,140}?chipEl\.addEventListener\("mousedown", preserveFocusForPress\);/,
    "preserveFocus must cancel the pointer press before the chip can take focus"
  );
  assert.match(
    buildHomeCapabilitiesSource,
    /private finishHomeCapabilityToggle[\s\S]{0,360}?activeElement === anchorEl[\s\S]{0,140}?anchorEl\.blur\(\);[\s\S]{0,140}?this\.focusActiveComposerTextarea\(\);/,
    "a capability toggle must clear any focus left on the chip before returning focus to the composer"
  );
  assert.match(
    css,
    /\.sidet-composer-attachment-chip\.is-clickable:focus-visible \{/,
    "keyboard focus must still be visible on composer chips"
  );
  assert.match(
    css,
    /@media \(hover: hover\) \{[\s\S]{0,160}?\.sidet-composer-attachment-chip\.is-clickable:hover \{/,
    "composer chip hover must be limited to hover-capable pointers"
  );
  assert.match(
    css,
    /@media \(hover: hover\) \{[\s\S]{0,120}?\.sidet-home-capability-chip:hover \{/,
    "home capability chip hover must be limited to hover-capable pointers"
  );
  assert.doesNotMatch(
    css,
    /\.sidet-chat-view:not\(\.is-mobile-runtime\)[^{]*is-home-composer-focused/,
    "desktop home focus must not add a separate composer height"
  );
  assert.doesNotMatch(
    css,
    /--sidet-chat-column-max-width:\s*clamp\(560px,\s*68vw,\s*780px\)/,
    "desktop home and conversation states must share the same composer column width"
  );
  assert.doesNotMatch(
    css,
    /\.sidet-chat-view:not\(\.is-mobile-runtime\)[\s\S]*?\.sidet-chat-root\.is-home-state[\s\S]*?>\s*\.sidet-composer-wrap[\s\S]*?>\s*\.sidet-composer\s*\{[^}]*min-height:/,
    "desktop home must not force a composer height that disappears after the first send"
  );
  assert.match(
    css,
    /\.sidet-chat-view:not\(\.is-mobile-runtime\) \.sidet-chat-root\.is-home-state\s*>\s*\.sidet-composer-wrap\s*\{[^}]*right:\s*0;[^}]*left:\s*0;[^}]*width:\s*auto;/s,
    "desktop home must keep the existing composer centered by the root width"
  );
  assert.doesNotMatch(
    css,
    /\.sidet-chat-view:not\(\.is-mobile-runtime\) \.sidet-chat-root\.is-home-state\s*>\s*\.sidet-composer-wrap\s*>\s*\.sidet-composer\s*\{[^}]*width:\s*100%;/s,
    "desktop home must not override the normal conversation composer width"
  );
  assert.match(
    css,
    /\.sidet-home-composer-slot\s*\{[^}]*height:\s*max\(\s*72px,\s*var\(--sidet-home-composer-slot-height,\s*72px\)\s*\);/s,
    "the desktop home slot must reserve the live composer height"
  );
  assert.match(
    chatViewSource,
    /resolveHomeComposerSlotHeight\([\s\S]*this\.composerEl\.getBoundingClientRect\(\)[\s\S]*--sidet-home-composer-slot-height/,
    "the home slot height must be measured from the same live composer DOM node"
  );
  assert.match(
    chatViewSource,
    /handleComposerResize[\s\S]*scheduleHomeComposerPositionSync\(\)/,
    "composer resize must refresh the home slot reservation"
  );
  assert.match(
    css,
    /\.sidet-chat-view:not\(\.is-mobile-runtime\)[\s\S]*?\.sidet-chat-root\.is-home-state[\s\S]*?\.sidet-messages\s*\{[^}]*padding-right:\s*0;[^}]*padding-left:\s*0;/s,
    "desktop home content must use the same narrow-pane inline boundary as the normal composer"
  );
  assert.doesNotMatch(
    css,
    /is-home-composer-focused/,
    "home focus must not introduce a parallel presentation or geometry state"
  );
  assert.match(
    css,
    /\.sidet-home-title\s*\{[^}]*margin-right:\s*max\(16px,\s*env\(safe-area-inset-right\)\);[^}]*margin-left:\s*max\(16px,\s*env\(safe-area-inset-left\)\);/s,
    "the mobile title must keep its existing safe-area-aware side position"
  );
  assert.match(
    css,
    /\.sidet-home-capability-row\s*\{[^}]*--sidet-home-inline-right[^}]*--sidet-home-inline-left[^}]*overflow-x:\s*auto;/s,
    "the mobile capability row must use the independently measured native composer width"
  );
  assert.doesNotMatch(
    css,
    /\.sidet-home-capability-row\s*\{[^}]*justify-content:\s*space-between;/s,
    "mobile capability chips must keep their compact continuous spacing"
  );
  assert.match(
    css,
    /\.sidet-home-capability-row\s*\{[^}]*--sidet-home-capability-edge-bleed:\s*2px;[^}]*padding-right:\s*var\(--sidet-home-capability-edge-bleed\);[^}]*padding-left:\s*var\(--sidet-home-capability-edge-bleed\);/s,
    "the mobile capability scroller must preserve unclipped breathing room around the aligned chip edges"
  );
  assert.match(
    css,
    /\.sidet-chat-view\.is-phone-layout\.is-mobile-runtime\s+\.sidet-chat-root\.is-home-state\s+\.sidet-messages\s*\{[^}]*overflow-x:\s*visible;/s,
    "the mobile home message surface must not clip the capability row before its own scrollport"
  );
  assert.match(
    css,
    /\.sidet-home-composer-slot\s*\{[^}]*--sidet-home-inline-right[^}]*--sidet-home-inline-left/s,
    "the resting composer slot must share the independently measured middle width"
  );
  assert.match(
    layoutMetricsSource,
    /homeRect\.left - contentRect\.left[\s\S]*contentRect\.right - homeRect\.right/,
    "the home middle width must come from live geometry measured against the view content, so drawer workspace transforms cannot glue it to the viewport edge"
  );
  assert.match(
    chatViewSource,
    /resolveHomeComposerInline\(homeRect, contentRect\)[\s\S]*--sidet-home-inline-left/,
    "chat view must use the shared live-geometry helper for home inline insets"
  );
  assert.doesNotMatch(
    chatViewSource,
    /window\.innerWidth - homeRect\.right/,
    "the home insets must not re-introduce viewport-anchored measurement that drifts with sidebar transforms"
  );
  assert.match(
    chatViewSource,
    /enterMobileHomeInputState[\s\S]*insertBefore\(capabilityRowEl,\s*composerWrapEl\.firstChild\)/,
    "mobile input state must move the existing capability row into the stable composer wrapper"
  );
  assert.match(
    chatViewSource,
    /onComposerLayerChange:\s*\(active\)\s*=>\s*\{\s*if\s*\(active\)\s*\{[\s\S]{0,320}?this\.enterMobileHomeInputState\(\);\s*\}\s*else\s*\{\s*this\.exitMobileHomeInputState\(\);\s*\}[\s\S]{0,180}?recordMobileHomeInputLifecycle/,
    "the stable body layer must own home capability reparenting before native focus"
  );
  const composerFocusHandlerSource = chatViewSource.slice(
    chatViewSource.indexOf("const onComposerFocusChange = () =>"),
    chatViewSource.indexOf(
      'this.textareaEl.addEventListener("focus", onComposerFocusChange)'
    )
  );
  assert.doesNotMatch(
    composerFocusHandlerSource,
    /enterMobileHomeInputState/,
    "a real focus event must not mutate the focused composer subtree"
  );
  assert.match(
    css,
    /\.sidet-chat-root\.is-home-input-state[\s\S]*:is\(\.sidet-home-title,\s*\.sidet-home-command-grid\)[\s\S]*visibility:\s*hidden;/,
    "mobile input state must hide the background title and command grid without removing their layout"
  );
  assert.match(
    css,
    /\.sidet-mobile-composer-layer[^{}]*>\s*\.sidet-composer-wrap\.is-home-input-state[\s\S]*flex-direction:\s*column;/,
    "focused home capabilities and the composer must share the stable mobile body layer"
  );
  assert.doesNotMatch(
    chatViewSource,
    /beginMobileHomeInputReturn/,
    "blur must keep the home presentation covered until the composer and capabilities are restored"
  );
  assert.doesNotMatch(
    composerFocusHandlerSource,
    /removeClass\("is-home-input-state"\)|exitMobileHomeInputState/,
    "the blur event must not reveal or reparent the home before the stable layer closes"
  );
  const activeLeafChangeSource = chatViewSource.slice(
    chatViewSource.indexOf(
      'this.controller.getApp().workspace.on("active-leaf-change"'
    ),
    chatViewSource.indexOf("override getState()")
  );
  assert.match(
    activeLeafChangeSource,
    /document\.activeElement === this\.textareaEl[\s\S]*this\.textareaEl\?\.blur\(\)/,
    "leaving the chat leaf must still dismiss the native textarea focus"
  );
  assert.match(
    activeLeafChangeSource,
    /else if \(\s*this\.mobileComposer\.isComposerLayerActive\(\)\s*\) \{\s*this\.syncMobileComposerFocusState\(false\);\s*\}/,
    "when the host steals activeElement without a blur event, the active composer layer must still enter the existing focus-end cutover"
  );
  assert.doesNotMatch(
    activeLeafChangeSource,
    /closeMobileComposerLayer/,
    "a sidebar leaf change must not bypass the validated blur and keyboard cutover lifecycle"
  );
  assert.match(
    activeLeafChangeSource,
    /recordMobileHomeInputLifecycle\("active-leaf-change"\)/,
    "sidebar focus loss must leave one bounded mobile-home lifecycle observation"
  );
  const workspaceResizeSource = chatViewSource.slice(
    chatViewSource.indexOf(
      'this.controller.getApp().workspace.on("resize"'
    ),
    chatViewSource.indexOf(
      'this.controller.getApp().workspace.on("active-leaf-change"'
    )
  );
  assert.match(
    workspaceResizeSource,
    /scheduleMobileHomeWorkspaceOwnershipSync\("workspace\.resize"\)/,
    "public workspace resize must validate mobile composer ownership when a drawer moves without changing the active leaf"
  );
  const workspaceOwnershipHintSource = chatViewSource.slice(
    chatViewSource.indexOf(
      "private scheduleMobileHomeWorkspaceOwnershipSync"
    ),
    chatViewSource.indexOf("private getScrollHost")
  );
  assert.match(
    workspaceOwnershipHintSource,
    /this\.mobileComposer\.requestWorkspaceOwnershipCheck\(event\)/,
    "public workspace events must remain optional hints for the body-layer ownership guard"
  );
  assert.doesNotMatch(
    workspaceOwnershipHintSource,
    /document\.activeElement|textareaEl\?\.blur\(\)|closeMobileComposerLayer/,
    "public workspace events must not become another focus or reparent owner"
  );
  assert.match(
    workspaceOwnershipSource,
    /new IntersectionObserver\([\s\S]*this\.evaluateRect\(\s*entry\.boundingClientRect,\s*"intersection"(?:,\s*entry\.intersectionRatio)?\s*\)/,
    "the active body layer must observe its own chat root without private drawer DOM"
  );
  assert.match(
    workspaceOwnershipSource,
    /Math\.abs\(rect\.left - anchor\.left\)[\s\S]*?WORKSPACE_DRIFT_TOLERANCE_PX/,
    "drawer motion must be recognized by the chat root's left-edge translation"
  );
  assert.doesNotMatch(
    workspaceOwnershipSource,
    /Math\.abs\(rect\.(?:right|width) - anchor\.(?:right|width)\)\s*<=/,
    "scrollbar width flicker must not be treated as drawer ownership loss"
  );
  assert.match(
    workspaceOwnershipSource,
    /this\.stop\(\);\s*this\.options\.onOwnershipLoss\(trigger(?:,\s*\{[\s\S]*?\})?\);/,
    "ownership loss must stop observation before starting the terminal handoff"
  );
  const ownershipInterruptionSource = mobileComposerSource.slice(
    mobileComposerSource.indexOf(
      "private interruptForWorkspaceOwnershipLoss"
    ),
    mobileComposerSource.indexOf("private measureComposerLayout")
  );
  assert.match(
    ownershipInterruptionSource,
    /document\.activeElement === textareaEl[\s\S]*textareaEl\?\.blur\(\);[\s\S]*interruptForHostOwnershipLoss\(trigger\);[\s\S]*closeComposerLayer\(\{\s*blur:\s*false\s*\}\)/,
    "drawer interruption must blur once, release keyboard ownership, and restore the same layer immediately"
  );
  assert.match(
    keyboardFollowSource,
    /interruptForHostOwnershipLoss\(trigger:\s*string\)[\s\S]*cancelPendingLayerRestore\(\)[\s\S]*releaseHost\(`host-ownership-loss:\$\{trigger\}`\)[\s\S]*this\.isClosing = false/,
    "drawer interruption must not wait for a native keyboard hide event"
  );
  const mobileHomeLayerChangeSource = chatViewSource.slice(
    chatViewSource.indexOf("onComposerLayerChange: (active) =>"),
    chatViewSource.indexOf("this.draftRuntime = new ChatViewDraftRuntime")
  );
  assert.ok(
    mobileHomeLayerChangeSource.indexOf(
      "this.captureMobileHomeWorkspaceAnchor()"
    ) <
      mobileHomeLayerChangeSource.indexOf(
        "this.enterMobileHomeInputState()"
      ),
    "the rest-state workspace anchor must be captured before the composer enters the body layer"
  );
  const homePositionSource = chatViewSource.slice(
    chatViewSource.indexOf("private syncHomeComposerPosition"),
    chatViewSource.indexOf("private clearHomeComposerPosition")
  );
  assert.match(
    homePositionSource,
    /if\s*\(this\.shouldPreserveMobileHomeWorkspaceAnchor\(\)\)\s*\{[\s\S]*return;[\s\S]*const homeEl/,
    "home position writes must retain the last stable rest geometry while a sidebar or viewport transition is active"
  );
  assert.match(
    chatViewSource,
    /return isMobileHomeRestGeometryDisplaced\(anchor,\s*current\);/,
    "the home writer gate must compare the full pre-focus rest geometry instead of only horizontal workspace drift"
  );
  assert.match(
    composerFocusHandlerSource,
    /recordMobileHomeInputLifecycle\(\s*isFocused\s*\?\s*"focus\.event"\s*:\s*"blur\.event"\s*\)/,
    "the native focus boundary must be visible to the bounded lifecycle probe"
  );
  const focusComposerSource = chatViewSource.slice(
    chatViewSource.indexOf("private focusComposerTextarea"),
    chatViewSource.indexOf("private getScrollHost")
  );
  assert.match(
    focusComposerSource,
    /recordMobileHomeInputLifecycle\("focus\.request\.before"\)[\s\S]*prepareComposerLayerForFocus\(\)[\s\S]*recordMobileHomeInputLifecycle\("focus\.request\.prepared"\)[\s\S]*textareaEl\.focus\(\{\s*preventScroll:\s*true\s*\}\)[\s\S]*recordMobileHomeInputLifecycle\("focus\.request\.after"\)/,
    "the iPhone focus request must expose the pre-layer, prepared, and native-focus return boundaries"
  );
  const mobileHomeExitSource = chatViewSource.slice(
    chatViewSource.indexOf("private exitMobileHomeInputState"),
    chatViewSource.indexOf("private syncHomeCapabilityVisibility")
  );
  assert.ok(
    mobileHomeExitSource.indexOf("insertBefore(") <
      mobileHomeExitSource.indexOf(
        'this.composerWrapEl?.removeClass("is-home-input-state")'
      ) &&
      mobileHomeExitSource.indexOf(
        'this.composerWrapEl?.removeClass("is-home-input-state")'
      ) <
        mobileHomeExitSource.indexOf(
          'this.rootEl?.removeClass("is-home-input-state")'
        ),
    "the capability row must return before the composer and home presentation are revealed"
  );
  const followKeyboardCloseSource = mobileComposerSource.slice(
    mobileComposerSource.indexOf("private shouldFollowKeyboardClose"),
    mobileComposerSource.indexOf("private beginKeyboardCloseFollow")
  );
  assert.match(
    followKeyboardCloseSource,
    /if\s*\(this\.options\.isHomeState\(\)\)\s*\{\s*return false;\s*\}/,
    "home must keep the one-shot layer handoff instead of the conversation close follow"
  );
  assert.match(
    css,
    /\.sidet-chat-root\.is-home-state[\s\S]*:is\(\.sidet-home-title,\s*\.sidet-home-command-grid\)[^{}]*\{[^}]*transition:\s*opacity/s,
    "the returning mobile home background must cross-fade behind the retreating composer"
  );
  assert.match(
    homeSettingsSource,
    /const BUILT_IN_URL_LAUNCHERS[\s\S]*id:\s*"open-chat"[\s\S]*clipboard:\s*false[\s\S]*id:\s*"clipboard-import"[\s\S]*clipboard:\s*true/,
    "URL settings must expose the two built-in open-chat links"
  );
  assert.match(
    homeSettingsSource,
    /for \(const launcher of BUILT_IN_URL_LAUNCHERS\)[\s\S]*renderBuiltInUrlLauncherRow/,
    "built-in URL links must reuse the existing URL launcher list"
  );
  const builtInUrlRowStart = homeSettingsSource.indexOf(
    "private renderBuiltInUrlLauncherRow"
  );
  const customUrlRowStart = homeSettingsSource.indexOf(
    "private renderUrlLauncherRow"
  );
  assert.ok(
    builtInUrlRowStart >= 0 && customUrlRowStart > builtInUrlRowStart,
    "built-in and custom URL rows must keep explicit display responsibilities"
  );
  const builtInUrlRowSource = homeSettingsSource.slice(
    builtInUrlRowStart,
    customUrlRowStart
  );
  assert.match(
    builtInUrlRowSource,
    /copyTextToClipboard/,
    "built-in URL rows must retain the existing copy action"
  );
  assert.doesNotMatch(
    builtInUrlRowSource,
    /trash-2|openRemoveUrlLauncherConfirm/,
    "built-in URL rows must not expose a delete action"
  );
}

function assertCompactHomeCommandLabels(module) {
  assert.equal(module.normalizeHomeCommandSourceLabel("插件：书签"), "书签");
  assert.equal(module.normalizeHomeCommandSourceLabel("核心插件: 白板"), "白板");
  assert.equal(module.normalizeHomeCommandSourceLabel(" Obsidian "), "Obsidian");
  assert.equal(module.normalizeHomeCommandSourceLabel("插件管理"), "插件管理");
}

function assertMobileHomeRestGeometryProtection(module) {
  const anchor = {
    rootLeft: 0,
    rootRight: 390,
    rootWidth: 390,
    composerTop: 286,
    composerLeft: 10,
    composerWidth: 370,
    viewportWidth: 390,
    viewportHeight: 844,
    visualViewportHeight: 844,
    visualViewportOffsetTop: 0
  };

  assert.equal(
    module.isMobileHomeRestGeometryDisplaced(anchor, { ...anchor }),
    false,
    "stable rest geometry must allow one normal home-position write"
  );
  assert.equal(
    module.isMobileHomeRestGeometryDisplaced(anchor, {
      ...anchor,
      composerTop: 224
    }),
    true,
    "moving the capability row into the active composer must not overwrite the saved home slot"
  );
  assert.equal(
    module.isMobileHomeRestGeometryDisplaced(anchor, {
      ...anchor,
      rootLeft: 328,
      rootRight: 718
    }),
    true,
    "drawer workspace drift must keep the original rest slot"
  );
  assert.equal(
    module.isMobileHomeRestGeometryDisplaced(anchor, {
      ...anchor,
      rootRight: 385,
      rootWidth: 385,
      composerWidth: 365
    }),
    false,
    "vertical scrollbar width flicker must not keep the home anchor forever"
  );
  assert.equal(
    module.isMobileHomeRestGeometryDisplaced(anchor, {
      ...anchor,
      viewportHeight: 522,
      visualViewportHeight: 478,
      visualViewportOffsetTop: 44
    }),
    true,
    "keyboard and visual-viewport transition geometry must not become a new rest slot"
  );
  assert.equal(
    module.isMobileHomeRestGeometryDisplaced(anchor, {
      ...anchor,
      composerTop: 286.5,
      visualViewportHeight: 843.5
    }),
    false,
    "sub-pixel viewport noise must not keep the anchor forever"
  );
}

async function main() {
  try {
    const module = await loadChatHomeModule();
    const homePinnedCommandModule = await loadHomePinnedCommandModule();
    const mobileHomeRestGeometryModule =
      await loadMobileHomeRestGeometryModule();
    assertHomeRendersReusableCapabilitiesAndLabeledLaunchers(module);
    assertSingleComposerHomeStateProtection();
    assertCompactHomeCommandLabels(homePinnedCommandModule);
    assertMobileHomeRestGeometryProtection(mobileHomeRestGeometryModule);
    console.log("chat home logic test passed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
