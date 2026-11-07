import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { installStack } from './install';
import { query } from './promql';

function lab() {
  const t = makeShell();
  installStack(t.state, {
    series: [
      { name: 'up', labels: { job: 'apps', instance: 'checkout:8080' }, type: 'gauge', value: 1 },
      { name: 'up', labels: { job: 'apps', instance: 'payments:8080' }, type: 'gauge', value: 1, phases: [{ from: -900, value: 0 }] },
      { name: 'http_requests_total', labels: { service: 'checkout', status: '200' }, type: 'counter', rate: 90 },
      { name: 'http_requests_total', labels: { service: 'checkout', status: '500' }, type: 'counter', rate: 10, phases: [{ when: { fileContains: { path: '/etc/fixed', text: 'yes' } }, rate: 0 }] },
      { name: 'http_requests_total', labels: { service: 'catalog', status: '200' }, type: 'counter', rate: 50 },
      { name: 'http_request_duration_seconds', labels: { service: 'checkout' }, type: 'histogram', rate: 100, latency: { p50: 0.08, p99: 1.2 } },
    ],
    logs: [{ labels: { app: 'checkout' }, repeat: { every: 30, from: -3600, lines: ['{"level":"info","msg":"order placed","order":"A-{n}"}', '{"level":"error","msg":"payment declined","order":"B-77","status":502}'] } }],
  });
  return t;
}

describe('PromQL', () => {
  it('selectors, rate, aggregation, ratios, quantiles', () => {
    const t = lab();
    const now = Math.floor(t.state.clock / 1000);
    const v = query(t.state, 'up == 0', now);
    expect(v.type === 'vector' && v.v.map((s) => s.labels.instance)).toEqual(['payments:8080']);
    const r = query(t.state, 'sum by (service) (rate(http_requests_total[5m]))', now);
    expect(r.type === 'vector' && Object.fromEntries(r.v.map((s) => [s.labels.service, Math.round(s.value)]))).toEqual({ checkout: 100, catalog: 50 });
    const ratio = query(t.state, 'sum by (service) (rate(http_requests_total{status=~"5.."}[5m])) / sum by (service) (rate(http_requests_total[5m]))', now);
    expect(ratio.type === 'vector' && Math.round(ratio.v[0].value * 100)).toBe(10);
    const p99 = query(t.state, 'histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))', now);
    expect(p99.type === 'vector' && p99.v[0].value).toBeGreaterThan(0.9);
    expect(() => query(t.state, 'rate(http_requests_total)', now)).toThrow('expected type range vector');
    expect(() => query(t.state, 'sum(rate(x[5m])', now)).toThrow('parse error');
  });
  it('promtool, rules, alerts and silences', () => {
    const t = lab();
    expect(t.run('promtool query instant http://localhost:9090 \'up{instance="payments:8080"}\'').out).toMatch(/^up\{instance="payments:8080", job="apps"\} => 0 @\[\d+\]\n$/);
    t.vfs().writeFile('/home/student/bad.yml', 'groups:\n  - name: x\n    rules:\n      - alert: A\n        expr: rate(x[5m] > 1\n');
    const bad = t.run('promtool check rules bad.yml');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('could not parse expression');
    t.vfs().writeFile('/home/student/ok.yml', 'groups:\n  - name: apps\n    rules:\n      - alert: TargetDown\n        expr: up == 0\n        for: 1m\n        labels:\n          severity: page\n        annotations:\n          summary: "{{ $labels.instance }} is down"\n');
    expect(t.run('promtool check rules ok.yml').out).toContain('SUCCESS: 1 rules found');
    t.setup('sudo cp ok.yml /etc/prometheus/rules/apps.yml', 'sudo systemctl reload prometheus');
    expect(t.run('amtool alert').out).not.toContain('TargetDown');
    t.setup('sleep 2m');
    const a = t.run('amtool alert query');
    expect(a.out).toContain('TargetDown');
    expect(a.out).toContain('payments:8080 is down');
    const id = t.run('amtool silence add alertname=TargetDown --comment="maintenance" --duration=1h').out.trim();
    expect(t.run('amtool alert').out).not.toContain('TargetDown');
    expect(t.run('amtool silence query').out).toContain(id);
    expect(t.run('curl -s localhost:9090/api/v1/alerts').out).toContain('"state":"firing"');
  });
  it('metrics react to fixes', () => {
    const t = lab();
    const q = 'sum(rate(http_requests_total{status="500"}[1m]))';
    expect(t.run(`promtool query instant http://localhost:9090 '${q}'`).out).toContain('=> 10 @');
    t.setup('echo yes | sudo tee /etc/fixed', `promtool query instant http://localhost:9090 '${q}'`, 'sleep 2m');
    expect(t.run(`promtool query instant http://localhost:9090 '${q}'`).out).toContain('=> 0 @');
  });
});

describe('logcli', () => {
  it('filters, parses and counts logs', () => {
    const t = lab();
    const r = t.run('logcli query -q --limit=2 \'{app="checkout"} |= "error" | json | status >= 500\'');
    expect(r.out.split('\n').filter(Boolean)).toHaveLength(2);
    expect(r.out).toContain('payment declined');
    const c = t.run('logcli query -q \'sum by (order) (count_over_time({app="checkout"} | json | level="error" [1h]))\'');
    expect(c.out).toBe('{order="B-77"} => 60\n');
    expect(t.run('logcli query \'{app=~".*"}\'').err).toContain('queries require at least one regexp');
  });
});
