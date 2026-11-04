import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { applySet, coalesce } from './chart';
import { TemplateSet } from './exec';
import { goFloat } from './funcs';

/** Render one template (plus optional helpers) with `.Values`. */
function tpl(src: string, values: unknown = {}, helpers = ''): string {
  const set = new TemplateSet();
  if (helpers) set.add('c/templates/_helpers.tpl', helpers);
  set.add('c/templates/t.yaml', src);
  return set.render('c/templates/t.yaml', { Values: values, Release: { Name: 'rel', Namespace: 'default', Service: 'Helm' }, Chart: { Name: 'c', Version: '0.1.0', AppVersion: '1.0' } });
}

describe('Go templates', () => {
  it('prints values, trims whitespace and drops comments', () => {
    expect(tpl('a: {{ .Values.a }}\nb: {{ .Values.missing }}', { a: 1 })).toBe('a: 1\nb: ');
    expect(tpl('x:\n  {{- /* note */ -}}\n  y', {})).toBe('x:y');
    expect(tpl('{{ .Release.Name }}-{{ .Chart.Name }}')).toBe('rel-c');
    expect(tpl('{{ "a" }}{{ `b` }}{{ 3 }}{{ true }}{{ nil }}')).toBe('ab3true<nil>');
    expect(goFloat(1000000)).toBe('1e+06');
    expect(goFloat(8080)).toBe('8080');
    expect(goFloat(0.5)).toBe('0.5');
  });

  it('supports if/else if/else, with, range and variables', () => {
    const src = '{{ if eq .Values.env "prod" }}P{{ else if eq .Values.env "dev" }}D{{ else }}?{{ end }}';
    expect(tpl(src, { env: 'prod' })).toBe('P');
    expect(tpl(src, { env: 'dev' })).toBe('D');
    expect(tpl(src, { env: 'qa' })).toBe('?');
    expect(tpl('{{ with .Values.db }}{{ .host }}:{{ .port }}{{ else }}none{{ end }}', { db: { host: 'pg', port: 5432 } })).toBe('pg:5432');
    expect(tpl('{{ with .Values.db }}x{{ else }}none{{ end }}', {})).toBe('none');
    expect(tpl('{{ range $i, $p := .Values.ports }}{{ $i }}={{ $p }} {{ end }}', { ports: [80, 443] })).toBe('0=80 1=443 ');
    expect(tpl('{{ range $k, $v := .Values.m }}{{ $k }}:{{ $v }};{{ end }}', { m: { b: 2, a: 1 } })).toBe('a:1;b:2;');
    expect(tpl('{{ range .Values.l }}{{ . }}{{ else }}empty{{ end }}', { l: [] })).toBe('empty');
    expect(tpl('{{ $x := "a" }}{{ $x = "b" }}{{ $x }}{{ range .Values.l }}{{ $.Release.Name }}{{ end }}', { l: [1] })).toBe('brel');
    expect(tpl('{{ range .Values.l }}{{ if eq . 2 }}{{ break }}{{ end }}{{ . }}{{ end }}', { l: [1, 2, 3] })).toBe('1');
    expect(tpl('{{ and .Values.a .Values.b }}|{{ or .Values.a .Values.b }}|{{ not .Values.a }}', { a: 0, b: 'x' })).toBe('0|x|true');
  });

  it('has the Sprig functions charts use', () => {
    expect(tpl('{{ .Values.tag | default "latest" | quote }}', {})).toBe('"latest"');
    expect(tpl('{{ default "x" .Values.tag }}', { tag: 'v2' })).toBe('v2');
    expect(tpl('labels:\n  {{- toYaml .Values.l | nindent 2 }}', { l: { b: '2', a: 1 } })).toBe('labels:\n  a: 1\n  b: "2"');
    expect(tpl('r: {{- toYaml .Values.r | nindent 2 }}', { r: {} })).toBe('r:\n  {}');
    expect(tpl('{{ printf "%s-%s" "a" "b" | trunc 3 | trimSuffix "-" | upper }}')).toBe('A-B');
    expect(tpl('{{ printf "%d %q %v %05.1f" 3 "x" .Values.l 2.3 }}', { l: [1, 'a'] })).toBe('3 "x" [1 a] 002.3');
    expect(tpl('{{ "a.b.c" | replace "." "-" }} {{ contains "b" "abc" }} {{ hasPrefix "a" "abc" }} {{ "x" | b64enc }}')).toBe('a-b-c true true eA==');
    expect(tpl('{{ list 1 2 | len }} {{ index .Values.m "k" }} {{ dict "a" 1 | keys }} {{ ternary "y" "n" true }}', { m: { k: 'v' } })).toBe('2 v [a] y');
    expect(tpl('{{ .Values.n | int | add 1 }} {{ max 3 7 }} {{ until 3 }}', { n: '4' })).toBe('5 7 [0 1 2]');
    expect(tpl('{{ semverCompare ">=1.19-0" "v1.31.2" }} {{ empty .Values.x }} {{ coalesce .Values.x "" "c" }}', {})).toBe('true true c');
  });

  it('includes named templates and renders tpl strings', () => {
    const helpers = '{{- define "c.name" -}}\n{{ .Chart.Name }}-{{ .Release.Name }}\n{{- end }}\n{{- define "c.labels" -}}\napp: {{ include "c.name" . }}\n{{- end }}';
    expect(tpl('name: {{ include "c.name" . }}\nlabels:\n  {{- include "c.labels" . | nindent 2 }}', {}, helpers)).toBe('name: c-rel\nlabels:\n  app: c-rel');
    expect(tpl('{{ template "c.name" . }}', {}, helpers)).toBe('c-rel');
    expect(tpl('{{ tpl .Values.t . }}', { t: '{{ .Release.Name }}!' })).toBe('rel!');
  });

  it('reports errors the way Helm does', () => {
    expect(() => tpl('x: {{ .Values.a.b }}', {})).toThrow('template: c/templates/t.yaml:1:7: executing "c/templates/t.yaml" at <.Values.a.b>: nil pointer evaluating interface {}.b');
    expect(() => tpl('x: {{ required "a is required" .Values.a }}', {})).toThrow('execution error at (c/templates/t.yaml:1:7): a is required');
    expect(() => tpl('{{ fail "nope" }}')).toThrow('execution error at (c/templates/t.yaml:1:4): nope');
    expect(() => tpl('{{ nope 1 }}')).toThrow('parse error at (c/templates/t.yaml:1): function "nope" not defined');
    expect(() => tpl('a\n{{ if .Values.a }}x')).toThrow('parse error at (c/templates/t.yaml:2): unexpected EOF');
    expect(() => tpl('{{ end }}')).toThrow('unexpected {{end}}');
    expect(() => tpl('{{ .Values.a }')).toThrow("unrecognized character in action: U+007D '}'");
    expect(() => tpl('{{ include "missing" . }}')).toThrow('no template "missing"');
  });
});

describe('values', () => {
  it('merges -f values and --set like Helm', () => {
    const v = coalesce({ image: { repository: 'nginx', tag: '' }, replicas: 1, debug: true }, { image: { tag: '1.27' }, debug: null });
    expect(v).toEqual({ image: { repository: 'nginx', tag: '1.27' }, replicas: 1 });
    const s: Record<string, unknown> = {};
    applySet(s, 'a.b=1,c=true,d=null,e=x\\,y,list[1]=z,arr={a,b}');
    expect(s).toEqual({ a: { b: 1 }, c: true, d: null, e: 'x,y', list: [undefined, 'z'], arr: ['a', 'b'] });
    const t: Record<string, unknown> = {};
    applySet(t, 'port=8080', true);
    expect(t).toEqual({ port: '8080' });
  });
});

describe('helm CLI', () => {
  it('creates, lints, installs, upgrades, rolls back and uninstalls a chart', () => {
    const t = makeShell();
    expect(t.run('helm create shop').out).toBe('Creating shop\n');
    expect(t.run('ls shop shop/templates').out).toContain('NOTES.txt     deployment.yaml  ingress.yaml  serviceaccount.yaml\n_helpers.tpl  hpa.yaml         service.yaml  tests\n');
    expect(t.run('helm lint shop').out).toBe('==> Linting shop\n[INFO] Chart.yaml: icon is recommended\n\n1 chart(s) linted, 0 chart(s) failed\n');
    const install = t.run('helm install web ./shop --set replicaCount=2');
    expect(install.out).toMatch(/^NAME: web\nLAST DEPLOYED: Tue Nov  3 09:00:\d\d 2026\nNAMESPACE: default\nSTATUS: deployed\nREVISION: 1\nTEST SUITE: None\nNOTES:\n1\. Get the application URL by running these commands:\n/);
    expect(t.run('helm list').out).toMatch(/^NAME\tNAMESPACE\tREVISION\tUPDATED {32}\tSTATUS  \tCHART     \tAPP VERSION\nweb \tdefault  \t1       \t2026-11-03 09:00:\d\d\.\d{9} \+0000 UTC\tdeployed\tshop-0\.1\.0\t1\.16\.0\n$/);
    expect(t.run('kubectl get deploy web-shop -o jsonpath={.spec.replicas}').out).toBe('2');
    expect(t.run('kubectl get deploy web-shop -o jsonpath={.metadata.annotations}').out).toContain('"meta.helm.sh/release-name":"web"');
    expect(t.run('helm install web ./shop').err).toBe('Error: INSTALLATION FAILED: cannot re-use a name that is still in use\n');
    expect(t.run('helm upgrade web ./shop --set image.tag=1.27').out).toMatch(/^Release "web" has been upgraded\. Happy Helming!\nNAME: web\n/);
    expect(t.run('helm get values web').out).toBe('USER-SUPPLIED VALUES:\nimage:\n  tag: "1.27"\n');
    expect(t.run('kubectl get deploy web-shop -o jsonpath={.spec.replicas}').out).toBe('1');
    expect(t.run('helm rollback web 1').out).toBe('Rollback was a success! Happy Helming!\n');
    expect(t.run('helm history web').out).toMatch(/^REVISION\tUPDATED                 \tSTATUS    \tCHART     \tAPP VERSION\tDESCRIPTION\n1       \t.*\tsuperseded\tshop-0\.1\.0\t1\.16\.0     \tInstall complete\n2       \t.*\tsuperseded\t.*\tUpgrade complete\n3       \t.*\tdeployed  \t.*\tRollback to 1\n$/);
    expect(t.run('kubectl get deploy web-shop -o jsonpath={.spec.replicas}').out).toBe('2');
    expect(t.run('kubectl get secrets').out).toMatch(/sh\.helm\.release\.v1\.web\.v3 +helm\.sh\/release\.v1 +1/);
    expect(t.run('helm uninstall web').out).toBe('release "web" uninstalled\n');
    expect(t.run('kubectl get deploy web-shop').err).toContain('not found');
    expect(t.run('helm uninstall web').err).toBe('Error: uninstall: Release not loaded: web: release: not found\n');
    expect(t.run('helm list').out).toBe('NAME\tNAMESPACE\tREVISION\tUPDATED\tSTATUS\tCHART\tAPP VERSION\n');
  });

  it('installs from the offline bitnami repo', () => {
    const t = makeShell();
    expect(t.run('helm search repo nginx').err).toBe('Error: no repositories configured\n');
    expect(t.run('helm install x bitnami/nginx').err).toBe('Error: INSTALLATION FAILED: repo bitnami not found\n');
    expect(t.run('helm repo add bitnami https://charts.bitnami.com/bitnami').out).toBe('"bitnami" has been added to your repositories\n');
    expect(t.run('helm repo add bitnami https://charts.bitnami.com/bitnami').out).toBe('"bitnami" already exists with the same configuration, skipping\n');
    expect(t.run('helm repo add other https://example.invalid/charts').err).toContain('is not a valid chart repository or cannot be reached');
    expect(t.run('helm search repo nginx').out).toBe('NAME         \tCHART VERSION\tAPP VERSION\tDESCRIPTION\nbitnami/nginx\t18.2.4       \t1.27.2     \tNGINX Open Source is a web server that can be a...\n');
    expect(t.run('helm show values bitnami/nginx').out).toContain('  type: LoadBalancer');
    const r = t.run('helm install web bitnami/nginx --version 18.1.0 -n web --create-namespace --set service.type=ClusterIP --wait');
    expect(r.out).toContain('CHART VERSION: 18.1.0');
    expect(t.run('kubectl get pods -n web').out).toMatch(/web-nginx-\S+ +1\/1 +Running/);
    t.setup('helm upgrade web bitnami/nginx -n web --reuse-values');
    expect(t.run('helm list -n web').out).toContain('nginx-18.2.4');
    expect(t.run('helm get values web -n web --all').out).toContain('  type: ClusterIP');
    expect(t.run('helm install other bitnami/nginx -n nowhere').err).toBe('Error: INSTALLATION FAILED: create: failed to create: namespaces "nowhere" not found\n');
    t.setup('helm pull bitnami/nginx --untar');
    expect(t.run('cat nginx/Chart.yaml').out).toContain('version: 18.2.4');
  });

  it('refuses to adopt objects it does not own and reports template errors', () => {
    const t = makeShell();
    t.setup('helm create shop', 'kubectl create deployment api --image=nginx');
    expect(t.run('helm install api ./shop --set fullnameOverride=api').err).toBe('Error: INSTALLATION FAILED: Unable to continue with install: Deployment "api" in namespace "default" exists and cannot be imported into the current release: invalid ownership metadata; label validation error: missing key "app.kubernetes.io/managed-by": must be set to "Helm"; annotation validation error: missing key "meta.helm.sh/release-name": must be set to "api"; annotation validation error: missing key "meta.helm.sh/release-namespace": must be set to "default"\n');
    expect(t.run('helm template x ./shop -s templates/service.yaml').out).toMatch(/^---\n# Source: shop\/templates\/service\.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: x-shop\n/);
    t.vfs().writeFile('/home/student/shop/templates/cm.yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ required "cm.name is required" .Values.cm.name }}\n');
    expect(t.run('helm template x ./shop').err).toBe('Error: template: shop/templates/cm.yaml:4:43: executing "shop/templates/cm.yaml" at <.Values.cm.name>: nil pointer evaluating interface {}.name\n');
    expect(t.run('helm install x ./shop --set cm.name=').err).toBe('Error: INSTALLATION FAILED: execution error at (shop/templates/cm.yaml:4:12): cm.name is required\n');
    expect(t.run('helm lint shop').out).toContain('[ERROR] templates/cm.yaml: template: shop/templates/cm.yaml:4:43');
    t.vfs().writeFile('/home/student/shop/templates/cm.yaml', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  - bad\n  key: x\n');
    expect(t.run('helm install x ./shop').err).toMatch(/^Error: INSTALLATION FAILED: YAML parse error on shop\/templates\/cm\.yaml: error converting YAML to JSON: yaml: /);
    expect(t.run('helm install y ./nope').err).toBe('Error: INSTALLATION FAILED: path "./nope" not found\n');
    expect(t.run('helm install y nginx').err).toBe('Error: INSTALLATION FAILED: non-absolute URLs should be in form of repo_name/path_to_chart, got: nginx\n');
    expect(t.run('helm upgrade z ./shop').err).toBe('Error: UPGRADE FAILED: "z" has no deployed releases\n');
    expect(t.run('helm bogus').err).toBe('Error: unknown command "bogus" for "helm"\nRun \'helm --help\' for usage.\n');
    expect(t.run('helm install --bogus').err).toBe('Error: unknown flag: --bogus\n');
  });

  it('upgrade --install, --wait timeouts and --atomic', () => {
    const t = makeShell();
    t.setup('helm create shop');
    expect(t.run('helm upgrade --install web ./shop').out).toMatch(/^Release "web" does not exist\. Installing it now\.\nNAME: web\n/);
    const r = t.run('helm upgrade web ./shop --set image.tag=9.9.9 --atomic --timeout 1m');
    expect(r.err).toBe('Error: UPGRADE FAILED: release web failed, and has been rolled back due to atomic being set: context deadline exceeded\n');
    expect(t.run('helm history web').out).toMatch(/\n2 +\t.*\tfailed +\t.*\tUpgrade "web" failed: context deadline exceeded\n3 +\t.*\tdeployed +\t.*\tRollback to 1\n$/);
  });

  it('is not available inside containers', () => {
    const t = makeShell();
    t.setup('docker run -d --name web nginx');
    expect(t.run('docker exec web helm version').err).toContain('helm: command not found');
  });
});
