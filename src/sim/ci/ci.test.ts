import { describe, expect, it } from 'vitest';
import { buildInitialState } from '../../game/initialState';
import type { InitialStateSpec } from '../../game/types';
import { createShell } from '../index';
import { Vfs } from '../vfs/vfs';
import { evaluate } from './expr';
import { parseWorkflow } from './github';
import { parseGitlab, ruleIf } from './gitlab';

const SHOP = 'https://github.com/acme/shop.git';
const WEB = 'https://gitlab.com/acme/web.git';

const PKG = (name: string) => JSON.stringify({ name, version: '1.0.0', scripts: { test: 'jest', lint: 'eslint src', build: 'vite build' } }, null, 2) + '\n';

/** A shell with a hosted repo cloned at ~/<name>, ready to commit and push. */
function world(url: string, files: Record<string, string>, extra: InitialStateSpec = {}) {
  const name = url.split('/').pop()!.replace('.git', '');
  const state = buildInitialState({
    gitHosted: [{ url, files: { 'package.json': PKG(name), 'package-lock.json': '{}\n', ...files } }],
    projects: { [name]: { tests: [{ suite: 'src/cart.test.js', name: 'cart › discounts', file: 'src/cart.js', regex: 'price - price', failure: 'Expected: 90\nReceived: 110' }] } },
    setup: [`git clone -q ${url}`],
    cwd: `/home/student/${name}`,
    ...extra,
  });
  const sh = createShell(state);
  const run = (line: string) => {
    const r = sh.run(line);
    return { out: r.output.filter((o) => o.stream === 'stdout').map((o) => o.text).join(''), err: r.output.filter((o) => o.stream === 'stderr').map((o) => o.text).join(''), code: r.exitCode };
  };
  const write = (rel: string, text: string) => {
    const vfs = new Vfs(state.fs, { name: 'student', groups: ['student'] });
    const abs = `/home/student/${name}/${rel}`;
    vfs.mkdir(abs.replace(/\/[^/]+$/, ''), { parents: true });
    vfs.writeFile(abs, text);
  };
  const push = (rel: string, text: string, msg = 'change') => {
    write(rel, text);
    const r = run(`git add -A && git commit -qm "${msg}" && git push -q`);
    if (r.code !== 0) throw new Error(r.err);
  };
  const runs = () => state.forge!.repos[url].runs;
  return { state, run, write, push, runs };
}

const WF = (body: string) => `name: CI\non:\n  push:\n    branches: [main]\njobs:\n${body}`;
const TEST_JOB = `  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test\n`;

describe('expressions', () => {
  const ctx = { contexts: { github: { ref: 'refs/heads/main', event_name: 'push' }, env: { N: '3' }, matrix: { os: 'linux' }, needs: { a: { result: 'success', outputs: { v: '1.2' } } } }, status: { success: true, failure: false, cancelled: false } };
  it('evaluates operators, functions and contexts like GitHub', () => {
    expect(evaluate("github.ref == 'refs/heads/MAIN'", ctx)).toBe(true);
    expect(evaluate("startsWith(github.ref, 'refs/heads/') && env.N > 2", ctx)).toBe(true);
    expect(evaluate("format('{0}-{1}', matrix.os, needs.a.outputs.v)", ctx)).toBe('linux-1.2');
    expect(evaluate("contains(fromJSON('[\"a\",\"b\"]'), 'b')", ctx)).toBe(true);
    expect(evaluate("github.missing || 'default'", ctx)).toBe('default');
    expect(() => evaluate('secret.TOKEN', ctx)).toThrow("Unrecognized named-value: 'secret'");
    expect(() => evaluate('nope()', ctx)).toThrow("Unrecognized function: 'nope'");
  });
});

describe('workflow validation', () => {
  it('reports errors the way GitHub annotates them', () => {
    expect(parseWorkflow('.github/workflows/ci.yml', 'on: push\njobs:\n  a:\n    steps: []\n')).toEqual({ error: 'Invalid workflow file: .github/workflows/ci.yml#L3\nThe workflow is not valid. .github/workflows/ci.yml (Line: 3, Col: 3): Required property is missing: runs-on' });
    expect((parseWorkflow('w.yml', WF('  b:\n    needs: tests\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n')) as { error: string }).error).toContain("Job 'b' depends on unknown job 'tests'.");
    expect((parseWorkflow('w.yml', WF('  a:\n    runs-on: ubuntu-latest\n    step:\n      - run: echo\n')) as { error: string }).error).toContain("Unexpected value 'step'");
    expect((parseWorkflow('w.yml', WF('  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout\n')) as { error: string }).error).toContain("Expected format {org}/{repo}[/path]@ref. Actual 'actions/checkout'");
    expect((parseWorkflow('w.yml', 'on: push\njobs:\n  a:\n   runs-on: x\n  steps: [\n') as { error: string }).error).toMatch(/^Invalid workflow file: w\.yml#L\d+\nYou have an error in your yaml syntax on line \d+$/);
  });
});

describe('GitHub Actions runs', () => {
  it('runs on push, fails red, and goes green after a fix', () => {
    const w = world(SHOP, { 'src/cart.js': 'total = price + price * d\n', '.github/workflows/ci.yml': WF(TEST_JOB) });
    w.push('README.md', '# shop\n', 'Add readme');
    expect(w.runs()).toHaveLength(1);
    expect(w.run('gh run list').out).toMatch(/^STATUS +TITLE +WORKFLOW +BRANCH +EVENT +ID +ELAPSED +AGE\n\* +Add readme +CI +main +push +\d{11} /);
    const watch = w.run('gh run watch --exit-status');
    expect(watch.code).toBe(1);
    expect(watch.out).toContain('X test in ');
    expect(watch.out).toContain('  X Run npm test\n');
    expect(watch.out).toMatch(/X Run CI \(\d+\) completed with 'failure'\n$/);
    const logs = w.run('gh run view --log-failed').out;
    expect(logs).toMatch(/^test\tRun npm test\t2026-\S+Z ##\[group\]Run npm test\n/);
    expect(logs).toContain('Expected: 90');
    expect(logs).toContain('##[error]Process completed with exit code 1.');
    w.push('src/cart.js', 'total = price - price * d\n', 'Fix');
    w.run('gh run watch');
    expect(w.run('gh run list').out).toMatch(/\n✓ +Fix +CI +main/);
  });

  it('respects branch filters, needs, if, matrix, outputs and secrets', () => {
    const wf = `name: Pipeline
on:
  push:
    branches: [main, 'release/**']
    paths-ignore: ['docs/**']
env:
  APP: shop
jobs:
  meta:
    runs-on: ubuntu-latest
    outputs:
      tag: \${{ steps.v.outputs.tag }}
    steps:
      - id: v
        run: echo "tag=\${{ env.APP }}-\${{ github.run_number }}" >> $GITHUB_OUTPUT
  test:
    needs: meta
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo "testing \${{ needs.meta.outputs.tag }} on node \${{ matrix.node }}"
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: echo "token is \${{ secrets.DEPLOY_TOKEN }}"
      - run: exit 3
        continue-on-error: true
      - run: echo after
  gpu:
    runs-on: [self-hosted, gpu]
    steps:
      - run: echo never
`;
    const w = world(SHOP, { '.github/workflows/p.yml': wf }, { forge: { [SHOP]: { secrets: { DEPLOY_TOKEN: 'super-secret-123' } } } });
    w.push('docs/a.md', 'x\n', 'Docs only');
    expect(w.runs()).toHaveLength(0);
    w.push('src/x.js', 'x\n', 'Code');
    const run = w.runs()[0];
    expect(run.jobs.map((j) => `${j.name}:${j.status}`)).toEqual(['meta:success', 'test (18):success', 'test (20):success', 'deploy:success', 'gpu:stuck']);
    expect(run.jobs[1].steps.flatMap((s) => s.log)).toContain('testing shop-1 on node 18');
    const deployLog = run.jobs[3].steps.flatMap((s) => s.log).join('\n');
    expect(deployLog).toContain('token is ***');
    expect(deployLog).not.toContain('super-secret-123');
    expect(deployLog).toContain('after');
    w.run('git switch -q -c feature/x');
    w.write('src/y.js', 'y\n');
    w.run('git add -A && git commit -qm feature && git push -q -u origin feature/x');
    expect(w.runs()).toHaveLength(1);
    w.run('git switch -q -c release/1.2');
    w.run('git push -q -u origin release/1.2');
    expect(w.runs()[1].jobs.find((j) => j.key === 'deploy')!.status).toBe('skipped');
  });

  it('passes files between jobs only as artifacts, and caches dependencies', () => {
    const wf = WF(`  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with: { name: dist, path: dist/ }
  check:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: test -f index.html || echo "no build here"
      - uses: actions/download-artifact@v4
        with: { name: dist }
      - run: test -f index.html && node --version
      - uses: actions/download-artifact@v4
        with: { name: nope }
`);
    const w = world(SHOP, { '.github/workflows/ci.yml': wf });
    w.push('a', '1\n');
    const [build, check] = w.runs()[0].jobs;
    expect(build.status).toBe('success');
    const log = check.steps.flatMap((s) => s.log).join('\n');
    expect(log).toContain('no build here');
    expect(log).toContain('v20.18.0');
    expect(log).toContain('Unable to download artifact(s): Artifact not found for name: nope');
    expect(build.steps.flatMap((s) => s.log)).toContain('npm cache is not found');
    w.push('a', '2\n');
    expect(w.runs()[1].jobs[0].steps.flatMap((s) => s.log).join('\n')).toMatch(/Cache restored from key: node-cache-Linux-x64-npm-[0-9a-f]{64}/);
    w.run('gh run watch');
    expect(w.run('gh run view --verbose').out).toContain('ARTIFACTS\ndist\n');
  });

  it('builds and pushes images with docker/* actions, which need a secret', () => {
    const wf = WF(`  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: \${{ github.actor }}
          password: \${{ secrets.REGISTRY_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: ghcr.io/acme/shop:\${{ github.sha }}
`);
    const w = world(SHOP, { '.github/workflows/ci.yml': wf, Dockerfile: 'FROM nginx:1.27-alpine\nCOPY dist/ /usr/share/nginx/html/\n' });
    w.push('a', '1\n');
    expect(w.runs()[0].jobs[0].steps.flatMap((s) => s.log)).toContain('##[error]Username and password required');
    expect(w.run('gh secret set REGISTRY_TOKEN --body ghp_x1y2z3').out).toBe('✓ Set Actions secret REGISTRY_TOKEN for acme/shop\n');
    expect(w.run('gh secret list').out).toMatch(/^NAME +UPDATED\nREGISTRY_TOKEN +less than a minute ago\n$/);
    const id = w.runs()[0].id;
    expect(w.run(`gh run rerun ${id} --failed`).err).toBe(`run ${id} cannot be rerun; it is still in progress\n`);
    w.run('gh run watch');
    expect(w.run(`gh run rerun ${id} --failed`).out).toBe(`✓ Requested rerun (failed jobs) of run ${id}\n`);
    expect(w.runs()[0].jobs[0].status).toBe('success');
    const sha = w.state.git!.remotes[SHOP].heads.main;
    expect(Object.keys(w.state.registry!.images)).toContain(`ghcr.io/acme/shop:${sha}`);
  });

  it('reports invalid workflows, unknown actions and dispatches', () => {
    const w = world(SHOP, {
      '.github/workflows/bad.yml': WF('  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: acme/does-not-exist@v1\n'),
      '.github/workflows/deploy.yml': 'name: Deploy\non:\n  workflow_dispatch:\n    inputs:\n      env:\n        required: true\n        type: choice\n        options: [staging, prod]\njobs:\n  go:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "to ${{ inputs.env }}"\n',
    });
    w.push('a', '1\n');
    expect(w.runs()[0].jobs[0].steps[0].log.join('\n')).toContain('Unable to resolve action `acme/does-not-exist@v1`, repository not found');
    expect(w.run('gh workflow run deploy.yml').err).toBe("could not create workflow dispatch event: HTTP 422: Required input 'env' not provided\n");
    expect(w.run('gh workflow run deploy.yml -f env=qa').err).toContain("Provided value 'qa' for input 'env' not in the list of allowed values");
    expect(w.run('gh workflow run deploy.yml -f env=staging').out).toBe('✓ Created workflow_dispatch event for deploy.yml at main\n\nTo see runs for this workflow, try: gh run list --workflow=deploy.yml\n');
    expect(w.runs()[1].jobs[0].steps.flatMap((s) => s.log)).toContain('to staging');
    w.push('.github/workflows/bad.yml', 'on: push\njobs:\n  a:\n    steps: []\n');
    expect(w.run(`gh run view ${w.runs()[2].id}`).out).toContain('X This run likely failed because of a workflow file issue.\n\nANNOTATIONS\nX Invalid workflow file: .github/workflows/bad.yml#L3');
    expect(w.run('gh pr list').err).toContain("'gh pr' is real, but not simulated here");
  });

  it('only reaches the cluster with a kubeconfig', () => {
    const wf = WF('  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: kubectl get nodes\n');
    const w = world(SHOP, { '.github/workflows/ci.yml': wf });
    w.push('a', '1\n');
    expect(w.runs()[0].jobs[0].steps.flatMap((s) => s.log).join('\n')).toContain('The connection to the server localhost:8080 was refused - did you specify the right host or port?');
    w.push('.github/workflows/ci.yml', WF('  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: azure/k8s-set-context@v4\n        with:\n          kubeconfig: ${{ secrets.KUBECONFIG }}\n      - run: kubectl get nodes\n'));
    expect(w.runs()[1].jobs[0].steps.flatMap((s) => s.log).join('\n')).toContain('Kubeconfig not provided');
    w.run('gh secret set KUBECONFIG --body apiVersion:v1');
    w.push('b', '1\n');
    expect(w.runs()[2].jobs[0].steps.flatMap((s) => s.log).join('\n')).toMatch(/devquest-control-plane +Ready/);
  });
});

describe('GitLab CI', () => {
  it('validates .gitlab-ci.yml like GitLab', () => {
    expect(parseGitlab('build:\n  stage: build\n')).toEqual({ error: 'jobs:build config should implement the script:, run:, or trigger: keyword' });
    expect(parseGitlab('a:\n  stage: qa\n  script: [x]\n')).toEqual({ error: 'a job: chosen stage qa does not exist; available stages are .pre, build, test, deploy, .post' });
    expect(parseGitlab('a:\n  script: [x]\n  needs: [b]\n')).toEqual({ error: 'a job: undefined need: b' });
    expect(parseGitlab('a:\n  script: [x]\n  only_if: y\n')).toEqual({ error: 'jobs:a config contains unknown keys: only_if' });
    expect(parseGitlab('.hidden:\n  script: [x]\n')).toEqual({ error: 'jobs config should contain at least one visible job' });
    expect(ruleIf('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH', { CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main' })).toBe(true);
    expect(ruleIf('$CI_COMMIT_TAG =~ /^v\\d+/ || $FORCE', { CI_COMMIT_TAG: 'v1.2' })).toBe(true);
    expect(ruleIf('$CI_COMMIT_TAG', {})).toBe(false);
  });

  it('runs stages, artifacts, rules, manual jobs and runner tags', () => {
    const ci = `stages: [build, test, deploy]
variables:
  IMAGE: $CI_REGISTRY_IMAGE:$CI_COMMIT_SHORT_SHA
build:
  stage: build
  script:
    - npm ci
    - npm run build
  artifacts:
    paths: [dist/]
test:
  stage: test
  script:
    - test -f dist/index.html
    - echo "image $IMAGE"
deploy:
  stage: deploy
  script: [echo deploying]
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: manual
gpu:
  stage: test
  tags: [gpu]
  script: [echo gpu]
  allow_failure: true
`;
    const w = world(WEB, { '.gitlab-ci.yml': ci });
    expect(w.run('glab ci lint').out).toBe('Validating...\n✓ CI/CD YAML is valid!\n');
    w.push('a', '1\n', 'Ship');
    const st = w.run('glab ci status --live').out;
    expect(st).toMatch(/^\(success\) • 00m \d\ds\tbuild\t\tbuild\n\(success\) • 00m \d\ds\ttest\t\ttest\n\(pending\) • 00m 00s\ttest\t\tgpu\n\(created\) • 00m 00s\tdeploy\t\tdeploy\n/);
    expect(st).toContain("This job is stuck because you don't have any active runners online or available with any of these tags assigned to them: gpu");
    const trace = w.run('glab ci trace test').out;
    expect(trace).toMatch(/Downloading artifacts for build \(\d+\)\.\.\./);
    expect(trace).toMatch(/\$ echo "image \$IMAGE"\nimage registry\.gitlab\.com\/acme\/web:[0-9a-f]{8}\n/);
    expect(trace).toContain('Job succeeded');
    expect(w.run('glab ci trigger test').err).toContain('403 Forbidden  - Unplayable Job');
  });

  it('plays manual jobs and uses CI/CD variables', () => {
    const ci = `build:\n  stage: build\n  script: [echo built]\ndeploy:\n  stage: deploy\n  script:\n    - echo "key=$API_KEY"\n    - kubectl get ns default\n  when: manual\n`;
    const w = world(WEB, { '.gitlab-ci.yml': ci });
    expect(w.run('glab variable set API_KEY s3cr3t-value --masked').out).toBe('✓ Created variable API_KEY for acme/web with scope *.\n');
    w.run('glab variable set KUBECONFIG "apiVersion: v1" --type file');
    w.push('a', '1\n');
    expect(w.run('glab ci status --live').out).toContain('(manual) • 00m 00s\tdeploy\t\tdeploy');
    expect(w.run('glab ci trigger deploy').out).toMatch(/^Triggered job \(id: \d+ \), status: pending , ref: main , weburl: https:\/\/gitlab\.com\/acme\/web\/-\/jobs\/\d+ \)\n$/);
    const trace = w.run('glab ci trace deploy').out;
    expect(trace).toContain('key=[MASKED]'.replace('[MASKED]', '***'));
    expect(trace).toMatch(/default +Active/);
    expect(w.run('glab ci list').out).toMatch(/^Showing 1 pipelines on acme\/web \(Page 1\)\n\n\(success\) • #\d+\tmain\t/);
  });
});

describe('toolchain', () => {
  it('npm ci / test / run like npm and jest', () => {
    const w = world(SHOP, { 'src/cart.js': 'price + price\n' });
    expect(w.run('npm test')).toMatchObject({ code: 127, err: 'sh: 1: jest: not found\n' });
    expect(w.run('npm ci').out).toMatch(/^\nadded 312 packages, and audited 313 packages in \d+s\n/);
    const t = w.run('npm test');
    expect(t.out).toBe('\n> shop@1.0.0 test\n> jest\n\n');
    expect(t.err).toMatch(/^FAIL src\/cart\.test\.js\n  ● cart › discounts\n\n    Expected: 90\n    Received: 110\n\n\nTest Suites: 1 failed, 1 total\nTests:       1 failed, 1 total\n/);
    expect(w.run('npm run nope').err).toMatch(/^npm error Missing script: "nope"\n/);
    expect(w.run('npm run build').out).toContain('✓ built in');
    expect(w.run('ls dist').out).toBe('assets  index.html\n');
    w.run('rm package-lock.json');
    expect(w.run('npm ci').err).toContain('The `npm ci` command can only install with an existing package-lock.json');
    expect(w.run('node --version').out).toBe('v20.18.0\n');
    expect(w.run('[ -f package.json ] && test -d dist && test 3 -gt 2').code).toBe(0);
    expect(w.run('[ -f missing ]').code).toBe(1);
    expect(w.run('[ -f x').err).toBe("bash: [: missing `]'\n");
  });

  it('docker tag / login / push against the registry', () => {
    const w = world(SHOP, { Dockerfile: 'FROM nginx:1.27\n' });
    w.run('docker build -t shop:dev .');
    expect(w.run('docker push shop:dev').err).toBe('denied: requested access to the resource is denied\n');
    expect(w.run('docker tag shop:dev ghcr.io/acme/shop:1.0').code).toBe(0);
    expect(w.run('docker push ghcr.io/acme/shop:1.0').err).toBe('unauthorized: unauthenticated: User cannot be authenticated with the token provided.\n');
    expect(w.run('docker login ghcr.io -u student').err).toBe('Error: Cannot perform an interactive login from a non TTY device\n');
    expect(w.run('echo tok | docker login ghcr.io -u student --password-stdin').out).toBe('Login Succeeded\n');
    expect(w.run('docker push ghcr.io/acme/shop:1.0').out).toMatch(/^The push refers to repository \[ghcr\.io\/acme\/shop\]\n(\w{12}: Pushed\n){3}1\.0: digest: sha256:[0-9a-f]{64} size: 1572\n$/);
    expect(w.run('docker push ghcr.io/acme/shop:2.0').err).toBe('tag does not exist: ghcr.io/acme/shop:2.0\n');
    expect(w.run('docker tag nope:1 x:1').err).toBe('Error response from daemon: No such image: nope:1\n');
  });

  it('lets the cluster pull wildcard images only once they are pushed', () => {
    const w = world(SHOP, { Dockerfile: 'FROM nginx:1.27\n' }, { kubeImages: { 'ghcr.io/acme/shop:*': { listen: [8080], http: { '/': { body: 'shop {tag}\n' } } } } });
    w.run('kubectl create deployment shop --image=ghcr.io/acme/shop:1.0');
    w.run('sleep 30');
    expect(w.run('kubectl get pods').out).toMatch(/ErrImagePull|ImagePullBackOff/);
    w.run('docker build -t ghcr.io/acme/shop:1.0 .');
    w.run('echo t | docker login ghcr.io -u me --password-stdin');
    w.run('docker push ghcr.io/acme/shop:1.0');
    w.run('sleep 60');
    expect(w.run('kubectl get pods').out).toMatch(/shop-\S+ +1\/1 +Running/);
    expect(w.run('kubectl run t --rm -i --restart=Never --image=curlimages/curl -- curl -s http://' + 'x || true').code).toBe(0);
  });
});
