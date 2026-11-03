import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { humanDuration, memBytes, cpuMilli } from './quantity';
import { fullRef } from './images';
import { jsonPath } from './printers';

/** A shell whose cluster has a ready 2-replica nginx Deployment `web` and Service `web`. */
function withWeb() {
  const t = makeShell();
  t.setup('kubectl create deployment web --image=nginx:1.27 --replicas=2 --port=80', 'kubectl rollout status deployment/web', 'kubectl expose deployment web --port=80');
  return t;
}

function write(t: ReturnType<typeof makeShell>, path: string, text: string) {
  t.vfs().writeFile(path, text);
}

describe('helpers', () => {
  it('quantities, durations and image refs', () => {
    expect(cpuMilli('250m')).toBe(250);
    expect(cpuMilli('1.5')).toBe(1500);
    expect(memBytes('128Mi')).toBe(128 * 1024 ** 2);
    expect(memBytes('1G')).toBe(1e9);
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(150_000)).toBe('2m30s');
    expect(humanDuration(3 * 3600_000 + 5 * 60_000)).toBe('3h5m');
    expect(humanDuration(10 * 86400_000)).toBe('10d');
    expect(fullRef('nginx')).toBe('docker.io/library/nginx:latest');
    expect(fullRef('acme/api:1')).toBe('docker.io/acme/api:1');
    expect(fullRef('ghcr.io/acme/api:1')).toBe('ghcr.io/acme/api:1');
    expect(jsonPath('{.items[*].metadata.name}', { items: [{ metadata: { name: 'a' } }, { metadata: { name: 'b' } }] })).toBe('a b');
    expect(jsonPath('{range .items[*]}{.n}{"\\n"}{end}', { items: [{ n: 1 }, { n: 2 }] })).toBe('1\n2\n');
  });
});

describe('cluster basics', () => {
  it('has three nodes and running system pods', () => {
    const t = makeShell();
    expect(t.run('kubectl get nodes').out).toMatch(/^NAME +STATUS +ROLES +AGE +VERSION\ndevquest-control-plane +Ready +control-plane +10d +v1\.31\.2\n/);
    const sys = t.run('kubectl get pods -n kube-system').out;
    expect(sys).toMatch(/coredns-\w+-\w+ +1\/1 +Running +0/);
    expect(sys).toContain('etcd-devquest-control-plane');
    expect(t.run('kubectl get pods')).toMatchObject({ out: '', err: 'No resources found in default namespace.\n' });
    expect(t.run('kubectl version').out).toContain('Server Version: v1.31.2');
    expect(t.run('kubectl config current-context').out).toBe('kind-devquest\n');
  });

  it('reports kubectl usage errors like kubectl', () => {
    const t = makeShell();
    expect(t.run('kubectl get').err).toMatch(/^You must specify the type of resource to get\./);
    expect(t.run('kubectl get foo')).toMatchObject({ err: 'error: the server doesn\'t have a resource type "foo"\n', code: 1 });
    expect(t.run('kubectl get pod nope')).toMatchObject({ err: 'Error from server (NotFound): pods "nope" not found\n', code: 1 });
    expect(t.run('kubectl get deploy nope').err).toBe('Error from server (NotFound): deployments.apps "nope" not found\n');
    expect(t.run('kubectl get pods --bogus').err).toBe("error: unknown flag: --bogus\nSee 'kubectl get --help' for usage.\n");
    expect(t.run('kubectl cordon x').err).toMatch(/not simulated yet/);
  });

  it('is not installed inside containers', () => {
    const t = makeShell();
    t.setup('docker run -d --name web nginx');
    t.shell.run('docker exec -it web bash');
    expect(t.run('kubectl get pods').code).toBe(127);
  });
});

describe('deployments', () => {
  it('creates ReplicaSets and pods that become Running', () => {
    const t = makeShell();
    expect(t.run('kubectl create deployment web --image=nginx:1.27 --replicas=3').out).toBe('deployment.apps/web created\n');
    expect(t.run('kubectl get pods').out).toMatch(/web-\w{10}-\w{5} +0\/1 +ContainerCreating +0/);
    expect(t.run('kubectl rollout status deployment/web').out).toMatch(/deployment "web" successfully rolled out\n$/);
    expect(t.run('kubectl get deploy web').out).toMatch(/^NAME +READY +UP-TO-DATE +AVAILABLE +AGE\nweb +3\/3 +3 +3 +\d+s\n$/);
    const wide = t.run('kubectl get pods -o wide').out;
    expect(new Set([...wide.matchAll(/devquest-worker2?/g)].map((m) => m[0])).size).toBe(2); // spread over both workers
    expect(t.run('kubectl get rs').out).toMatch(/web-\w{10} +3 +3 +3/);
  });

  it('scales and heals', () => {
    const t = withWeb();
    t.setup('kubectl delete pod -l app=web');
    t.setup('kubectl rollout status deployment/web');
    expect(t.run('kubectl get pods --no-headers').out.trim().split('\n')).toHaveLength(2);
    expect(t.run('kubectl scale deploy/web --replicas=4').out).toBe('deployment.apps/web scaled\n');
    t.setup('kubectl rollout status deploy/web');
    expect(t.run('kubectl get deploy web -o jsonpath={.status.readyReplicas}').out).toBe('4');
  });

  it('rolling update, a stuck rollout and rollback', () => {
    const t = withWeb();
    expect(t.run('kubectl set image deploy/web nginx=nginx:9.9').out).toBe('deployment.apps/web image updated\n');
    t.setup('sleep 20');
    const pods = t.run('kubectl get pods').out;
    expect(pods).toMatch(/ImagePullBackOff|ErrImagePull/);
    expect((pods.match(/1\/1 +Running/g) ?? []).length).toBe(2); // old pods keep serving
    const st = t.shell.run('kubectl rollout status deploy/web');
    expect(st.exitCode).toBe(1);
    expect(st.output[0].text).toMatch(/^Waiting for deployment "web" rollout to finish: 1 out of 2 new replicas have been updated\.\.\./);
    expect(t.run('kubectl describe pod -l app=web').out).toContain('docker.io/library/nginx:9.9: not found');
    expect(t.run('kubectl rollout undo deploy/web').out).toBe('deployment.apps/web rolled back\n');
    expect(t.run('kubectl rollout status deploy/web').out).toMatch(/successfully rolled out/);
    expect(t.run('kubectl rollout history deploy/web').out).toMatch(/REVISION +CHANGE-CAUSE\n2 +<none>\n3 +<none>\n/);
    expect(t.run('kubectl get deploy web -o jsonpath={.spec.template.spec.containers[0].image}').out).toBe('nginx:1.27');
  });

  it('describe deployment', () => {
    const t = withWeb();
    const d = t.run('kubectl describe deployment web').out;
    expect(d).toMatch(/^Name: +web\nNamespace: +default\n/);
    expect(d).toContain('Replicas:               2 desired | 2 updated | 2 total | 2 available | 0 unavailable');
    expect(d).toContain('RollingUpdateStrategy:  25% max unavailable, 25% max surge');
    expect(d).toMatch(/NewReplicaSet: +web-\w+ \(2\/2 replicas created\)/);
    expect(d).toMatch(/ScalingReplicaSet .* Scaled up replica set web-\w+ from 0 to 2/);
  });
});

describe('pod failures', () => {
  it('CrashLoopBackOff with logs and --previous', () => {
    const t = makeShell();
    t.setup('kubectl create deployment db --image=postgres:17', 'sleep 40');
    const pods = t.run('kubectl get pods').out;
    expect(pods).toMatch(/db-\w+-\w+ +0\/1 +CrashLoopBackOff +\d+ \(\d+s ago\)/);
    expect(t.run('kubectl logs deploy/db').out).toMatch(/^Error: Database is uninitialized and superuser password is not specified\./);
    expect(t.run('kubectl logs deploy/db --previous').out).toContain('POSTGRES_PASSWORD');
    expect(t.run('kubectl describe pod -l app=db').out).toMatch(/Last State: +Terminated\n +Reason: +Error\n +Exit Code: +1/);
  });

  it('CreateContainerConfigError recovers once the ConfigMap exists', () => {
    const t = makeShell();
    write(t, '/home/student/p.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: p\nspec:\n  containers:\n  - name: c\n    image: nginx:1.27\n    envFrom:\n    - configMapRef:\n        name: cfg\n');
    t.setup('kubectl apply -f p.yaml', 'sleep 4');
    expect(t.run('kubectl get pod p').out).toContain('CreateContainerConfigError');
    expect(t.run('kubectl get events').out).toContain('Error: configmap "cfg" not found');
    t.setup('kubectl create configmap cfg --from-literal=A=1', 'sleep 2');
    expect(t.run('kubectl get pod p').out).toMatch(/p +1\/1 +Running/);
    expect(t.run('kubectl exec p -- printenv A').out).toBe('1\n');
  });

  it('Pending when nothing fits, OOMKilled over the limit', () => {
    const t = makeShell();
    t.setup('kubectl run big --image=nginx:1.27', 'kubectl set resources pod big --requests=memory=9Gi || true');
    write(t, '/home/student/b.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: huge\nspec:\n  containers:\n  - name: c\n    image: nginx:1.27\n    resources:\n      requests:\n        memory: 9Gi\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: hog\nspec:\n  containers:\n  - name: c\n    image: mysql:8.4\n    env:\n    - name: MYSQL_ROOT_PASSWORD\n      value: x\n    resources:\n      limits:\n        memory: 64Mi\n');
    t.setup('kubectl apply -f b.yaml', 'sleep 8');
    expect(t.run('kubectl get pod huge').out).toMatch(/huge +0\/1 +Pending/);
    expect(t.run('kubectl describe pod huge').out).toContain('0/3 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 Insufficient memory.');
    expect(t.run('kubectl describe pod hog').out).toMatch(/Reason: +OOMKilled\n +Exit Code: +137/);
  });

  it('probes: readiness keeps pods out of endpoints, liveness restarts them', () => {
    const t = makeShell();
    write(t, '/home/student/r.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: r\n  labels: {app: r}\nspec:\n  containers:\n  - name: web\n    image: nginx:1.27\n    readinessProbe:\n      httpGet: {path: /nope, port: 80}\n      periodSeconds: 2\n    livenessProbe:\n      httpGet: {path: /missing, port: 80}\n      periodSeconds: 2\n      failureThreshold: 2\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: r\nspec:\n  selector: {app: r}\n  ports:\n  - port: 80\n');
    t.setup('kubectl apply -f r.yaml', 'sleep 6');
    expect(t.run('kubectl get pod r').out).toMatch(/r +0\/1 +(Running|CrashLoopBackOff)/);
    expect(t.run('kubectl get endpoints r').out).toMatch(/r +<none>/);
    const d = t.run('kubectl describe pod r').out;
    expect(d).toContain('Readiness probe failed: HTTP probe failed with statuscode: 404');
    expect(d).toContain('Container web failed liveness probe, will be restarted');
  });

  it('ImagePullBackOff messages', () => {
    const t = makeShell();
    t.setup('kubectl run x --image=ngnix:1.27', 'sleep 5');
    expect(t.run('kubectl get pod x').out).toMatch(/ImagePullBackOff|ErrImagePull/);
    expect(t.run('kubectl describe pod x').out).toContain('pull access denied, repository does not exist or may require authorization');
    expect(t.run('kubectl logs x').err).toBe('Error from server (BadRequest): container "x" in pod "x" is waiting to start: trying and failing to pull image\n');
  });
});

describe('services and networking', () => {
  it('ClusterIP with endpoints, reachable from a pod by DNS name', () => {
    const t = withWeb();
    expect(t.run('kubectl get svc web').out).toMatch(/web +ClusterIP +10\.96\.\d+\.\d+ +<none> +80\/TCP/);
    expect(t.run('kubectl get endpoints web').out).toMatch(/web +10\.244\.\d+\.\d+:80,10\.244\.\d+\.\d+:80/);
    const r = t.run('kubectl run tmp --rm -it --image=curlimages/curl --restart=Never -- curl -s http://web.default.svc.cluster.local');
    expect(r.out).toContain('Welcome to nginx!');
    expect(r.out).toMatch(/pod "tmp" deleted/);
  });

  it('NodePort from the host and port-forward to localhost', () => {
    const t = withWeb();
    t.setup('kubectl create service nodeport np --tcp=80:80 --node-port=30080', 'kubectl label svc np x=y');
    // `create service` selects app=<name>: point it at the web pods.
    write(t, '/home/student/np.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: np\nspec:\n  type: NodePort\n  selector: {app: web}\n  ports:\n  - port: 80\n    nodePort: 30080\n');
    t.setup('kubectl apply -f np.yaml');
    expect(t.run('curl -s 172.18.0.4:30080').out).toContain('Welcome to nginx!');
    expect(t.run('kubectl port-forward svc/web 8080:80').out).toBe('Forwarding from 127.0.0.1:8080 -> 80\nForwarding from [::1]:8080 -> 80\n');
    expect(t.run('curl -s localhost:8080').out).toContain('Welcome to nginx!');
  });

  it('exec runs commands in the container and opens a shell', () => {
    const t = withWeb();
    expect(t.run('kubectl exec deploy/web -- cat /usr/share/nginx/html/index.html').out).toContain('<title>Welcome to nginx!</title>');
    expect(t.run('kubectl exec deploy/web ls')).toMatchObject({ code: 1, err: expect.stringContaining('exec [POD] [COMMAND] is not supported anymore') });
    expect(t.run('kubectl exec deploy/web -- false')).toMatchObject({ code: 1, err: 'command terminated with exit code 1\n' });
    t.setup('kubectl exec -it deploy/web -- bash');
    expect(t.run('hostname').out).toMatch(/^web-\w+-\w+\n$/);
    expect(t.run('curl -s web').out).toContain('Welcome to nginx!');
    t.setup('exit');
    expect(t.run('hostname').out).toBe('devquest\n');
  });

  it('ConfigMap volumes serve files; Secrets are base64', () => {
    const t = makeShell();
    write(t, '/home/student/s.yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: html\ndata:\n  index.html: hello from a configmap\n---\napiVersion: v1\nkind: Pod\nmetadata:\n  name: s\nspec:\n  containers:\n  - name: web\n    image: nginx:1.27\n    volumeMounts:\n    - name: h\n      mountPath: /usr/share/nginx/html\n  volumes:\n  - name: h\n    configMap:\n      name: html\n');
    t.setup('kubectl apply -f s.yaml', 'sleep 4', 'kubectl port-forward pod/s 9000:80');
    expect(t.run('curl -s localhost:9000').out).toBe('hello from a configmap');
    t.setup('kubectl create secret generic pw --from-literal=password=hunter2');
    expect(t.run('kubectl get secret pw -o jsonpath={.data.password}').out).toBe('aHVudGVyMg==');
    expect(t.run('kubectl describe secret pw').out).toContain('password:  7 bytes');
  });
});

describe('manifests', () => {
  it('strict field validation, YAML errors and selector checks', () => {
    const t = makeShell();
    write(t, '/home/student/a.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a\nspec:\n  selector:\n    matchLabels: {app: a}\n  template:\n    metadata:\n      labels: {app: a}\n    spec:\n      containers:\n      - name: a\n        image: nginx\n        imagePullPolice: Always\n');
    expect(t.run('kubectl apply -f a.yaml').err).toBe('Error from server (BadRequest): error when creating "a.yaml": Deployment in version "v1" cannot be handled as a Deployment: strict decoding error: unknown field "spec.template.spec.containers[0].imagePullPolice"\n');
    write(t, '/home/student/b.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: b\nspec:\n  selector:\n    matchLabels: {app: b}\n  template:\n    metadata:\n      labels: {app: x}\n    spec:\n      containers:\n      - name: b\n        image: nginx\n');
    expect(t.run('kubectl apply -f b.yaml').err).toBe('The Deployment "b" is invalid: spec.template.metadata.labels: Invalid value: map[string]string{"app":"x"}: `selector` does not match template `labels`\n');
    write(t, '/home/student/c.yaml', 'apiVersion: v1\nkind: Deployment\nmetadata:\n  name: c\n');
    expect(t.run('kubectl apply -f c.yaml').err).toMatch(/no matches for kind "Deployment" in version "v1"/);
    write(t, '/home/student/d.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: d\n spec: x\n');
    expect(t.run('kubectl apply -f d.yaml').err).toBe('error: error parsing d.yaml: error converting YAML to JSON: yaml: line 5: mapping values are not allowed in this context\n');
    expect(t.run('kubectl apply -f nope.yaml').err).toBe('error: the path "nope.yaml" does not exist\n');
  });

  it('apply is idempotent and reports created / configured / unchanged', () => {
    const t = makeShell();
    write(t, '/home/student/w.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: w\nspec:\n  replicas: 1\n  selector:\n    matchLabels: {app: w}\n  template:\n    metadata:\n      labels: {app: w}\n    spec:\n      containers:\n      - name: w\n        image: nginx:1.27\n');
    expect(t.run('kubectl apply -f w.yaml').out).toBe('deployment.apps/w created\n');
    expect(t.run('kubectl apply -f w.yaml').out).toBe('deployment.apps/w unchanged\n');
    t.setup("sed -i 's/replicas: 1/replicas: 2/' w.yaml");
    expect(t.run('kubectl apply -f w.yaml').out).toBe('deployment.apps/w configured\n');
    expect(t.run('kubectl create -f w.yaml').err).toBe('Error from server (AlreadyExists): error when creating "w.yaml": deployments.apps "w" already exists\n');
    expect(t.run('kubectl delete -f w.yaml').out).toBe('deployment.apps "w" deleted\n');
  });

  it('dry-run YAML matches kubectl', () => {
    const t = makeShell();
    expect(t.run('kubectl run tmp --image=busybox --dry-run=client -o yaml').out).toBe(
      'apiVersion: v1\nkind: Pod\nmetadata:\n  creationTimestamp: null\n  labels:\n    run: tmp\n  name: tmp\nspec:\n  containers:\n  - image: busybox\n    name: tmp\n    resources: {}\n  dnsPolicy: ClusterFirst\n  restartPolicy: Always\nstatus: {}\n',
    );
    expect(t.run('kubectl create deployment web --image=nginx:1.27 --dry-run=client -o yaml').out).toContain('      containers:\n      - image: nginx:1.27\n        name: nginx\n');
  });

  it('get -o yaml / name / custom-columns, labels and namespaces', () => {
    const t = withWeb();
    expect(t.run('kubectl get deploy web -o yaml').out).toMatch(/^apiVersion: apps\/v1\nkind: Deployment\nmetadata:\n/);
    expect(t.run('kubectl get deploy web -o yaml').out).toMatch(/creationTimestamp: "2026-11-03T09:00:\d\dZ"/);
    expect(t.run('kubectl get deploy,svc -o name').out).toBe('deployment.apps/web\nservice/kubernetes\nservice/web\n');
    expect(t.run('kubectl get pods -o custom-columns=NAME:.metadata.name,IMAGE:.spec.containers[0].image').out).toMatch(/^NAME +IMAGE\nweb-\w+-\w+ +nginx:1\.27\n/);
    expect(t.run('kubectl label deploy web tier=frontend').out).toBe('deployment.apps/web labeled\n');
    expect(t.run('kubectl label deploy web tier=backend').err).toBe("error: 'tier' already has a value (frontend), and --overwrite is false\n");
    expect(t.run('kubectl get deploy -l tier=frontend -o name').out).toBe('deployment.apps/web\n');
    t.setup('kubectl create namespace team-a', 'kubectl create deployment api --image=nginx:1.27 -n team-a');
    expect(t.run('kubectl get deploy -n team-a -o name').out).toBe('deployment.apps/api\n');
    expect(t.run('kubectl get deploy -A').out).toMatch(/^NAMESPACE +NAME/);
    t.setup('kubectl config set-context --current --namespace=team-a');
    expect(t.run('kubectl get deploy -o name').out).toBe('deployment.apps/api\n');
  });

  it('jobs run to completion', () => {
    const t = makeShell();
    t.setup('kubectl create job hello --image=busybox -- sh -c "echo hi from a job"', 'sleep 5');
    expect(t.run('kubectl get jobs').out).toMatch(/hello +Complete +1\/1/);
    expect(t.run('kubectl logs job/hello').out).toBe('hi from a job\n');
  });
});
