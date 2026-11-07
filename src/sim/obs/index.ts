/** Observability tools: Prometheus/PromQL (promtool), Alertmanager (amtool), Loki/LogQL (logcli). */
import { logcli } from './logs';
import { amtool, promtool } from './prometheus';

export { activeAlerts, amAlerts, promQuery } from './prometheus';
export { query as promqlQuery } from './promql';
export const obsCommands = [promtool, amtool, logcli];
