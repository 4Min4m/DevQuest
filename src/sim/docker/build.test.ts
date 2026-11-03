import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { parseDockerfile } from './build';

function project(files: Record<string, string>) {
  const t = makeShell();
  t.setup('mkdir app', 'docker pull python:3.12-slim', 'docker pull alpine', 'docker pull nginx:alpine', 'docker pull ubuntu', 'docker pull node');
  for (const [p, c] of Object.entries(files)) {
    const abs = `/home/student/app/${p}`;
    t.vfs().mkdir(abs.replace(/\/[^/]+$/, ''), { parents: true });
    t.vfs().writeFile(abs, c);
  }
  t.run('cd app');
  return t;
}

const APP = 'from http.server import HTTPServer\nprint("ready")\nHTTPServer(("", 8000), H).serve_forever()\n';

describe('Dockerfile parsing', () => {
  it('handles comments, continuations and case', () => {
    const ins = parseDockerfile('# comment\nfrom alpine\nRUN echo a \\\n  && echo b\n\ncmd ["sh"]\n');
    expect(ins.map((i) => [i.line, i.cmd, i.args])).toEqual([
      [2, 'FROM', 'alpine'],
      [3, 'RUN', 'echo a && echo b'],
      [6, 'CMD', '["sh"]'],
    ]);
  });
  it('rejects unknown instructions with the line number', () => {
    expect(() => parseDockerfile('FROM alpine\nCOPPY a b\n')).toThrow('dockerfile parse error on line 2: unknown instruction: COPPY');
    expect(() => parseDockerfile('\n# nothing\n')).toThrow('the Dockerfile cannot be empty');
  });
});

describe('docker build', () => {
  it('builds a runnable image with BuildKit-style progress', () => {
    const t = project({ 'app.py': APP, Dockerfile: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY app.py .\nENV MODE=prod\nEXPOSE 8000\nCMD ["python3", "app.py"]\n' });
    const r = t.run('docker build -t myapp:1.0 .');
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/^\[\+\] Building .* FINISHED/);
    expect(r.err).toContain(' => [3/3] COPY app.py .');
    expect(r.err).toMatch(/naming to docker\.io\/library\/myapp:1\.0/);
    expect(t.run('docker images myapp').out).toMatch(/myapp        1\.0       [0-9a-f]{12}   1 second ago   130MB/);
    expect(t.run('docker image inspect -f "{{.Config.WorkingDir}} {{.Config.Cmd}} {{.Config.Env}}" myapp:1.0').out).toMatch(/^\/app \[python3 app\.py\] \[.*MODE=prod\]\n$/);
    t.setup('docker run -d --name api -p 8000:8000 myapp:1.0');
    expect(t.run('docker logs api').out).toBe('ready\n');
    expect(t.run('curl -s localhost:8000').code).toBe(0);
    expect(t.run('docker exec api ls /app').out).toBe('app.py\n');
  });

  it('shell-form CMD runs the app, and RUN executes at build time', () => {
    const t = project({ 'app.py': APP, Dockerfile: 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN mkdir -p data && echo built > data/stamp\nCMD python3 app.py\n' });
    expect(t.run('docker build -q -t shellform .').out).toMatch(/^sha256:[0-9a-f]{64}\n$/);
    t.setup('docker run -d --name s -p 8000:8000 shellform'.replace('--name s', '--name sf'));
    expect(t.run('docker exec sf cat /app/data/stamp').out).toBe('built\n');
    expect(t.run('docker ps --format "{{.Names}} {{.State}}"').out).toBe('sf running\n');
  });

  it('COPY copies directory contents and honours .dockerignore', () => {
    const t = project({ 'site/index.html': '<h1>x</h1>\n', 'site/css/a.css': 'body{}\n', 'secret.env': 'X=1\n', '.dockerignore': 'secret.env\n', Dockerfile: 'FROM nginx:alpine\nCOPY site/ /usr/share/nginx/html/\nCOPY . /ctx/\n' });
    t.setup('docker build -t site .', 'docker run -d --name web site');
    expect(t.run('docker exec web ls /usr/share/nginx/html').out).toBe('50x.html  css  index.html\n');
    expect(t.run('docker exec web ls /ctx').out).not.toContain('secret.env');
  });

  it('package installs: apt-get needs -y, alpine uses apk, installed tools become available', () => {
    const t = project({ Dockerfile: 'FROM ubuntu\nRUN apt-get update && apt-get install curl\n' });
    let r = t.run('docker build -t u .');
    expect(r.code).toBe(1);
    expect(r.err).toContain('0.245 Do you want to continue? [Y/n] Abort.');
    expect(r.err).toContain('   2 | >>> RUN apt-get update && apt-get install curl');
    expect(r.err).toMatch(/ERROR: failed to solve: process "\/bin\/sh -c apt-get update && apt-get install curl" did not complete successfully: exit code: 1\n$/);

    t.vfs().writeFile('/home/student/app/Dockerfile', 'FROM ubuntu\nRUN apt-get update && apt-get install -y curl procps\nCMD ["sleep", "1000"]\n');
    t.setup('docker build -t u .', 'docker run -d --name uu u');
    expect(t.run('docker exec uu ps').code).toBe(0);
    expect(t.run('docker exec uu curl --help').code).toBe(0);

    t.vfs().writeFile('/home/student/app/Dockerfile', 'FROM alpine\nRUN apt-get install -y curl\n');
    r = t.run('docker build .');
    expect(r.err).toContain('0.245 /bin/sh: apt-get: not found');
    expect(r.err).toContain('exit code: 127');

    t.vfs().writeFile('/home/student/app/Dockerfile', 'FROM alpine\nRUN apk add --no-cache curl bash\nCMD ["sleep", "1000"]\n');
    t.setup('docker build -t a2 .', 'docker run -d --name aa a2');
    expect(t.run('docker exec aa curl --help').code).toBe(0);
    expect(t.run('docker exec -it aa bash').code).toBe(0);
  });

  it('pip and npm need their files', () => {
    const t = project({ Dockerfile: 'FROM python:3.12-slim\nWORKDIR /app\nRUN pip install -r requirements.txt\n' });
    expect(t.run('docker build .').err).toContain("ERROR: Could not open requirements file: [Errno 2] No such file or directory: 'requirements.txt'");
    t.vfs().writeFile('/home/student/app/Dockerfile', 'FROM node\nWORKDIR /app\nRUN npm install\n');
    const r = t.run('docker build .');
    expect(r.err).toContain("npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '/app/package.json'");
    expect(r.err).toContain('exit code: 254');
  });

  it('reports build errors like BuildKit', () => {
    const t = project({ Dockerfile: 'FROM alpine\nCOPY nope.txt /\n' });
    expect(t.run('docker build .').err).toMatch(/ERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref .*: "\/nope\.txt": not found\n$/);
    t.vfs().writeFile('/home/student/app/Dockerfile', 'COPY a b\n');
    expect(t.run('docker build .').err).toBe('ERROR: failed to solve: no build stage in current context\n');
    t.vfs().writeFile('/home/student/app/Dockerfile', 'FROM nosuchimage\n');
    expect(t.run('docker build .').err).toMatch(/failed to resolve source metadata for docker\.io\/library\/nosuchimage:latest: pull access denied/);
    expect(t.run('docker build -f Missing .').err).toBe('ERROR: failed to solve: failed to read dockerfile: open Missing: no such file or directory\n');
    expect(t.run('docker build -t MyApp .').err).toBe('ERROR: invalid tag "MyApp": repository name must be lowercase\n');
    expect(t.run('docker build')).toMatchObject({ code: 1 });
    t.vfs().writeFile('/home/student/app/Dockerfile', 'FROM alpine AS one\nFROM alpine\n');
    expect(t.run('docker build .').err).toContain('multi-stage builds');
  });

  it('rebuilding a tag leaves the old image dangling', () => {
    const t = project({ Dockerfile: 'FROM alpine\nENV V=1\n' });
    t.setup('docker build -t thing .');
    t.vfs().writeFile('/home/student/app/Dockerfile', 'FROM alpine\nENV V=2\n');
    t.setup('docker build -t thing .');
    expect(t.run('docker images').out).toMatch(/<none>       <none>/);
  });

  it('ARG and ENV substitution, ENTRYPOINT + CMD', () => {
    const t = project({ Dockerfile: 'ARG BASE=alpine\nFROM ${BASE}\nENV DIR=/srv\nWORKDIR $DIR\nENTRYPOINT ["echo"]\nCMD ["hello"]\n' });
    t.setup('docker build -t e .');
    expect(t.run('docker run --rm e').out).toBe('hello\n');
    expect(t.run('docker run --rm e bye').out).toBe('bye\n');
    expect(t.run('docker run --rm --entrypoint pwd e').out).toBe('/srv\n');
  });
});
