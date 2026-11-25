interface ChatRenderTraceEntry {
  ts: number;
  event: string;
  data: Record<string, unknown>;
}

const TRACE_KEY = "__SIDET_RENDER_TRACE__";
const TRACE_LIMIT = 160;

type TraceHost = typeof window & {
  [TRACE_KEY]?: ChatRenderTraceEntry[];
  __SIDET_RENDER_TRACE_VERBOSE__?: boolean;
};

export function recordChatRenderTrace(event: string, data: Record<string, unknown>): void {
  if (typeof window === "undefined") {
    return;
  }
  const host = window as TraceHost;
  const trace = Array.isArray(host[TRACE_KEY]) ? host[TRACE_KEY] : [];
  trace.push({
    ts: Date.now(),
    event,
    data
  });
  if (trace.length > TRACE_LIMIT) {
    trace.splice(0, trace.length - TRACE_LIMIT);
  }
  host[TRACE_KEY] = trace;

  if (
    host.__SIDET_RENDER_TRACE_VERBOSE__ === true
    && typeof console !== "undefined"
    && typeof console.debug === "function"
  ) {
    console.debug("[SidetRender]", event, data);
  }
}
