import { describe, expect, it } from 'vitest';
import { buildInitialState } from '../../game/initialState';
import { createShell } from '../index';
import { makeShell } from '../testing';

const dep = (name: string, labels: string, image: string, replicas = 2) =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${name}\nspec:\n  replicas: ${replicas}\n  selector:\n    matchLabels: {${labels}}\n  template:\n    metadata:\n      labels: {${labels}}\n    spec:\n      containers:\n      - name: app\n        image: ${image}\n        ports:\n        - containerPort: 8080\n`;
const svc = (name: string, selector: string) => `apiVersion: v1\nkind: Service\nmetadata:\n  name: ${name}\nspec:\n  selector: {${selector}}\n  ports:\n  - port: 80\n    targetPort: 8080\n`;

function strategies() {
  const t = makeShell();
  t.setup('kubectl get nodes');
  Object.assign(t.state.kube!.images, { 'ghcr.io/acme/shop:1': { listen: [8080], http: { '/': { body: 'shop v1\n' } } }, 'ghcr.io/acme/shop:2': { listen: [8080], http: { '/': { body: 'shop v2\n' } } } });
  t.vfs().writeFile('/home/student/s.yaml', [dep('shop-blue', 'app: shop, version: blue', 'ghcr.io/acme/shop:1'), dep('shop-green', 'app: shop, version: green', 'ghcr.io/acme/shop:2'), svc('shop', 'app: shop, version: blue'), svc('shop-v2', 'app: shop, version: green')].join('---\n'));
  t.setup('kubectl apply -f s.yaml', 'kubectl rollout status deploy/shop-blue', 'kubectl rollout status deploy/shop-green');
  return t;
}

describe('kubectl patch and set selector', () => {
  it('merge-, strategic- and json-patches objects', () => {
    const t = strategies();
    const curl = () => t.run('kubectl run c --rm -i --restart=Never --image=curlimages/curl -- curl -s http://shop').out;
    expect(curl()).toContain('shop v1');
    expect(t.run(`kubectl patch service shop -p '{"spec":{"selector":{"version":"green"}}}'`).out).toBe('service/shop patched\n');
    expect(t.run('kubectl get svc shop -o jsonpath={.spec.selector}').out).toBe('{"app":"shop","version":"green"}');
    expect(curl()).toContain('shop v2');
    expect(t.run(`kubectl set selector service shop 'app=shop,version=blue'`).out).toBe('service/shop selector updated\n');
    expect(curl()).toContain('shop v1');
    expect(t.run(`kubectl patch deployment shop-blue -p '{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}'`).out).toBe('deployment.apps/shop-blue patched\n');
    expect(t.run('kubectl get deploy shop-blue -o jsonpath={.spec.strategy}').out).toBe('{"type":"Recreate"}');
    expect(t.run(`kubectl patch deployment shop-blue --type=json -p '[{"op":"replace","path":"/spec/replicas","value":3}]'`).out).toBe('deployment.apps/shop-blue patched\n');
    expect(t.run(`kubectl patch deployment shop-blue -p '{"spec":{"replicas":3}}'`).out).toBe('deployment.apps/shop-blue patched (no change)\n');
    expect(t.run(`kubectl patch deployment shop-blue -p '{"spec":{"template":{"spec":{"containers":[{"name":"app","image":"ghcr.io/acme/shop:2"}]}}}}'`).out).toBe('deployment.apps/shop-blue patched\n');
    expect(t.run('kubectl get deploy shop-blue -o jsonpath={.spec.template.spec.containers[0].ports[0].containerPort}').out).toBe('8080');
    expect(t.run(`kubectl patch deployment shop-blue -p '{"spec":{"replicas":-1}}'`).err).toMatch(/^Error from server \(Invalid\): The Deployment "shop-blue" is invalid/);
    expect(t.run('kubectl patch deployment shop-blue').err).toMatch(/^error: must specify --patch or --patch-file/);
  });
});

describe('ingress-nginx canaries', () => {
  it('splits traffic by weight and header, and rejects duplicate hosts', () => {
    const t = strategies();
    t.setup('kubectl create ingress shop --class=nginx --rule="shop.local/*=shop:80"');
    expect(t.run('kubectl create ingress dup --class=nginx --rule="shop.local/*=shop-v2:80"').err).toBe('Error from server (BadRequest): admission webhook "validate.nginx.ingress.kubernetes.io" denied the request: host "shop.local" and path "/" is already defined in ingress default/shop\n');
    t.setup('kubectl create ingress shop-canary --class=nginx --rule="shop.local/*=shop-v2:80" --annotation=nginx.ingress.kubernetes.io/canary=true --annotation=nginx.ingress.kubernetes.io/canary-weight=20 --annotation=nginx.ingress.kubernetes.io/canary-by-header=X-Canary');
    const out = t.run(`curl -s -H "Host: shop.local" ${Array(10).fill('localhost').join(' ')}`).out;
    expect(out.match(/shop v2/g)).toHaveLength(2);
    expect(out.match(/shop v1/g)).toHaveLength(8);
    expect(t.run('curl -s -H "Host: shop.local" -H "X-Canary: always" localhost').out).toBe('shop v2\n');
    expect(t.run('curl -s -H "Host: shop.local" -H "X-Canary: never" localhost localhost localhost localhost localhost').out).toBe('shop v1\n'.repeat(5));
    t.setup('kubectl annotate ingress shop-canary nginx.ingress.kubernetes.io/canary-weight=100 --overwrite');
    expect(t.run('curl -s -H "Host: shop.local" localhost localhost').out).toBe('shop v2\nshop v2\n');
  });

  it('kubectl rollout status honours --timeout', () => {
    const t = makeShell();
    t.setup('kubectl create deployment web --image=nginx:9.9.9');
    expect(t.run('kubectl rollout status deployment/web --timeout=20s')).toMatchObject({ code: 1, err: 'error: timed out waiting for the condition\n' });
  });
});

const GITOPS = 'https://github.com/acme/gitops.git';
const app = (tag: string, replicas = 2) => dep('shop', 'app: shop', `ghcr.io/acme/shop:${tag}`, replicas);

function argo() {
  const state = buildInitialState({
    argocd: true,
    gitHosted: [{ url: GITOPS, files: { 'apps/shop/deployment.yaml': app('1.0'), 'apps/shop/service.yaml': svc('shop', 'app: shop') } }],
    kubeImages: { 'ghcr.io/acme/shop:*': { listen: [8080], http: { '/': { body: 'shop {tag}\n' } } } },
    registryImages: ['ghcr.io/acme/shop:1.0', 'ghcr.io/acme/shop:1.1'],
    setup: [`git clone -q ${GITOPS}`],
  });
  const sh = createShell(state);
  const run = (line: string) => {
    const r = sh.run(line);
    return { out: r.output.filter((o) => o.stream === 'stdout').map((o) => o.text).join(''), err: r.output.filter((o) => o.stream === 'stderr').map((o) => o.text).join(''), code: r.exitCode };
  };
  return { state, run };
}

describe('Argo CD', () => {
  it('only exists once installed', () => {
    const t = makeShell();
    expect(t.run('kubectl get applications').err).toBe('error: the server doesn\'t have a resource type "applications"\n');
    expect(t.run('argocd app list').err).toContain('the server could not find the requested resource (get applications.argoproj.io)');
  });

  it('creates, syncs, auto-syncs, self-heals, prunes and rolls back through Git', () => {
    const { run } = argo();
    expect(run('kubectl get pods -n argocd').out).toMatch(/argocd-application-controller-0 +1\/1 +Running/);
    const bad = run('argocd app create shop --repo https://github.com/acme/gitops.git --path apps/shopp --dest-server https://kubernetes.default.svc --dest-namespace shop');
    expect(bad.code).toBe(20);
    expect(bad.err).toContain('apps/shopp: app path does not exist');
    expect(run('argocd app create shop --repo https://github.com/acme/gitops.git --path apps/shop --dest-server https://kubernetes.default.svc --dest-namespace shop').out).toBe("application 'shop' created\n");
    expect(run('argocd app list').out).toMatch(/argocd\/shop +https:\/\/kubernetes\.default\.svc +shop +default +OutOfSync +Missing +Manual +<none>/);
    const failed = run('argocd app sync shop');
    expect(failed.code).toBe(20);
    expect(failed.out).toContain('Message:            one or more objects failed to apply, reason: namespaces "shop" not found');
    run('argocd app set shop --sync-option CreateNamespace=true');
    const ok = run('argocd app sync shop');
    expect(ok.out).toMatch(/Phase: +Succeeded/);
    expect(ok.out).toMatch(/apps +Deployment +shop +shop +Synced +Progressing +deployment\.apps\/shop created/);
    expect(run('argocd app wait shop --health --timeout 120').code).toBe(0);
    expect(run('kubectl get applications -n argocd').out).toBe('NAME   SYNC STATUS   HEALTH STATUS\nshop   Synced        Healthy\n');
    run('argocd app set shop --sync-policy automated --auto-prune --self-heal');
    // Change through Git: picked up on the next poll.
    run('cd gitops');
    run("sed -i 's/replicas: 2/replicas: 3/; s/shop:1.0/shop:1.1/' apps/shop/deployment.yaml && git commit -qam 'shop 1.1' && git push -q");
    expect(run('argocd app get shop').out).toMatch(/Sync Status: +Synced to HEAD/);
    run('sleep 200');
    expect(run('kubectl get deploy shop -n shop -o jsonpath={.spec.replicas}').out).toBe('3');
    // Self-heal
    run('kubectl scale deploy shop -n shop --replicas=1');
    run('sleep 10');
    expect(run('kubectl get deploy shop -n shop -o jsonpath={.spec.replicas}').out).toBe('3');
    expect(run('argocd app history shop').out).toMatch(/^SOURCE +https:\/\/github\.com\/acme\/gitops\.git\nID +DATE +REVISION\n0 +2026/);
    expect(run('argocd app rollback shop 0').err).toContain('rollback cannot be initiated when auto-sync is enabled');
    // A tag that was never pushed: Synced but not Healthy; revert fixes it.
    run("sed -i 's/shop:1.1/shop:9.9/' apps/shop/deployment.yaml && git commit -qam oops && git push -q");
    run('argocd app get shop --refresh');
    run('sleep 30');
    expect(run('kubectl get applications -n argocd').out).toMatch(/shop +Synced +Progressing/);
    run('git revert --no-edit HEAD && git push -q');
    run('argocd app get shop --refresh');
    expect(run('argocd app wait shop --health --sync --timeout 120').code).toBe(0);
    // Prune
    run('git rm -q apps/shop/service.yaml && git commit -qm "drop svc" && git push -q');
    run('argocd app get shop --refresh');
    run('sleep 10');
    expect(run('kubectl get svc -n shop').err).toBe('No resources found in shop namespace.\n');
    expect(run('argocd app diff shop').code).toBe(0);
    expect(run('argocd app delete shop').err).toContain('confirm with --yes');
    run('argocd app delete shop --yes');
    expect(run('kubectl get deploy -n shop').err).toBe('No resources found in shop namespace.\n');
  });

  it('renders Helm charts from Git', () => {
    const { state, run } = argo();
    void state;
    run('cd gitops && helm create charts/web');
    run("git add -A && git commit -qm chart && git push -q");
    expect(run('argocd app create web --repo https://github.com/acme/gitops.git --path charts/web --dest-server https://kubernetes.default.svc --dest-namespace web --sync-option CreateNamespace=true --sync-policy automated --helm-set replicaCount=2').out).toBe("application 'web' created\n");
    run('argocd app get web --refresh');
    expect(run('argocd app wait web --health --timeout 120').code).toBe(0);
    expect(run('kubectl get deploy web -n web -o jsonpath={.spec.replicas}').out).toBe('2');
  });
});
