export interface MonitorNetworkSummary {
  scope: string;
  dnsFallbackAttempts: number;
  dnsFallbackResponses: number;
  dnsFallbackFailures: number;
}
export function createMonitorFetch(options?: Record<string, unknown>): typeof fetch & {
  networkSummary(): MonitorNetworkSummary;
};
export const monitorFetch: ReturnType<typeof createMonitorFetch>;
export function monitorNetworkSummary(): MonitorNetworkSummary;
