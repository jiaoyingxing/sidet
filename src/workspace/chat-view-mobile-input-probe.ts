/**
 * 移动输入聚焦探针：只在排障时使用，记录聚焦后一段时间内的视口 / 内容区 /
 * composer / 键盘 inset / 底部留白 / 跟随意图序列，以及键盘事件时间线，
 * 供诊断命令复制回传。
 *
 * 采样数据只留在内存，不写库、不写文件；最多保留 180 个样本与 48 个事件。
 */
export const MOBILE_INPUT_PROBE_BUILD = "20261127-mobile-input-probe-v2";

const PROBE_KEY = "__SIDET_MOBILE_INPUT_PROBE__";
const MAX_SAMPLES = 180;
const MAX_EVENTS = 48;

interface MobileInputProbeState {
  build: string;
  startedAt: number | null;
  lastFocusAt: number | null;
  samples: Array<Record<string, unknown> & { t: number; label: string }>;
  events: Array<Record<string, unknown> & { t: number; event: string }>;
}

type ProbeHost = typeof window & {
  [PROBE_KEY]?: MobileInputProbeState;
};

function readProbe(): MobileInputProbeState {
  const host = window as ProbeHost;
  const existing = host[PROBE_KEY];
  if (existing && existing.build === MOBILE_INPUT_PROBE_BUILD) {
    return existing;
  }
  const next: MobileInputProbeState = {
    build: MOBILE_INPUT_PROBE_BUILD,
    startedAt: null,
    lastFocusAt: null,
    samples: [],
    events: []
  };
  host[PROBE_KEY] = next;
  return next;
}

export function resetMobileInputProbe(now = Date.now()): void {
  const probe = readProbe();
  probe.startedAt = now;
  probe.lastFocusAt = now;
  probe.samples = [];
  probe.events = [];
}

/** 聚焦探针启用后才记录键盘事件，未排障时不产生任何缓存。 */
export function recordMobileInputProbeEvent(
  event: string,
  data: Record<string, unknown> = {},
  now = Date.now()
): void {
  const probe = readProbe();
  if (probe.startedAt === null) {
    return;
  }
  probe.events.push({
    ...data,
    t: Math.max(0, Math.round(now - probe.startedAt)),
    event
  });
  if (probe.events.length > MAX_EVENTS) {
    probe.events.splice(0, probe.events.length - MAX_EVENTS);
  }
}

export function recordMobileInputProbeSample(
  label: string,
  data: Record<string, unknown>,
  now = Date.now()
): void {
  const probe = readProbe();
  const startedAt = probe.startedAt ?? now;
  probe.samples.push({ ...data, t: Math.max(0, Math.round(now - startedAt)), label });
  if (probe.samples.length > MAX_SAMPLES) {
    probe.samples.splice(0, probe.samples.length - MAX_SAMPLES);
  }
}

export function serializeMobileInputProbe(input: {
  final: Record<string, unknown> | null;
  scrollTrace: Array<Record<string, unknown>>;
}): string {
  const probe = readProbe();
  return JSON.stringify(
    {
      build: probe.build,
      startedAt: probe.startedAt,
      sampleCount: probe.samples.length,
      eventCount: probe.events.length,
      final: input.final,
      samples: probe.samples,
      events: probe.events,
      scrollTrace: input.scrollTrace
    },
    null,
    2
  );
}
