export const MOBILE_HOME_LIFECYCLE_DIAGNOSTIC_BUILD =
  "20261124-mobile-tail-compat-guard-v8";

const DIAGNOSTIC_STORE_KEY =
  "__SIDET_MOBILE_HOME_LIFECYCLE_DIAGNOSTICS__";
const MAX_EVENTS = 96;
const MAX_SIGNATURE_CLASS_LENGTH = 96;

export interface MobileHomeElementSignature {
  tag: string;
  role: string | null;
  classNameBrief: string | null;
  isConnected: boolean;
}

export interface MobileHomeTailEventObservation {
  type: string;
  target: MobileHomeElementSignature | null;
  targetIsTextarea: boolean;
  targetContainsTextarea: boolean;
  textareaContainsTarget: boolean;
  activeElement: MobileHomeElementSignature | null;
}

export interface MobileHomeInputLifecycleExtras {
  tailEvent?: MobileHomeTailEventObservation | null;
}

export interface MobileHomeDiagnosticRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface MobileHomeLifecycleDiagnosticInput {
  activeLeafIsView: boolean;
  activeElementIsTextarea: boolean;
  homeState: boolean;
  layerActive: boolean;
  rootInputState: boolean;
  composerInputState: boolean;
  ownership: {
    composerParent: "mobile-layer" | "chat-root" | "other" | "none";
    capabilityParent: "composer-wrap" | "home" | "other" | "none";
  };
  viewport: {
    innerWidth: number;
    innerHeight: number;
    visualViewportWidth: number | null;
    visualViewportHeight: number | null;
    visualViewportOffsetTop: number | null;
  };
  geometry: {
    content: MobileHomeDiagnosticRect | null;
    root: MobileHomeDiagnosticRect | null;
    slot: MobileHomeDiagnosticRect | null;
    capability: MobileHomeDiagnosticRect | null;
    composer: MobileHomeDiagnosticRect | null;
    layer: MobileHomeDiagnosticRect | null;
  };
  tailEvent?: MobileHomeTailEventObservation | null;
  changedActiveElement?: MobileHomeElementSignature | null;
}

export interface MobileHomeLifecycleDiagnosticEvent
  extends MobileHomeLifecycleDiagnosticInput {
  sequence: number;
  occurredAt: string;
  event: string;
}

export interface MobileHomeLifecycleDiagnosticsSnapshot {
  schemaVersion: 1;
  build: string;
  generatedAt: string;
  maxEvents: number;
  droppedEvents: number;
  events: MobileHomeLifecycleDiagnosticEvent[];
}

interface MobileHomeLifecycleDiagnosticStore {
  nextSequence: number;
  droppedEvents: number;
  events: MobileHomeLifecycleDiagnosticEvent[];
}

type DiagnosticStoreHost = typeof window & {
  [DIAGNOSTIC_STORE_KEY]?: MobileHomeLifecycleDiagnosticStore;
};

// Node 逻辑测试环境无 window：使用模块级宿主承载诊断存储，Obsidian 内仍挂在 window 上。
const fallbackStoreHost: { [DIAGNOSTIC_STORE_KEY]?: MobileHomeLifecycleDiagnosticStore } = {};

function resolveDiagnosticStoreHost(): DiagnosticStoreHost {
  if (typeof window !== "undefined") {
    return window;
  }
  return fallbackStoreHost as DiagnosticStoreHost;
}

export function recordMobileHomeLifecycleDiagnostic(
  event: string,
  input: MobileHomeLifecycleDiagnosticInput
): void {
  const store = getDiagnosticStore();
  store.events.push({
    sequence: store.nextSequence,
    occurredAt: new Date().toISOString(),
    event,
    ...cloneInput(input)
  });
  store.nextSequence += 1;
  if (store.events.length > MAX_EVENTS) {
    const overflow = store.events.length - MAX_EVENTS;
    store.events.splice(0, overflow);
    store.droppedEvents += overflow;
  }
}

export function readMobileHomeElementSignature(
  element: Element | null
): MobileHomeElementSignature | null {
  if (!element) {
    return null;
  }
  const classAttribute = element.getAttribute("class");
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    classNameBrief:
      classAttribute && classAttribute.length > 0
        ? classAttribute.slice(0, MAX_SIGNATURE_CLASS_LENGTH)
        : null,
    isConnected: element.isConnected
  };
}

export function clearMobileHomeLifecycleDiagnostics(): void {
  delete resolveDiagnosticStoreHost()[DIAGNOSTIC_STORE_KEY];
}

export function getMobileHomeLifecycleDiagnosticsSnapshot():
MobileHomeLifecycleDiagnosticsSnapshot {
  const store = getDiagnosticStore();
  return {
    schemaVersion: 1,
    build: MOBILE_HOME_LIFECYCLE_DIAGNOSTIC_BUILD,
    generatedAt: new Date().toISOString(),
    maxEvents: MAX_EVENTS,
    droppedEvents: store.droppedEvents,
    events: store.events.map((entry) => ({
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      event: entry.event,
      ...cloneInput(entry)
    }))
  };
}

export function serializeMobileHomeLifecycleDiagnostics(): string {
  const snapshot = getMobileHomeLifecycleDiagnosticsSnapshot();
  return [
    "# Sidet mobile home input lifecycle diagnostic",
    "",
    "This bounded report contains input event phase names, lifecycle flags, and element geometry only.",
    "It does not contain message or draft content.",
    "",
    "```json",
    JSON.stringify(snapshot),
    "```"
  ].join("\n");
}

function getDiagnosticStore(): MobileHomeLifecycleDiagnosticStore {
  const host = resolveDiagnosticStoreHost();
  const existing = host[DIAGNOSTIC_STORE_KEY];
  if (existing) {
    return existing;
  }
  const store: MobileHomeLifecycleDiagnosticStore = {
    nextSequence: 1,
    droppedEvents: 0,
    events: []
  };
  host[DIAGNOSTIC_STORE_KEY] = store;
  return store;
}

function cloneInput(
  input: MobileHomeLifecycleDiagnosticInput
): MobileHomeLifecycleDiagnosticInput {
  return {
    activeLeafIsView: input.activeLeafIsView,
    activeElementIsTextarea: input.activeElementIsTextarea,
    homeState: input.homeState,
    layerActive: input.layerActive,
    rootInputState: input.rootInputState,
    composerInputState: input.composerInputState,
    ownership: { ...input.ownership },
    viewport: { ...input.viewport },
    geometry: {
      content: cloneRect(input.geometry.content),
      root: cloneRect(input.geometry.root),
      slot: cloneRect(input.geometry.slot),
      capability: cloneRect(input.geometry.capability),
      composer: cloneRect(input.geometry.composer),
      layer: cloneRect(input.geometry.layer)
    },
    tailEvent: input.tailEvent
      ? {
          type: input.tailEvent.type,
          target: cloneSignature(input.tailEvent.target),
          targetIsTextarea: input.tailEvent.targetIsTextarea,
          targetContainsTextarea: input.tailEvent.targetContainsTextarea,
          textareaContainsTarget: input.tailEvent.textareaContainsTarget,
          activeElement: cloneSignature(input.tailEvent.activeElement)
        }
      : null,
    changedActiveElement: cloneSignature(input.changedActiveElement ?? null)
  };
}

function cloneSignature(
  signature: MobileHomeElementSignature | null
): MobileHomeElementSignature | null {
  return signature ? { ...signature } : null;
}

function cloneRect(
  rect: MobileHomeDiagnosticRect | null
): MobileHomeDiagnosticRect | null {
  return rect ? { ...rect } : null;
}
