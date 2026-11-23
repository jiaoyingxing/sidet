interface ChatScrollTraceEntry {
  ts: number;
  event: string;
  data: Record<string, unknown>;
}

const TRACE_KEY = "__SIDET_SCROLL_TRACE__";
const TRACE_LIMIT = 200;

type TraceHost = typeof window & {
  [TRACE_KEY]?: ChatScrollTraceEntry[];
  __SIDET_SCROLL_TRACE_VERBOSE__?: boolean;
};

export function recordChatScrollTrace(event: string, data: Record<string, unknown>): void {
  const host = window as TraceHost;
  const nextEntry: ChatScrollTraceEntry = {
    ts: Date.now(),
    event,
    data
  };

  const trace = Array.isArray(host[TRACE_KEY]) ? host[TRACE_KEY] : [];
  trace.push(nextEntry);
  if (trace.length > TRACE_LIMIT) {
    trace.splice(0, trace.length - TRACE_LIMIT);
  }
  host[TRACE_KEY] = trace;

  if (host.__SIDET_SCROLL_TRACE_VERBOSE__ === true && typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug("[SidetScroll]", event, data);
  }
}
