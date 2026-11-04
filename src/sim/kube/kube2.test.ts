import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { parseCron, scheduleTimes } from './cron';

type T = ReturnType<typeof makeShell>;
const write = (t: T, name: string, text: string) => t.vfs().writeFile(`/home/student/${name}`, text);

const PVC_POD = `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: writer
spec:
  containers:
  - name: c
    image: busybox
    command: ["sh", "-c", "echo hello > /data/f; sleep 3600"]
    volumeMounts:
    - name: d
      mountPath: /data
  volumes:
  - name: d
    persistentVolumeClaim:
      claimName: data
`;

const sts = (replicas: number, extra = '') => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db
  replicas: ${replicas}
  selector:
    matchLabels: {app: db}
  template:
    metadata:
      labels: {app: db}
    spec:
      containers:
      - name: db
        image: redis:7
        volumeMounts:
        - name: data
          mountPath: /data
  volumeClaimTemplates:
  - metadata:
      name: data
    spec:
${extra}      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 1Gi
`;

describe('cron schedules', () => {
  it('parses fields, ranges, steps and macros', () => {
    expect(parseCron('*/15 * * * *')!.minute).toEqual(new Set([0, 15, 30, 45]));
    expect(parseCron('0 2 * * 1-5')!.dow).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(parseCron('@daily')!.hour).toEqual(new Set([0]));
    expect(parseCron('61 * * * *')).toBeNull();
    expect(parseCron('* * *')).toBeNull();
    const t0 = Date.UTC(2026, 10, 3, 9, 0, 0);
    expect(scheduleTimes(parseCron('*/5 * * * *')!, t0, t0 + 16 * 60000).map((t) => new Date(t).getUTCMinutes())).toEqual([5, 10, 15]);
  });
});

describe('persistent storage', () => {
  it('binds a WaitForFirstConsumer claim when a pod uses it, and keeps the data', () => {
    const t = makeShell();
    write(t, 'pvc.yaml', PVC_POD.split('---')[0]);
    t.run('kubectl apply -f pvc.yaml');
    expect(t.run('kubectl get pvc').out).toMatch(/^data +Pending +standard +<unset> +\d+s\n/m);
    expect(t.run('kubectl describe pvc data').out).toContain('waiting for first consumer to be created before binding');
    write(t, 'all.yaml', PVC_POD);
    t.setup('kubectl apply -f all.yaml', 'sleep 10');
    expect(t.run('kubectl get pvc').out).toMatch(/^data +Bound +pvc-[0-9a-f-]{36} +1Gi +RWO +standard +<unset> +\d+s\n/m);
    expect(t.run('kubectl get pv').out).toMatch(/pvc-[0-9a-f-]+ +1Gi +RWO +Delete +Bound +default\/data +standard/);
    expect(t.run('kubectl exec writer -- cat /data/f').out).toBe('hello\n');
    // A new pod on the same claim sees the same files.
    t.setup('kubectl delete pod writer', 'sleep 5');
    write(t, 'reader.yaml', PVC_POD.split('---')[1].replace('writer', 'reader').replace('echo hello > /data/f; sleep 3600', 'sleep 3600'));
    t.setup('kubectl apply -f reader.yaml', 'sleep 10');
    expect(t.run('kubectl exec reader -- cat /data/f').out).toBe('hello\n');
  });

  it('reports a missing StorageClass and access modes local-path cannot provide', () => {
    const t = makeShell();
    write(t, 'c.yaml', PVC_POD.replace('spec:\n  accessModes: [ReadWriteOnce]', 'spec:\n  storageClassName: fast-ssd\n  accessModes: [ReadWriteOnce]'));
    t.setup('kubectl apply -f c.yaml', 'sleep 10');
    expect(t.run('kubectl describe pvc data').out).toMatch(/Warning +ProvisioningFailed .*storageclass\.storage\.k8s\.io "fast-ssd" not found/);
    expect(t.run('kubectl describe pod writer').out).toMatch(/FailedScheduling .*0\/3 nodes are available: pod has unbound immediate PersistentVolumeClaims/);
    const u = makeShell();
    write(u, 'c.yaml', PVC_POD.replace('[ReadWriteOnce]', '[ReadWriteMany]'));
    u.setup('kubectl apply -f c.yaml', 'sleep 10');
    expect(u.run('kubectl describe pvc data').out).toContain('Only support ReadWriteOnce access mode');
    expect(u.run('kubectl get pod writer').out).toMatch(/writer +0\/1 +Pending/);
  });

  it('keeps a claim that is in use Terminating until its pod is gone', () => {
    const t = makeShell();
    write(t, 'all.yaml', PVC_POD);
    t.setup('kubectl apply -f all.yaml', 'sleep 10');
    expect(t.run('kubectl delete pvc data').out).toBe('persistentvolumeclaim "data" deleted\n');
    expect(t.run('kubectl get pvc').out).toMatch(/^data +Terminating/m);
    t.setup('kubectl delete pod writer', 'sleep 5');
    expect(t.run('kubectl get pvc')).toMatchObject({ out: '', err: 'No resources found in default namespace.\n' });
    expect(t.run('kubectl get pv').err).toBe('No resources found\n');
  });

  it('validates claims', () => {
    const t = makeShell();
    write(t, 'bad.yaml', 'apiVersion: v1\nkind: PersistentVolumeClaim\nmetadata:\n  name: x\nspec:\n  resources:\n    requests:\n      storage: 1Gi\n');
    expect(t.run('kubectl apply -f bad.yaml').err).toContain('spec.accessModes: Required value');
  });
});

describe('StatefulSets', () => {
  it('creates ordered pods with their own claims and scales down from the top', () => {
    const t = makeShell();
    write(t, 's.yaml', sts(3));
    expect(t.run('kubectl apply -f s.yaml').out).toBe('statefulset.apps/db created\n');
    const status = t.run('kubectl rollout status statefulset/db').out;
    expect(status).toContain('Waiting for 3 pods to be ready...');
    expect(status).toMatch(/statefulset rolling update complete 3 pods at revision db-\w+\.\.\.\n$/);
    expect(t.run('kubectl get sts').out).toMatch(/^db +3\/3 +\d+s\n/m);
    const pods = t.run('kubectl get pods').out;
    expect(pods).toMatch(/db-0 +1\/1 +Running/);
    expect(pods).toMatch(/db-2 +1\/1 +Running/);
    expect(t.run('kubectl get pvc -o name').out).toBe('persistentvolumeclaim/data-db-0\npersistentvolumeclaim/data-db-1\npersistentvolumeclaim/data-db-2\n');
    expect(t.run('kubectl describe sts db').out).toContain('create Claim data-db-0 Pod db-0 in StatefulSet db success');
    expect(t.run('kubectl scale statefulset db --replicas=1').out).toBe('statefulset.apps/db scaled\n');
    t.setup('sleep 60');
    expect(t.run('kubectl get pods -o name').out).toBe('pod/db-0\n');
    expect(t.run('kubectl get pvc data-db-2').out).toMatch(/data-db-2 +Bound/);
  });

  it('requires mounts to name a volume or a claim template, and keeps templates immutable', () => {
    const t = makeShell();
    write(t, 's.yaml', sts(1).replace('- name: data\n          mountPath', '- name: nope\n          mountPath'));
    expect(t.run('kubectl apply -f s.yaml').err).toContain('spec.template.spec.containers[0].volumeMounts[0].name: Not found: "nope"');
    write(t, 's.yaml', sts(1));
    t.setup('kubectl apply -f s.yaml');
    write(t, 's.yaml', sts(1, '      storageClassName: other\n'));
    expect(t.run('kubectl apply -f s.yaml').err).toMatch(/^The StatefulSet "db" is invalid: spec: Forbidden: updates to statefulset spec for fields other than/);
  });
});

describe('CronJobs', () => {
  it('runs Jobs on schedule and on demand', () => {
    const t = makeShell();
    expect(t.run('kubectl create cronjob tick --image=busybox --schedule="*/1 * * * *" -- echo tick').out).toBe('cronjob.batch/tick created\n');
    expect(t.run('kubectl get cronjob').out).toMatch(/^tick +\*\/1 \* \* \* \* +<none> +False +0 +<none> +\d+s\n/m);
    t.setup('sleep 200');
    const jobs = t.run('kubectl get jobs').out;
    expect(jobs.match(/tick-\d+ +Complete +1\/1/g)).toHaveLength(3);
    expect(t.run('kubectl create job manual --from=cronjob/tick').out).toBe('job.batch/manual created\n');
    t.setup('sleep 10');
    expect(t.run('kubectl logs job/manual').out).toBe('tick\n');
    expect(t.run('kubectl create job x --from=cronjob/nope').err).toContain('cronjobs.batch "nope" not found');
    expect(t.run('kubectl create cronjob y --image=busybox').err).toBe('error: required flag(s) "schedule" not set\n');
  });
});

describe('HorizontalPodAutoscaler', () => {
  it('needs CPU requests, then scales with load and back down after stabilization', () => {
    const t = makeShell();
    t.setup('kubectl create deployment web --image=nginx:1.27', 'kubectl expose deployment web --port=80');
    expect(t.run('kubectl autoscale deployment web --cpu-percent=50 --min=1 --max=5').out).toBe('horizontalpodautoscaler.autoscaling/web autoscaled\n');
    t.setup('sleep 30');
    expect(t.run('kubectl get hpa').out).toMatch(/web +Deployment\/web +cpu: <unknown>\/50% +1 +5 +1/);
    expect(t.run('kubectl describe hpa web').out).toMatch(/FailedGetResourceMetric .*missing request for cpu in container nginx of Pod web-/);
    t.setup('kubectl set resources deployment web --requests=cpu=100m', `kubectl run load --image=busybox -- sh -c "while true; do wget -q -O- http://web; done"`, 'sleep 120');
    expect(t.run('kubectl get hpa').out).toMatch(/web +Deployment\/web +cpu: \d+%\/50% +1 +5 +5/);
    expect(t.run('kubectl describe hpa web').out).toMatch(/SuccessfulRescale +\S+ +horizontal-pod-autoscaler +New size: 5; reason: cpu resource utilization \(percentage of request\) above target/);
    expect(t.run('kubectl describe hpa web').out).toMatch(/ScalingLimited +True +TooManyReplicas/);
    t.setup('kubectl delete pod load', 'sleep 120');
    expect(t.run('kubectl get deploy web -o jsonpath={.spec.replicas}').out).toBe('5');
    t.setup('sleep 300');
    expect(t.run('kubectl get deploy web -o jsonpath={.spec.replicas}').out).toBe('1');
  });

  it('refuses bad autoscale requests', () => {
    const t = makeShell();
    t.setup('kubectl create deployment web --image=nginx:1.27');
    expect(t.run('kubectl autoscale deployment web').err).toBe('error: --max=MAXPODS is required and must be at least 1, max: -1\n');
    expect(t.run('kubectl autoscale deployment web --min=5 --max=2').err).toContain('must be larger or equal to --min');
    t.setup('kubectl autoscale deployment web --max=3');
    expect(t.run('kubectl autoscale deployment web --max=3').err).toBe('Error from server (AlreadyExists): horizontalpodautoscalers.autoscaling "web" already exists\n');
  });

  it('kubectl top follows the simulated load and needs metrics-server', () => {
    const t = makeShell();
    t.setup('kubectl create deployment web --image=nginx:1.27', 'kubectl expose deployment web --port=80', `kubectl run load --image=busybox -- sh -c "while true; do curl -s http://web; done"`, 'sleep 20');
    expect(t.run('kubectl top pods').out).toMatch(/web-\S+ +601m/);
    t.setup('kubectl scale deployment metrics-server -n kube-system --replicas=0', 'sleep 40');
    expect(t.run('kubectl top pods').err).toBe('error: Metrics API not available\n');
  });
});

describe('node maintenance and taints', () => {
  it('cordons, refuses unsafe drains, drains and uncordons', () => {
    const t = makeShell();
    t.setup('kubectl create deployment web --image=nginx:1.27 --replicas=4', 'kubectl rollout status deploy/web');
    expect(t.run('kubectl cordon devquest-worker').out).toBe('node/devquest-worker cordoned\n');
    expect(t.run('kubectl cordon devquest-worker').out).toBe('node/devquest-worker already cordoned\n');
    expect(t.run('kubectl get nodes').out).toMatch(/devquest-worker +Ready,SchedulingDisabled/);
    const refused = t.run('kubectl drain devquest-worker');
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/^error: unable to drain node "devquest-worker" due to error: \[cannot delete DaemonSet-managed Pods \(use --ignore-daemonsets to ignore\): kube-system\/kindnet-\w+, kube-system\/kube-proxy-\w+\], continuing command\.\.\.\nThere are pending nodes to be drained:\n devquest-worker\n/);
    const r = t.run('kubectl drain devquest-worker --ignore-daemonsets');
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/^Warning: ignoring DaemonSet-managed Pods: kube-system\/kindnet-\w+, kube-system\/kube-proxy-\w+\n$/);
    expect(r.out).toMatch(/^node\/devquest-worker already cordoned\n(evicting pod \S+\n)+(pod\/\S+ evicted\n)+node\/devquest-worker drained\n$/);
    expect(t.run('kubectl get pods -o wide').out).not.toMatch(/devquest-worker +</);
    expect(t.run('kubectl get deploy web').out).toMatch(/web +4\/4/);
    expect(t.run('kubectl uncordon devquest-worker').out).toBe('node/devquest-worker uncordoned\n');
  });

  it('refuses to drain bare pods without --force', () => {
    const t = makeShell();
    write(t, 'p.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: bare\nspec:\n  nodeName: devquest-worker\n  containers:\n  - name: c\n    image: nginx:1.27\n');
    t.setup('kubectl apply -f p.yaml', 'sleep 5');
    expect(t.run('kubectl drain devquest-worker --ignore-daemonsets').err).toContain('cannot delete Pods declare no controller (use --force to override): default/bare');
    const r = t.run('kubectl drain devquest-worker --ignore-daemonsets --force');
    expect(r.err).toContain('deleting Pods that declare no controller: default/bare');
    expect(r.out).toContain('pod/bare evicted');
  });

  it('taints repel, tolerations admit, NoExecute evicts', () => {
    const t = makeShell();
    expect(t.run('kubectl taint nodes devquest-worker2 gpu=true:NoSchedule').out).toBe('node/devquest-worker2 tainted\n');
    expect(t.run('kubectl taint nodes devquest-worker2 gpu=true:NoSchedule').err).toBe('error: node devquest-worker2 already has gpu taint(s) with same effect(s) and --overwrite is false\n');
    expect(t.run('kubectl taint nodes devquest-worker2 gpu=true:Sometimes').err).toBe('error: invalid taint effect: Sometimes, unsupported taint effect\n');
    expect(t.run('kubectl describe node devquest-worker2').out).toMatch(/Taints: +gpu=true:NoSchedule/);
    t.setup('kubectl create deployment web --image=nginx:1.27 --replicas=4', 'kubectl rollout status deploy/web');
    expect(t.run('kubectl get pods -o wide').out).not.toContain('devquest-worker2');
    expect(t.run('kubectl taint nodes devquest-worker2 gpu-').out).toBe('node/devquest-worker2 untainted\n');
    expect(t.run('kubectl taint nodes devquest-worker2 gpu-').err).toBe('error: taint "gpu" not found\n');
    // NoExecute: running pods without a toleration are evicted.
    t.setup('kubectl scale deploy web --replicas=0', 'sleep 40', 'kubectl taint nodes devquest-worker dedicated=infra:NoSchedule', 'kubectl scale deploy web --replicas=2', 'kubectl rollout status deploy/web');
    expect(t.run('kubectl get pods -o wide').out).toMatch(/devquest-worker2/);
    t.setup('kubectl taint nodes devquest-worker dedicated- ', 'kubectl taint nodes devquest-worker2 maint=now:NoExecute', 'sleep 30');
    const pods = t.run('kubectl get pods -o wide').out;
    expect(pods).not.toMatch(/devquest-worker2/);
    expect(pods).toMatch(/web-\S+ +1\/1 +Running .*devquest-worker /);
  });
});

describe('RBAC', () => {
  it('answers can-i, enforces --as, and prints Forbidden like the API server', () => {
    const t = makeShell();
    t.setup('kubectl create deployment web --image=nginx:1.27');
    expect(t.run('kubectl create serviceaccount ci').out).toBe('serviceaccount/ci created\n');
    expect(t.run('kubectl create role deployer --verb=get,list,create --resource=pods,deployments.apps').out).toBe('role.rbac.authorization.k8s.io/deployer created\n');
    expect(t.run('kubectl create rolebinding ci-deployer --role=deployer --serviceaccount=default:ci').out).toBe('rolebinding.rbac.authorization.k8s.io/ci-deployer created\n');
    const as = '--as=system:serviceaccount:default:ci';
    expect(t.run(`kubectl auth can-i create deployments ${as}`)).toMatchObject({ out: 'yes\n', code: 0 });
    expect(t.run(`kubectl auth can-i delete deployments ${as}`)).toMatchObject({ out: 'no\n', code: 1 });
    expect(t.run(`kubectl auth can-i list pods -n kube-system ${as}`).out).toBe('no\n');
    expect(t.run(`kubectl get svc ${as}`).err).toBe('Error from server (Forbidden): services is forbidden: User "system:serviceaccount:default:ci" cannot list resource "services" in API group "" in the namespace "default"\n');
    expect(t.run(`kubectl delete deploy web ${as}`).err).toBe('Error from server (Forbidden): deployments.apps "web" is forbidden: User "system:serviceaccount:default:ci" cannot delete resource "deployments" in API group "apps" in the namespace "default"\n');
    expect(t.run('kubectl get nodes --as=jane').err).toBe('Error from server (Forbidden): nodes is forbidden: User "jane" cannot list resource "nodes" in API group "" at the cluster scope\n');
    expect(t.run(`kubectl logs deploy/web ${as}`).err).toContain('cannot get resource "pods/log" in API group "" in the namespace "default"');
    expect(t.run('kubectl auth whoami').out).toBe('ATTRIBUTE   VALUE\nUsername    kubernetes-admin\nGroups      [kubeadm:cluster-admins system:authenticated]\n');
    expect(t.run(`kubectl auth can-i --list ${as}`).out).toMatch(/^Resources +Non-Resource URLs +Resource Names +Verbs\npods +\[\] +\[\] +\[get list create\]\ndeployments\.apps +\[\] +\[\] +\[get list create\]\n/);
    expect(t.run('kubectl describe role deployer').out).toContain('  deployments.apps  []                 []              [get list create]\n');
  });

  it('checks apply against get/create/patch and keeps roleRef immutable', () => {
    const t = makeShell();
    t.setup('kubectl create namespace apps', 'kubectl create rolebinding view -n apps --clusterrole=view --user=bob');
    write(t, 'd.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: apps\nspec:\n  selector:\n    matchLabels: {app: web}\n  template:\n    metadata:\n      labels: {app: web}\n    spec:\n      containers:\n      - name: web\n        image: nginx:1.27\n');
    expect(t.run('kubectl apply -f d.yaml --as=bob').err).toBe('Error from server (Forbidden): error when creating "d.yaml": deployments.apps is forbidden: User "bob" cannot create resource "deployments" in API group "apps" in the namespace "apps"\n');
    expect(t.run('kubectl apply -f d.yaml --as=nobody').err).toMatch(/^Error from server \(Forbidden\): error when retrieving current configuration of:\nResource: "apps\/v1, Resource=deployments"/);
    write(t, 'rb.yaml', 'apiVersion: rbac.authorization.k8s.io/v1\nkind: RoleBinding\nmetadata:\n  name: view\n  namespace: apps\nroleRef:\n  apiGroup: rbac.authorization.k8s.io\n  kind: ClusterRole\n  name: edit\nsubjects:\n- kind: User\n  name: bob\n');
    expect(t.run('kubectl apply -f rb.yaml').err).toContain('cannot change roleRef');
    t.setup('kubectl delete rolebinding view -n apps', 'kubectl apply -f rb.yaml');
    expect(t.run('kubectl apply -f d.yaml --as=bob').out).toBe('deployment.apps/web created\n');
    expect(t.run('kubectl create role r --verb=fly --resource=pods').err).toBe("error: invalid verb: 'fly'\n");
    expect(t.run('kubectl create rolebinding b --user=x').err).toBe('error: exactly one of clusterrole or role must be specified\n');
    expect(t.run('kubectl create rolebinding b --role=r --serviceaccount=ci').err).toBe('error: serviceaccount must be <namespace>:<name>\n');
    expect(t.run('kubectl get pods --as-group=x').err).toContain('without impersonating a user');
  });

  it('gives every namespace a default ServiceAccount', () => {
    const t = makeShell();
    t.setup('kubectl create namespace team');
    expect(t.run('kubectl get sa -n team').out).toMatch(/^NAME +SECRETS +AGE\ndefault +0 +\d+s\n$/);
  });
});

const app = (name: string, image: string) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels: {app: ${name}}
spec:
  selector:
    matchLabels: {app: ${name}}
  template:
    metadata:
      labels: {app: ${name}}
    spec:
      containers:
      - name: ${name}
        image: ${image}
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  selector: {app: ${name}}
  ports:
  - port: 80
`;

describe('Ingress', () => {
  it('routes by host and path through ingress-nginx on port 80', () => {
    const t = makeShell();
    write(t, 'a.yaml', app('web', 'nginx:1.27'));
    t.setup('kubectl apply -f a.yaml', 'kubectl rollout status deploy/web');
    expect(t.run('curl -s localhost').out).toContain('<title>404 Not Found</title>');
    expect(t.run('kubectl create ingress shop --class=nginx --rule="shop.local/*=web:80" --rule="shop.local/api*=api:80"').out).toBe('ingress.networking.k8s.io/shop created\n');
    expect(t.run('kubectl get ingress').out).toMatch(/^shop +nginx +shop\.local +localhost +80 +\d+s\n/m);
    expect(t.run('curl -s -H "Host: shop.local" localhost').out).toContain('Welcome to nginx!');
    expect(t.run('curl -s -H "Host: shop.local" localhost/api').out).toContain('503 Service Temporarily Unavailable');
    expect(t.run('curl -s shop.local')).toMatchObject({ code: 6 });
    t.setup('echo "127.0.0.1 shop.local" | sudo tee -a /etc/hosts');
    expect(t.run('curl -s shop.local').out).toContain('Welcome to nginx!');
    expect(t.run('curl -sI -H "Host: other.local" localhost').out).toMatch(/^HTTP\/1\.1 404 Not Found\n/);
    expect(t.run('kubectl describe ingress shop').out).toMatch(/shop\.local\n +\/ +web:80 \(10\.244\.\d+\.\d+:80\)\n +\/api +api:80 \(<error: endpoints "api" not found>\)/);
  });

  it('ignores Ingresses of other classes and matches Exact paths exactly', () => {
    const t = makeShell();
    write(t, 'a.yaml', app('web', 'nginx:1.27'));
    t.setup('kubectl apply -f a.yaml', 'kubectl rollout status deploy/web', 'kubectl create ingress a --class=traefik --rule="a.local/*=web:80"');
    expect(t.run('kubectl get ingress a').out).toMatch(/^a +traefik +a\.local +80 /m);
    expect(t.run('curl -s -H "Host: a.local" localhost').out).toContain('404 Not Found');
    t.setup('kubectl create ingress b --class=nginx --rule="b.local/exact=web:80"');
    expect(t.run('curl -s -H "Host: b.local" localhost/exact/more').out).toContain('404 Not Found');
    expect(t.run('kubectl create ingress c --rule="nope"').err).toContain('should be in format host/path=svcname:svcport');
  });
});

describe('NetworkPolicy', () => {
  it('isolates selected pods and allows only matching peers', () => {
    const t = makeShell();
    write(t, 'a.yaml', app('web', 'nginx:1.27'));
    t.setup('kubectl apply -f a.yaml', 'kubectl rollout status deploy/web', 'kubectl create ingress shop --class=nginx --rule="shop.local/*=web:80"');
    const fromPod = (labels: string) => t.run(`kubectl run t --rm -i --restart=Never --labels=${labels} --image=curlimages/curl -- curl -s -m 3 http://web`);
    expect(fromPod('app=client').out).toContain('Welcome to nginx!');
    write(t, 'deny.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: default-deny\nspec:\n  podSelector: {}\n  policyTypes: [Ingress]\n');
    t.setup('kubectl apply -f deny.yaml');
    expect(fromPod('app=client')).toMatchObject({ code: 1 });
    expect(t.run('curl -s -H "Host: shop.local" localhost').out).toContain('504 Gateway Time-out');
    write(t, 'allow.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: allow\nspec:\n  podSelector:\n    matchLabels: {app: web}\n  ingress:\n  - from:\n    - podSelector:\n        matchLabels: {role: frontend}\n    - namespaceSelector:\n        matchLabels:\n          kubernetes.io/metadata.name: ingress-nginx\n    ports:\n    - port: 80\n');
    t.setup('kubectl apply -f allow.yaml');
    expect(fromPod('role=frontend').out).toContain('Welcome to nginx!');
    expect(fromPod('app=client')).toMatchObject({ code: 1 });
    expect(t.run('curl -s -H "Host: shop.local" localhost').out).toContain('Welcome to nginx!');
    expect(t.run('kubectl get netpol').out).toMatch(/^allow +app=web +\d+s\ndefault-deny +<none> +\d+s\n/m);
    expect(t.run('kubectl describe netpol allow').out).toContain('    From:\n      PodSelector: role=frontend\n    ----------\n      NamespaceSelector: kubernetes.io/metadata.name=ingress-nginx\n');
  });

  it('egress isolation blocks DNS unless it is allowed', () => {
    const t = makeShell();
    write(t, 'a.yaml', app('web', 'nginx:1.27'));
    t.setup('kubectl apply -f a.yaml', 'kubectl rollout status deploy/web');
    write(t, 'eg.yaml', 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: no-egress\nspec:\n  podSelector:\n    matchLabels: {app: locked}\n  policyTypes: [Egress]\n');
    t.setup('kubectl apply -f eg.yaml');
    const r = t.run('kubectl run t --rm -i --restart=Never --labels=app=locked --image=curlimages/curl -- curl -sS -m 3 http://web');
    expect(r.out).toContain('curl: (6) Could not resolve host: web');
  });
});
