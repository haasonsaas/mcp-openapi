export interface MetricsState {
  toolCallsTotal: number;
  toolCallsFailed: number;
  toolCallsCancelled: number;
  toolCallsInFlight: number;
  toolCallLatencyMsTotal: number;
  retriesTotal: number;
}

export const metrics: MetricsState = {
  toolCallsTotal: 0,
  toolCallsFailed: 0,
  toolCallsCancelled: 0,
  toolCallsInFlight: 0,
  toolCallLatencyMsTotal: 0,
  retriesTotal: 0
};

export function renderPrometheus(): string {
  const avgLatency = metrics.toolCallsTotal > 0 ? metrics.toolCallLatencyMsTotal / metrics.toolCallsTotal : 0;
  return [
    "# TYPE mcp_openapi_tool_calls_total counter",
    `mcp_openapi_tool_calls_total ${metrics.toolCallsTotal}`,
    "# TYPE mcp_openapi_tool_calls_failed_total counter",
    `mcp_openapi_tool_calls_failed_total ${metrics.toolCallsFailed}`,
    "# TYPE mcp_openapi_tool_calls_cancelled_total counter",
    `mcp_openapi_tool_calls_cancelled_total ${metrics.toolCallsCancelled}`,
    "# TYPE mcp_openapi_tool_calls_in_flight gauge",
    `mcp_openapi_tool_calls_in_flight ${metrics.toolCallsInFlight}`,
    "# TYPE mcp_openapi_tool_call_latency_avg_ms gauge",
    `mcp_openapi_tool_call_latency_avg_ms ${avgLatency}`,
    "# TYPE mcp_openapi_retries_total counter",
    `mcp_openapi_retries_total ${metrics.retriesTotal}`
  ].join("\n") + "\n";
}
