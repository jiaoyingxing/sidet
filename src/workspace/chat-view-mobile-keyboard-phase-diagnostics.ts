export const IOS_KEYBOARD_PHASE_DIAGNOSTIC_BUILD =
  "20260726-ios-layer-ownership-phase-probe-v2";

const DIAGNOSTIC_STORE_KEY =
  "__SIDET_MOBILE_KEYBOARD_PHASE_DIAGNOSTICS__";
const MAX_CYCLES = 2;
const MAX_STORED_CYCLES = MAX_CYCLES + 1;
const MAX_SAMPLES_PER_CYCLE = 72;

export type IosKeyboardPhaseDiagnosticPhase = "event" | "rAF1" | "rAF2";

export interface IosKeyboardPhaseDiagnosticSampleInput {
  trigger: string;
  phase: IosKeyboardPhaseDiagnosticPhase;
  signal: {
    keyboardHeight: number | null;
  };
  layoutViewport: {
    innerHeight: number | null;
    scrollY: number | null;
  };
  visualViewport: {
    height: number | null;
    offsetTop: number | null;
    pageTop: number | null;
  };
  document: {
    documentElementTop: number | null;
    bodyTop: number | null;
  };
  host: {
    top: number | null;
    bottom: number | null;
    inlineInset: string;
    computedInset: string;
    inlineOffset: string;
    computedTransform: string;
  };
  composer: {
    top: number | null;
    bottom: number | null;
    height: number | null;
    computedPosition: string;
    computedBottom: string;
    computedTransform: string;
  };
  runtime: {
    focusActive: boolean;
    canManageKeyboard: boolean;
    composerLayerActive: boolean;
    closing: boolean;
    awaitingKeyboardDidHide: boolean;
    openingInset: number | null;
    appliedInset: number | null;
    presentedHeight: number;
    hasObservedIosHostPan: boolean;
    iosHostPanActive: boolean;
    hostConnected: boolean;
    composerConnected: boolean;
    composerParentIsHost: boolean;
    hostHasSafeClass: boolean;
    hostActivationFailure: string | null;
    hostOpening: boolean;
    hostClosing: boolean;
    activeElementIsTextarea: boolean;
  };
}

export interface IosKeyboardPhaseDiagnosticSample
  extends IosKeyboardPhaseDiagnosticSampleInput {
  sequence: number;
  elapsedMs: number;
}

export interface IosKeyboardPhaseDiagnosticCycle {
  id: number;
  trigger: string;
  startedAt: string;
  droppedSamples: number;
  samples: IosKeyboardPhaseDiagnosticSample[];
}

export interface IosKeyboardPhaseDiagnosticsSnapshot {
  schemaVersion: 2;
  build: string;
  generatedAt: string;
  limits: {
    cycles: number;
    samplesPerCycle: number;
  };
  cycles: IosKeyboardPhaseDiagnosticCycle[];
}

interface StoredDiagnosticCycle extends IosKeyboardPhaseDiagnosticCycle {
  startedAtMonotonicMs: number;
}

interface IosKeyboardPhaseDiagnosticStore {
  nextCycleId: number;
  nextSequence: number;
  cycles: StoredDiagnosticCycle[];
}

type DiagnosticStoreHost = typeof window & {
  [DIAGNOSTIC_STORE_KEY]?: IosKeyboardPhaseDiagnosticStore;
};

export function beginIosKeyboardPhaseDiagnosticCycle(
  trigger: string
): number {
  const store = getDiagnosticStore();
  const cycle: StoredDiagnosticCycle = {
    id: store.nextCycleId,
    trigger,
    startedAt: new Date().toISOString(),
    startedAtMonotonicMs: now(),
    droppedSamples: 0,
    samples: []
  };
  store.nextCycleId += 1;
  store.cycles.push(cycle);
  if (store.cycles.length > MAX_STORED_CYCLES) {
    store.cycles.splice(0, store.cycles.length - MAX_STORED_CYCLES);
  }
  return cycle.id;
}

export function recordIosKeyboardPhaseDiagnosticSample(
  cycleId: number,
  sample: IosKeyboardPhaseDiagnosticSampleInput
): boolean {
  const store = getDiagnosticStore();
  const cycle = store.cycles.find((candidate) => candidate.id === cycleId);
  if (!cycle) {
    return false;
  }
  if (cycle.samples.length >= MAX_SAMPLES_PER_CYCLE) {
    cycle.droppedSamples += 1;
    return false;
  }
  cycle.samples.push({
    sequence: store.nextSequence,
    elapsedMs: round(Math.max(0, now() - cycle.startedAtMonotonicMs)),
    ...sample
  });
  store.nextSequence += 1;
  return true;
}

export function clearIosKeyboardPhaseDiagnostics(): void {
  delete (window as DiagnosticStoreHost)[DIAGNOSTIC_STORE_KEY];
}

export function getIosKeyboardPhaseDiagnosticsSnapshot():
IosKeyboardPhaseDiagnosticsSnapshot {
  const store = getDiagnosticStore();
  const meaningfulCycles = store.cycles.filter((cycle) =>
    cycle.samples.some((sample) => sample.trigger !== "focus.begin")
  );
  const reportCycles = (
    meaningfulCycles.length > 0 ? meaningfulCycles : store.cycles
  ).slice(-MAX_CYCLES);
  return {
    schemaVersion: 2,
    build: IOS_KEYBOARD_PHASE_DIAGNOSTIC_BUILD,
    generatedAt: new Date().toISOString(),
    limits: {
      cycles: MAX_CYCLES,
      samplesPerCycle: MAX_SAMPLES_PER_CYCLE
    },
    cycles: reportCycles.map((cycle) => ({
      id: cycle.id,
      trigger: cycle.trigger,
      startedAt: cycle.startedAt,
      droppedSamples: cycle.droppedSamples,
      samples: cycle.samples.map((sample) => ({
        ...sample,
        signal: { ...sample.signal },
        layoutViewport: { ...sample.layoutViewport },
        visualViewport: { ...sample.visualViewport },
        document: { ...sample.document },
        host: { ...sample.host },
        composer: { ...sample.composer },
        runtime: { ...sample.runtime }
      }))
    }))
  };
}

export function serializeIosKeyboardPhaseDiagnostics(): string {
  const snapshot = getIosKeyboardPhaseDiagnosticsSnapshot();
  return [
    "# Sidet iPhone keyboard phase diagnostic",
    "",
    "This bounded report contains viewport and element geometry only.",
    "It does not contain message text or input values.",
    "",
    "```json",
    JSON.stringify(snapshot),
    "```"
  ].join("\n");
}

function getDiagnosticStore(): IosKeyboardPhaseDiagnosticStore {
  const host = window as DiagnosticStoreHost;
  const existing = host[DIAGNOSTIC_STORE_KEY];
  if (existing) {
    return existing;
  }
  const store: IosKeyboardPhaseDiagnosticStore = {
    nextCycleId: 1,
    nextSequence: 1,
    cycles: []
  };
  host[DIAGNOSTIC_STORE_KEY] = store;
  return store;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
