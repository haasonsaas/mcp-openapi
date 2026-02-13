export interface MetricsState {
  toolCallsTotal: number;
  toolCallsFailed: number;
  toolCallsCancelled: number;
  toolCallsInFlight: number;
  toolCallLatencyMsTotal: number;
  retriesTotal: number;
  toolCallsByStatus: Record<string, number>;
  latencyBuckets: Record<string, number>;
}

export const metrics: MetricsState = {
  toolCallsTotal: 0,
  toolCallsFailed: 0,
  toolCallsCancelled: 0,
  toolCallsInFlight: 0,
  toolCallLatencyMsTotal: 0,
  retriesTotal: 0,
  toolCallsByStatus: {},
  latencyBuckets: {
    "le_50": 0,
    "le_100": 0,
    "le_250": 0,
    "le_500": 0,
    "le_1000": 0,
    "le_2000": 0,
    "le_inf": 0
  }
};

export function observeStatus(status: number): void {
  const key = `${status}`;
  metrics.toolCallsByStatus[key] = (metrics.toolCallsByStatus[key] ?? 0) + 1;
}

export function observeLatency(ms: number): void {
  if (ms <= 50) metrics.latencyBuckets.le_50 += 1;
  if (ms <= 100) metrics.latencyBuckets.le_100 += 1;
  if (ms <= 250) metrics.latencyBuckets.le_250 += 1;
  if (ms <= 500) metrics.latencyBuckets.le_500 += 1;
  if (ms <= 1000) metrics.latencyBuckets.le_1000 += 1;
  if (ms <= 2000) metrics.latencyBuckets.le_2000 += 1;
  metrics.latencyBuckets.le_inf += 1;
}

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
    `mcp_openapi_retries_total ${metrics.retriesTotal}`,
    "# TYPE mcp_openapi_tool_call_latency_ms histogram",
    `mcp_openapi_tool_call_latency_ms_bucket{le="50"} ${metrics.latencyBuckets.le_50}`,
    `mcp_openapi_tool_call_latency_ms_bucket{le="100"} ${metrics.latencyBuckets.le_100}`,
    `mcp_openapi_tool_call_latency_ms_bucket{le="250"} ${metrics.latencyBuckets.le_250}`,
    `mcp_openapi_tool_call_latency_ms_bucket{le="500"} ${metrics.latencyBuckets.le_500}`,
    `mcp_openapi_tool_call_latency_ms_bucket{le="1000"} ${metrics.latencyBuckets.le_1000}`,
    `mcp_openapi_tool_call_latency_ms_bucket{le="2000"} ${metrics.latencyBuckets.le_2000}`,
    `mcp_openapi_tool_call_latency_ms_bucket{le="+Inf"} ${metrics.latencyBuckets.le_inf}`,
    "# TYPE mcp_openapi_tool_calls_by_status_total counter",
    ...Object.entries(metrics.toolCallsByStatus).map(([status, count]) => `mcp_openapi_tool_calls_by_status_total{status="${status}"} ${count}`)
  ].join("\n") + "\n";
}
