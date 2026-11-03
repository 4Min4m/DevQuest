import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { shellSplit } from './compose';

const STACK = `services:
  web:
    image: nginx
    ports:
      - "8080:80"
    depends_on:
      - cache
  cache:
    image: redis
    volumes:
      - data:/data
volumes:
  data:
`;

function stack(yaml = STACK) {
  const t = makeShell();
  t.setup('docker pull nginx', 'docker pull redis', 'mkdir stack', 'cd stack');
  t.vfs().writeFile('/home/student/stack/compose.yaml', yaml);
  return t;
}

describe('docker compose', () => {
  it('up -d creates network, volumes and containers in dependency order', () => {
    const t = stack();
    const r = t.run('docker compose up -d');
    expect(r.code).toBe(0);
    expect(r.err.split('\n').filter(Boolean)).toEqual([
      '[+] Running 3/3',
      expect.stringMatching(/^ ✔ Network stack_default +Created$/),
      expect.stringMatching(/^ ✔ Volume "stack_data" +Created$/),
      expect.stringMatching(/^ ✔ Container stack-cache-1 +Started$/),
      expect.stringMatching(/^ ✔ Container stack-web-1 +Started$/),
    ]);
    expect(t.run('curl -s localhost:8080').out).toContain('Welcome to nginx!');
    expect(t.run('docker volume ls -q').out).toBe('stack_data\n');
  });

  it('ps, logs and exec work per service', () => {
    const t = stack();
    t.setup('docker compose up -d');
    const ps = t.run('docker compose ps').out.split('\n');
    expect(ps[0]).toBe('NAME            IMAGE     COMMAND                  SERVICE   CREATED        STATUS        PORTS');
    expect(ps[2]).toMatch(/^stack-web-1     nginx     "\/docker-entrypoint\.…"   web       /);
    expect(t.run('docker compose logs cache').out).toMatch(/^cache-1  \| 1:C .*Redis is starting/);
    expect(t.run('docker compose exec -T web sh -c "echo hi"').out).toBe('hi\n');
    // services find each other by name on the project network
    expect(t.run('docker compose exec -T web curl cache:6379').err).toBe('curl: (1) Received HTTP/0.9 when not allowed\n');
    t.run('docker compose exec web bash');
    expect(t.shell.activeState.context?.containerName).toBe('stack-web-1');
    t.run('exit');
    expect(t.run('docker compose exec nope ls').err).toBe('service "nope" is not defined in this project\n');
  });

  it('a second up leaves running containers alone; changed services are recreated', () => {
    const t = stack();
    t.setup('docker compose up -d');
    expect(t.run('docker compose up -d').err).toMatch(/stack-web-1 +Running/);
    t.vfs().writeFile('/home/student/stack/compose.yaml', STACK.replace('8080:80', '9090:80'));
    const r = t.run('docker compose up -d');
    expect(r.err).toMatch(/stack-web-1 +Recreated/);
    expect(r.err).toMatch(/stack-cache-1 +Running/);
    expect(t.run('curl -s localhost:9090').code).toBe(0);
  });

  it('down removes containers and network, -v also volumes', () => {
    const t = stack();
    t.setup('docker compose up -d');
    const r = t.run('docker compose down');
    expect(r.err).toMatch(/Container stack-web-1 +Removed[\s\S]*Container stack-cache-1 +Removed[\s\S]*Network stack_default +Removed/);
    expect(t.state.docker!.containers).toHaveLength(0);
    expect(t.run('docker volume ls -q').out).toBe('stack_data\n');
    t.setup('docker compose up -d', 'docker compose down -v');
    expect(t.run('docker volume ls -q').out).toBe('');
  });

  it('builds services with a build: section', () => {
    const t = stack(`services:\n  app:\n    build: ./app\n    ports: ["8000:8000"]\n    environment:\n      GREETING: hi\n`);
    t.setup('docker pull python:3.12-slim', 'mkdir app');
    t.vfs().writeFile('/home/student/stack/app/Dockerfile', 'FROM python:3.12-slim\nCOPY app.py /\nCMD ["python3", "/app.py"]\n');
    t.vfs().writeFile('/home/student/stack/app/app.py', 'print("hi {GREETING}")\nHTTPServer(("", 8000), H)\n');
    const r = t.run('docker compose up -d');
    expect(r.err).toMatch(/Service app +Built/);
    expect(t.run('docker images --format x stack-app').code).toBe(125); // images has no --format in devquest
    expect(t.run('docker images stack-app').out).toContain('stack-app');
    expect(t.run('docker compose logs app').out).toBe('app-1  | hi hi\n');
    expect(t.run('curl -s localhost:8000').code).toBe(0);
  });

  it('bind mounts are relative to the compose file, env as list or map', () => {
    const t = stack(`services:\n  web:\n    image: nginx\n    ports: ["8080:80"]\n    volumes:\n      - ./site:/usr/share/nginx/html\n    environment:\n      - MODE=dev\n`);
    t.setup('mkdir site', 'echo mine > site/index.html', 'docker compose up -d');
    expect(t.run('curl -s localhost:8080').out).toBe('mine\n');
    expect(t.run('docker inspect -f "{{.Config.Env}}" stack-web-1').out).toContain('MODE=dev');
  });

  it('validates the file like compose', () => {
    const t = stack(`services:\n  web:\n    imagee: nginx\n`);
    expect(t.run('docker compose up -d')).toMatchObject({
      err: "validating /home/student/stack/compose.yaml: services.web additional properties 'imagee' not allowed\n",
      code: 1,
    });
    t.vfs().writeFile('/home/student/stack/compose.yaml', 'services:\n  web:\n    ports: ["80:80"]\n');
    expect(t.run('docker compose up -d').err).toBe('service "web" has neither an image nor a build context specified: invalid compose project\n');
    t.vfs().writeFile('/home/student/stack/compose.yaml', 'services:\n  web:\n    image: nginx\n    volumes: ["data:/x"]\n');
    expect(t.run('docker compose up -d').err).toBe('service "web" refers to undefined volume data: invalid compose project\n');
    t.vfs().writeFile('/home/student/stack/compose.yaml', 'services:\n  web:\n    image: nginx\n    depends_on: [db]\n');
    expect(t.run('docker compose up -d').err).toBe('service "web" depends on undefined service "db": invalid compose project\n');
    t.vfs().writeFile('/home/student/stack/compose.yaml', 'services:\n  web:\n   image: nginx\n  bad indent: [\n');
    expect(t.run('docker compose up -d').err).toMatch(/^yaml: line \d+: /);
    t.vfs().writeFile('/home/student/stack/compose.yaml', 'version: "3.8"\nservices:\n  web:\n    image: nginx\n');
    expect(t.run('docker compose up -d').err).toMatch(/the attribute `version` is obsolete/);
    t.run('cd ..');
    expect(t.run('docker compose ps')).toMatchObject({ err: 'no configuration file provided: not found\n', code: 1 });
    expect(t.run('docker compose frob').err).toBe('unknown docker command: "compose frob"\n');
  });

  it('reports port conflicts when starting', () => {
    const t = stack();
    t.setup('docker run -d --name squatter -p 8080:80 nginx');
    const r = t.run('docker compose up -d');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Container stack-cache-1 +Started\nError response from daemon: driver failed programming external connectivity .*port is already allocated\n$/);
  });

  it('-f and -p select file and project name', () => {
    const t = stack();
    t.run('mv compose.yaml other.yml');
    t.setup('docker compose -f other.yml -p demo up -d');
    expect(t.run('docker ps --format "{{.Names}}"').out).toBe('demo-web-1\ndemo-cache-1\n');
  });

  it('shellSplit handles quotes', () => {
    expect(shellSplit(`python -c "print('hi there')" 'a b'`)).toEqual(['python', '-c', "print('hi there')", 'a b']);
  });
});
