import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';

/** A shell with nginx and alpine already pulled (keeps outputs short). */
function docker() {
  const t = makeShell();
  t.setup('docker pull nginx', 'docker pull alpine');
  return t;
}

const lines = (s: string) => s.trimEnd().split('\n');

describe('daemon access', () => {
  it('requires docker group membership', () => {
    const t = makeShell();
    t.state.groups.find((g) => g.name === 'docker')!.members = [];
    const r = t.run('docker ps');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^permission denied while trying to connect to the Docker daemon socket at unix:\/\/\/var\/run\/docker.sock/);
    expect(makeShell({ user: 'root' }).run('docker ps').code).toBe(0);
  });

  it('reports a stopped daemon', () => {
    const t = makeShell();
    t.state.docker!.daemonRunning = false;
    expect(t.run('docker images')).toEqual({
      out: '',
      err: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n',
      code: 1,
    });
  });

  it('usage, version and unknown commands', () => {
    const t = makeShell();
    expect(t.run('docker').out).toContain('Usage:  docker [OPTIONS] COMMAND');
    expect(t.run('docker --version').out).toBe('Docker version 27.3.1, build ce12230\n');
    expect(t.run('docker frob')).toMatchObject({ err: "docker: 'frob' is not a docker command.\nSee 'docker --help'\n", code: 1 });
    expect(t.run('docker push x').err).toMatch(/is not simulated/);
    expect(t.run('docker ps --bogus')).toMatchObject({ err: "unknown flag: --bogus\nSee 'docker ps --help'.\n", code: 125 });
    expect(t.run('docker stop')).toMatchObject({
      err: `"docker stop" requires at least 1 argument.\nSee 'docker stop --help'.\n\nUsage:  docker stop [OPTIONS] CONTAINER [CONTAINER...]\n`,
      code: 1,
    });
  });
});

describe('images', () => {
  it('pulls from the offline registry', () => {
    const t = makeShell();
    const r = t.run('docker pull nginx');
    expect(lines(r.out)[0]).toBe('Using default tag: latest');
    expect(r.out).toContain('latest: Pulling from library/nginx\n');
    expect(r.out).toMatch(/Status: Downloaded newer image for nginx:latest\ndocker.io\/library\/nginx:latest\n$/);
    expect(t.run('docker pull nginx').out).toContain('Status: Image is up to date for nginx:latest');
    expect(t.run('docker pull nginx:alpine').out).not.toContain('Using default tag');
  });

  it('pull errors', () => {
    const t = makeShell();
    expect(t.run('docker pull nosuchimage')).toMatchObject({
      err: "Error response from daemon: pull access denied for nosuchimage, repository does not exist or may require 'docker login': denied: requested access to the resource is denied\n",
      code: 1,
    });
    expect(t.run('docker pull nginx:9.9').err).toBe('Error response from daemon: manifest for nginx:9.9 not found: manifest unknown: manifest unknown\n');
  });

  it('lists images like docker images', () => {
    const t = docker();
    const out = lines(t.run('docker images').out);
    expect(out[0]).toBe('REPOSITORY   TAG       IMAGE ID       CREATED       SIZE');
    expect(out[1]).toMatch(/^nginx        latest    [0-9a-f]{12}   2 weeks ago   192MB$/);
    expect(out[2]).toMatch(/^alpine       latest    [0-9a-f]{12}   5 weeks ago   7.8MB$/);
    expect(lines(t.run('docker images -q').out)).toHaveLength(2);
    expect(lines(t.run('docker images alpine').out)).toHaveLength(2);
    expect(t.run('docker image ls').out).toContain('nginx');
  });

  it('removes images unless a container uses them', () => {
    const t = docker();
    t.setup('docker create --name c1 nginx');
    expect(t.run('docker rmi nginx')).toMatchObject({ code: 1 });
    expect(t.run('docker rmi nginx').err).toMatch(/conflict: unable to remove repository reference "nginx" \(must force\) - container [0-9a-f]{12} is using its referenced image/);
    t.setup('docker rm c1');
    const r = t.run('docker rmi nginx');
    expect(r.out).toMatch(/^Untagged: nginx:latest\nUntagged: nginx@sha256:[0-9a-f]{64}\nDeleted: sha256:[0-9a-f]{64}\n$/);
    expect(t.run('docker rmi nginx').err).toBe('Error response from daemon: No such image: nginx\n');
  });
});

describe('docker run', () => {
  it('pulls missing images on the fly (progress on stderr)', () => {
    const t = makeShell();
    const r = t.run('docker run -d redis');
    expect(r.err).toMatch(/^Unable to find image 'redis:latest' locally\nlatest: Pulling from library\/redis\n/);
    expect(r.out).toMatch(/^[0-9a-f]{64}\n$/);
    // progress is informational stderr: the terminal doesn't paint it as an error
    const chunks = t.shell.run('docker run -d memcached-nope 2>&1; docker run -d httpd').output;
    expect(chunks.some((c) => c.stream === 'stderr' && c.note && c.text.includes('Pulling from library/httpd'))).toBe(true);
  });

  it('foreground runs print output and return the exit code', () => {
    const t = docker();
    expect(t.run('docker run alpine echo hello world')).toEqual({ out: 'hello world\n', err: '', code: 0 });
    expect(t.run('docker run alpine sh -c "echo out; ls /nope; exit 3"')).toMatchObject({
      out: 'out\n',
      err: "ls: cannot access '/nope': No such file or directory\n",
      code: 3,
    });
    expect(t.run('docker run alpine').code).toBe(0); // sh with no TTY exits at once
    expect(t.run('docker run hello-world').out).toContain('Hello from Docker!');
  });

  it('explains long-running foreground containers', () => {
    const t = docker();
    const r = t.run('docker run --name fg nginx');
    expect(r.out).toContain('Configuration complete; ready for start up');
    expect(r.err).toContain("devquest: 'fg' keeps running in the foreground");
    expect(t.run('docker ps --format "{{.Names}} {{.State}}"').out).toBe('fg running\n');
  });

  it('missing executables fail like runc', () => {
    const t = docker();
    const r = t.run('docker run --name x1 alpine nosuchcmd');
    expect(r.code).toBe(127);
    expect(r.err).toBe(
      'docker: Error response from daemon: failed to create task for container: failed to create shim task: OCI runtime create failed: runc create failed: unable to start container process: exec: "nosuchcmd": executable file not found in $PATH: unknown.\n',
    );
    expect(t.run('docker ps -a --format "{{.Names}} {{.Status}}"').out).toBe('x1 Created\n');
  });

  it('rejects name conflicts and invalid names', () => {
    const t = docker();
    t.setup('docker run -d --name web nginx');
    const r = t.run('docker run -d --name web nginx');
    expect(r.code).toBe(125);
    expect(r.err).toMatch(
      /^docker: Error response from daemon: Conflict\. The container name "\/web" is already in use by container "[0-9a-f]{64}"\. You have to remove \(or rename\) that container to be able to reuse that name\.\n\nRun 'docker run --help' for more information\n$/,
    );
    expect(t.run('docker run --name "bad name" alpine').err).toMatch(/Invalid container name \(bad name\)/);
  });

  it('validates options', () => {
    const t = docker();
    expect(t.run('docker run').err).toMatch(/^"docker run" requires at least 1 argument\./);
    expect(t.run('docker run -p abc:80 nginx').err).toMatch(/invalid hostPort: abc/);
    expect(t.run('docker run --restart sometimes nginx').err).toMatch(/invalid restart policy: sometimes/);
    expect(t.run('docker run --rm --restart always nginx')).toMatchObject({ err: "docker: Conflicting options: --restart and --rm.\nSee 'docker run --help'.\n", code: 125 });
    expect(t.run('docker run --network nope nginx').err).toMatch(/network nope not found/);
    expect(t.run('docker run --env-file x nginx').err).toMatch(/--env-file is not supported yet/);
  });

  it('--rm removes the container after it exits', () => {
    const t = docker();
    t.run('docker run --rm alpine echo hi');
    expect(t.state.docker!.containers).toHaveLength(0);
  });

  it('-e sets the environment (and -e KEY copies from the client)', () => {
    const t = docker();
    t.run('export TOKEN=s3cret');
    expect(t.run('docker run --rm -e GREETING=hi -e TOKEN alpine env').out).toMatch(/GREETING=hi\n[\s\S]*TOKEN=s3cret/);
  });
});

describe('docker ps', () => {
  it('shows running containers in docker format', () => {
    const t = docker();
    t.setup('docker run -d --name web -p 8080:80 nginx');
    const out = lines(t.run('docker ps').out);
    expect(out[0]).toBe('CONTAINER ID   IMAGE     COMMAND                  CREATED        STATUS        PORTS                  NAMES');
    expect(out[1]).toMatch(/^[0-9a-f]{12}   nginx     "\/docker-entrypoint\.…"   1 second ago   Up 1 second   0\.0\.0\.0:8080->80\/tcp   web$/);
  });

  it('-a, -q, filters and --format', () => {
    const t = docker();
    t.setup('docker run -d --name up nginx', 'docker run --name done alpine true');
    expect(lines(t.run('docker ps').out)).toHaveLength(2);
    expect(lines(t.run('docker ps -a').out)).toHaveLength(3);
    expect(t.run('docker ps -aq').out).toMatch(/^[0-9a-f]{12}\n[0-9a-f]{12}\n$/);
    expect(t.run('docker ps -a -f status=exited --format "{{.Names}}"').out).toBe('done\n');
    expect(t.run('docker ps -a --filter name=u --format "{{.Names}}"').out).toBe('up\n');
    expect(t.run('docker ps --format "{{.Names}}: {{.Ports}}"').out).toBe('up: 80/tcp\n');
    expect(t.run('docker ps -a --format "{{.Status}}" -f name=done').out).toMatch(/^Exited \(0\) \d+ seconds? ago\n$/);
    expect(t.run('docker container ls -a -q').out.split('\n')).toHaveLength(3);
  });

  it('uptime follows the simulated clock', () => {
    const t = docker();
    t.setup('docker run -d --name web nginx', 'sleep 90');
    expect(t.run('docker ps --format "{{.Status}}"').out).toBe('Up About a minute\n');
  });
});

describe('container lifecycle', () => {
  it('stop / start / restart / rm', () => {
    const t = docker();
    t.setup('docker run -d --name web nginx');
    expect(t.run('docker stop web')).toEqual({ out: 'web\n', err: '', code: 0 });
    expect(t.run('docker ps -a --format "{{.Status}}"').out).toBe('Exited (0) 1 second ago\n');
    expect(t.run('docker start web').out).toBe('web\n');
    expect(t.run('docker restart web').out).toBe('web\n');
    expect(t.run('docker rm web')).toMatchObject({
      err: 'Error response from daemon: cannot remove container "/web": container is running: stop the container before removing or force remove\n',
      code: 1,
    });
    expect(t.run('docker rm -f web').out).toBe('web\n');
    expect(t.state.docker!.containers).toHaveLength(0);
  });

  it('PID 1 that ignores SIGTERM is killed after the timeout (exit 137)', () => {
    const t = docker();
    t.setup('docker run -d --name sl alpine sleep 1000');
    const before = t.state.clock;
    t.run('docker stop sl');
    expect(t.state.clock - before).toBeGreaterThanOrEqual(10_000);
    expect(t.run('docker ps -a --format "{{.Status}}"').out).toMatch(/^Exited \(137\)/);
  });

  it('kill sends SIGKILL by default; TERM is ignored by sleep', () => {
    const t = docker();
    t.setup('docker run -d --name sl alpine sleep 1000');
    t.run('docker kill -s TERM sl');
    expect(t.run('docker ps --format "{{.Names}}"').out).toBe('sl\n');
    expect(t.run('docker kill sl').out).toBe('sl\n');
    expect(t.run('docker ps -a --format "{{.Status}}"').out).toMatch(/^Exited \(137\)/);
    expect(t.run('docker kill sl').err).toMatch(/^Error response from daemon: cannot kill container: sl: container [0-9a-f]{64} is not running\n$/);
  });

  it('works on id prefixes and reports unknown containers', () => {
    const t = docker();
    t.setup('docker run -d --name web nginx');
    const id = t.state.docker!.containers[0].id.slice(0, 4);
    expect(t.run(`docker stop ${id}`).out).toBe(`${id}\n`);
    expect(t.run('docker stop nope web')).toMatchObject({ out: 'web\n', err: 'Error response from daemon: No such container: nope\n', code: 1 });
  });

  it('start reports failures', () => {
    const t = docker();
    t.setup('docker run -d --name aa -p 8080:80 nginx', 'docker create --name bb -p 8080:80 nginx');
    const r = t.run('docker start bb');
    expect(r.err).toMatch(/Bind for 0\.0\.0\.0:8080 failed: port is already allocated\nError: failed to start containers: bb\n$/);
    expect(r.code).toBe(1);
  });

  it('restart policies turn a crashing container into a restart loop', () => {
    const t = makeShell();
    t.setup('docker pull postgres');
    t.run('docker run -d --name db --restart always postgres');
    expect(t.run('docker ps --format "{{.Status}}"').out).toMatch(/^Restarting \(1\) /);
    const logs = t.run('docker logs db');
    expect(logs.err.match(/Database is uninitialized/g)).toHaveLength(3);
    expect(t.run('docker inspect -f "{{.RestartCount}}" db').out).toBe('2\n');
    expect(t.run('docker rm -f db').code).toBe(0);
    t.run('docker run -d --name db --restart on-failure -e POSTGRES_PASSWORD=pw postgres');
    expect(t.run('docker ps --format "{{.Status}}"').out).toMatch(/^Up/);
  });
});

describe('logs', () => {
  it('shows stdout/stderr, --tail and -t', () => {
    const t = docker();
    t.setup('docker run -d --name web -p 8080:80 nginx', 'curl -s localhost:8080/ > /dev/null', 'curl -s localhost:8080/missing > /dev/null');
    const r = t.run('docker logs web');
    expect(r.out).toContain('"GET / HTTP/1.1" 200 615 "-" "curl/8.5.0" "-"\n');
    expect(r.out).toContain('"GET /missing HTTP/1.1" 404');
    expect(r.err).toContain('open() "/usr/share/nginx/html/missing" failed (2: No such file or directory)');
    expect(t.run('docker logs --tail 1 web').out).toMatch(/^172\.17\.0\.1 - - \[03\/Nov\/2026:09:00:\d\d \+0000\] "GET \/missing HTTP\/1\.1" 404/);
    expect(t.run('docker logs -n 1 -t web').out).toMatch(/^2026-11-03T09:00:\d\d\.000000000Z 172\.17/);
    expect(t.run('docker logs -f web').err).toContain('-f (follow) is not supported');
    expect(t.run('docker logs nope').err).toBe('Error response from daemon: No such container: nope\n');
  });
});

describe('exec', () => {
  it('runs commands inside the container filesystem', () => {
    const t = docker();
    t.setup('docker run -d --name web nginx');
    expect(t.run('docker exec web cat /usr/share/nginx/html/index.html').out).toContain('Welcome to nginx!');
    expect(t.run('docker exec web sh -c "echo hi > /tmp/x && cat /tmp/x"').out).toBe('hi\n');
    expect(t.run('docker exec web cat /tmp/x').out).toBe('hi\n'); // state persists in the container
    expect(t.run('cat /tmp/x').code).toBe(1); // ...and not on the host
    expect(t.run('docker exec -e A=1 web env').out).toContain('A=1');
    expect(t.run('docker exec web whoami').out).toBe('root\n');
  });

  it('images only ship some tools', () => {
    const t = docker();
    t.setup('docker run -d --name web nginx');
    expect(t.run('docker exec web ps')).toEqual({
      out: '',
      err: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "ps": executable file not found in $PATH: unknown\n',
      code: 126,
    });
    expect(t.run('docker exec web docker ps').code).toBe(126);
  });

  it('fails on stopped containers', () => {
    const t = docker();
    t.setup('docker run --name done alpine true');
    expect(t.run('docker exec done ls').err).toMatch(/^Error response from daemon: container [0-9a-f]{64} is not running\n$/);
  });

  it('-it opens an interactive shell until exit', () => {
    const t = docker();
    t.setup('docker run -d --name web nginx');
    t.run('docker exec -it web bash');
    expect(t.shell.activeState.context?.containerName).toBe('web');
    expect(t.run('pwd').out).toBe('/\n');
    expect(t.run('cd /usr/share/nginx/html && ls').out).toBe('50x.html  index.html\n');
    expect(t.run('docker ps').err).toBe('bash: docker: command not found\n');
    expect(t.run('exit 4')).toMatchObject({ out: 'exit\n', code: 4 });
    expect(t.shell.activeState.context).toBeUndefined();
    expect(t.run('echo $?').out).toBe('4\n');
    expect(t.state.commandLog.some((e) => e.container === 'web' && e.argv[0] === 'ls')).toBe(true);
  });

  it('alpine has sh but no bash, and busybox-style errors', () => {
    const t = docker();
    t.setup('docker run -d --name al alpine sleep 1000');
    expect(t.run('docker exec -it al bash').err).toMatch(/exec: "bash": executable file not found in \$PATH/);
    t.run('docker exec -it al sh');
    expect(t.run('curl x').err).toBe('sh: curl: not found\n');
    t.run('exit');
  });

  it('docker run -it starts a container with an interactive shell', () => {
    const t = docker();
    t.run('docker run -it --name tmp alpine sh');
    expect(t.run('docker ps --format "{{.Names}}"').code).toBe(127); // inside the container: no docker
    // like bash, a bare `exit` returns the last command's status (127 here)
    t.run('exit');
    expect(t.run('docker ps -a --format "{{.Names}} {{.Status}}"').out).toMatch(/^tmp Exited \(127\)/);
  });
});

describe('ports and networking', () => {
  it('curl reaches published ports', () => {
    const t = docker();
    t.setup('docker run -d --name web -p 8080:80 nginx');
    expect(t.run('curl -s localhost:8080').out).toContain('<title>Welcome to nginx!</title>');
    expect(t.run('curl -sI localhost:8080').out).toMatch(/^HTTP\/1\.1 200 OK\n[\s\S]*Server: nginx\/1\.27\.2/);
    expect(t.run('curl -s -o /dev/null -w x localhost:8080').code).toBe(2); // unsupported curl flag is explicit
    expect(t.run('curl localhost:8081')).toMatchObject({ code: 7 });
    expect(t.run('curl -f localhost:8080/nope')).toMatchObject({ err: 'curl: (22) The requested URL returned error: 404\n', code: 22 });
  });

  it('mapping to a port nothing listens on resets the connection', () => {
    const t = docker();
    t.setup('docker run -d --name web -p 8080:8080 nginx');
    expect(t.run('curl localhost:8080')).toEqual({ out: '', err: 'curl: (56) Recv failure: Connection reset by peer\n', code: 56 });
  });

  it('port conflicts leave the container created', () => {
    const t = docker();
    t.setup('docker run -d --name aa -p 8080:80 nginx');
    const r = t.run('docker run -d --name bb -p 8080:80 nginx');
    expect(r.code).toBe(125);
    expect(r.err).toMatch(/^docker: Error response from daemon: driver failed programming external connectivity on endpoint bb \([0-9a-f]{64}\): Bind for 0\.0\.0\.0:8080 failed: port is already allocated\.\n$/);
    expect(t.run('docker ps -a -f name=bb --format "{{.Status}}"').out).toBe('Created\n');
  });

  it('-P publishes exposed ports on random host ports; docker port lists them', () => {
    const t = docker();
    t.setup('docker run -d -P --name web nginx');
    expect(t.run('docker port web').out).toBe('80/tcp -> 0.0.0.0:32768\n');
    expect(t.run('docker port web 80').out).toBe('0.0.0.0:32768\n');
    expect(t.run('docker port web 81')).toMatchObject({ err: "Error: No public port '81/tcp' published for web\n", code: 1 });
    expect(t.run('curl -s localhost:32768').code).toBe(0);
  });

  it('containers find each other by name only on user-defined networks', () => {
    const t = docker();
    t.setup('docker pull curlimages/curl', 'docker run -d --name api nginx');
    // default bridge: no DNS
    expect(t.run('docker run --rm curlimages/curl -sS http://api').err).toBe('curl: (6) Could not resolve host: api\n');
    t.setup('docker network create appnet', 'docker network connect appnet api');
    expect(t.run('docker run --rm --network appnet curlimages/curl -s http://api').out).toContain('Welcome to nginx!');
    // inside a container, localhost is the container itself
    expect(t.run('docker exec api curl -s localhost').out).toContain('Welcome to nginx!');
    // the host can reach container IPs directly
    const ip = t.run('docker inspect -f "{{.NetworkSettings.IPAddress}}" api').out.trim();
    expect(ip).toBe('172.17.0.2');
    expect(t.run(`curl -s ${ip}`).out).toContain('Welcome to nginx!');
  });

  it('network commands', () => {
    const t = docker();
    expect(t.run('docker network create appnet').out).toMatch(/^[0-9a-f]{64}\n$/);
    expect(lines(t.run('docker network ls').out)).toEqual([
      'NETWORK ID     NAME      DRIVER    SCOPE',
      expect.stringMatching(/^[0-9a-f]{12}   appnet    bridge    local$/),
      expect.stringMatching(/^[0-9a-f]{12}   bridge    bridge    local$/),
      expect.stringMatching(/^[0-9a-f]{12}   host      host      local$/),
      expect.stringMatching(/^[0-9a-f]{12}   none      null      local$/),
    ]);
    expect(t.run('docker network create appnet').err).toBe('Error response from daemon: network with name appnet already exists\n');
    t.setup('docker run -d --name web --network appnet nginx');
    expect(t.run('docker network rm appnet').err).toMatch(/has active endpoints \(name:"web"/);
    expect(t.run('docker network rm bridge').err).toBe('Error response from daemon: bridge is a pre-defined network and cannot be removed\n');
    expect(t.run('docker network inspect -f "{{.Driver}}" appnet').out).toBe('bridge\n');
    t.setup('docker rm -f web');
    expect(t.run('docker network rm appnet').out).toBe('appnet\n');
  });
});

describe('volumes and bind mounts', () => {
  it('named volumes persist data across containers', () => {
    const t = makeShell();
    t.setup('docker pull postgres');
    t.run('docker run -d --name db1 -e POSTGRES_PASSWORD=pw -v pgdata:/var/lib/postgresql/data postgres');
    expect(t.run('docker exec db1 cat /var/lib/postgresql/data/PG_VERSION').out).toBe('17\n');
    t.setup('docker rm -f db1');
    // the data survives; a new container doesn't even need the password any more
    t.run('docker run -d --name db2 -v pgdata:/var/lib/postgresql/data postgres');
    expect(t.run('docker logs db2').out).toContain('Skipping initialization');
    expect(t.run('docker ps --format "{{.Names}} {{.State}}"').out).toBe('db2 running\n');
  });

  it('new named volumes are pre-filled from the image', () => {
    const t = docker();
    t.setup('docker run -d --name web -v html:/usr/share/nginx/html nginx');
    t.run('docker run --rm -v html:/data alpine sh -c "echo changed > /data/index.html"');
    expect(t.run('docker exec web cat /usr/share/nginx/html/index.html').out).toBe('changed\n');
    expect(t.run('docker exec web ls /usr/share/nginx/html').out).toBe('50x.html  index.html\n');
  });

  it('volume commands', () => {
    const t = docker();
    expect(t.run('docker volume create data').out).toBe('data\n');
    expect(t.run('docker volume ls').out).toBe('DRIVER    VOLUME NAME\nlocal     data\n');
    expect(t.run('docker volume inspect -f "{{.Mountpoint}}" data').out).toBe('/var/lib/docker/volumes/data/_data\n');
    t.setup('docker run -d --name ww -v data:/x nginx');
    expect(t.run('docker volume rm data').err).toMatch(/^Error response from daemon: remove data: volume is in use - \[[0-9a-f]{64}\]\n$/);
    t.setup('docker rm -f ww');
    expect(t.run('docker volume rm data').out).toBe('data\n');
    expect(t.run('docker volume rm data').err).toBe('Error response from daemon: get data: no such volume\n');
    expect(t.run('docker volume create "bad name"').err).toMatch(/includes invalid characters for a local volume name/);
  });

  it('anonymous volumes are removed with rm -v', () => {
    const t = docker();
    t.setup('docker run -d --name ww -v /cache nginx');
    expect(t.state.docker!.volumes).toHaveLength(1);
    t.setup('docker rm -fv ww');
    expect(t.state.docker!.volumes).toHaveLength(0);
  });

  it('bind mounts share the host directory live (relative paths need ./)', () => {
    const t = docker();
    t.setup('mkdir site', 'echo v1 > site/index.html', 'docker run -d --name web -p 8080:80 -v ./site:/usr/share/nginx/html nginx');
    expect(t.run('curl -s localhost:8080').out).toBe('v1\n');
    t.run('echo v2 > site/index.html');
    expect(t.run('curl -s localhost:8080').out).toBe('v2\n');
    t.run('docker exec web sh -c "echo from-container > /usr/share/nginx/html/new.txt"');
    expect(t.read('/home/student/site/new.txt')).toBe('from-container\n');
    // `site:/...` (no ./) is a *volume* named site, not the folder
    t.setup('docker run -d --name web2 -v site:/usr/share/nginx/html nginx');
    expect(t.run('docker volume ls -q').out).toBe('site\n');
  });

  it('validates mount specs', () => {
    const t = docker();
    expect(t.run('docker run -v data:relative nginx').err).toMatch(/invalid mount path: 'relative' mount path must be absolute/);
    expect(t.run('docker run -v ./x:/y:ro nginx').err).toMatch(/mount options \('ro'\) are not supported in devquest yet/);
    expect(t.run('docker run -v "my vol":/data nginx').err).toMatch(/"my vol" includes invalid characters for a local volume name.*If you intended to pass a host directory, use absolute path/);
  });
});

describe('inspect', () => {
  it('prints JSON and supports --format', () => {
    const t = docker();
    t.setup('docker run -d --name web -p 8080:80 -e MODE=prod nginx');
    const json = JSON.parse(t.run('docker inspect web').out);
    expect(json[0]).toMatchObject({
      Name: '/web',
      State: { Status: 'running', Running: true, ExitCode: 0 },
      Config: { Image: 'nginx', ExposedPorts: { '80/tcp': {} } },
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] }, RestartPolicy: { Name: 'no' } },
      NetworkSettings: { IPAddress: '172.17.0.2' },
    });
    expect(json[0].Config.Env).toContain('MODE=prod');
    expect(t.run('docker inspect --format "{{json .State.Running}}" web').out).toBe('true\n');
    expect(t.run('docker inspect -f "{{.Config.WorkingDir}}" nginx').out).toBe('\n');
    expect(t.run('docker image inspect -f "{{.Os}}" nginx').out).toBe('linux\n');
    const missing = t.run('docker inspect nope');
    expect(missing).toEqual({ out: '[]\n', err: 'Error: No such object: nope\n', code: 1 });
    expect(t.run('docker inspect -f "{{.Nope}}" web').code).toBe(1);
  });
});

describe('container programs', () => {
  it('nginx refuses a broken config', () => {
    const t = docker();
    t.setup('mkdir conf', 'echo "server { listen 80 }" > conf/default.conf');
    t.run('docker run -d --name web -v ./conf:/etc/nginx/conf.d nginx');
    expect(t.run('docker ps -a --format "{{.Status}}"').out).toMatch(/^Exited \(1\)/);
    expect(t.run('docker logs web').err).toContain('nginx: [emerg] unexpected "}" in /etc/nginx/conf.d/default.conf:1');
  });

  it('nginx listens where its config says', () => {
    const t = docker();
    t.setup('mkdir conf', 'echo "server { listen 8080; root /usr/share/nginx/html; }" > conf/default.conf');
    t.setup('docker run -d --name web -p 9000:80 -v ./conf:/etc/nginx/conf.d nginx');
    expect(t.run('curl localhost:9000').code).toBe(56);
    t.setup('docker rm -f web', 'docker run -d --name web -p 9000:8080 -v ./conf:/etc/nginx/conf.d nginx');
    expect(t.run('curl -s localhost:9000').out).toContain('Welcome to nginx!');
  });

  it('mysql needs a root password', () => {
    const t = makeShell();
    t.setup('docker pull mysql');
    expect(t.run('docker run mysql').err).toContain('Database is uninitialized and password option is not specified');
    t.run('docker run -d --name my -e MYSQL_ROOT_PASSWORD=x mysql');
    expect(t.run('docker ps --format "{{.Ports}}"').out).toBe('3306/tcp, 33060/tcp\n');
  });

  it('python and node scripts', () => {
    const t = makeShell();
    t.setup('docker pull python', 'docker pull node', 'mkdir app');
    t.vfs().writeFile('/home/student/app/app.py', 'import os\nprint("starting")\nkey = os.environ["API_KEY"]\nport = 5000\n');
    expect(t.run('docker run --rm -v /home/student/app:/app -w /app python python3 app.py')).toMatchObject({
      err: expect.stringContaining("KeyError: 'API_KEY'"),
      code: 1,
    });
    t.run('docker run -d --name py -p 5000:5000 -e API_KEY=k -v /home/student/app:/app -w /app python python3 app.py');
    expect(t.run('docker logs py').out).toBe('starting\n');
    expect(t.run('curl -s localhost:5000').out).toBe('OK\n');
    expect(t.run('docker run --rm python python3 missing.py')).toMatchObject({
      err: "python3: can't open file '/missing.py': [Errno 2] No such file or directory\n",
      code: 2,
    });
    expect(t.run('docker run --rm node node server.js').err).toContain("Error: Cannot find module '/server.js'");
    expect(t.run('docker run --rm python python3 -c "print(\'hi\')"').out).toBe('hi\n');
    t.run('docker run -d --name files -p 8000:8000 -v /home/student/app:/srv -w /srv python python3 -m http.server');
    expect(t.run('curl -s localhost:8000/').out).toContain('<li><a href="app.py">app.py</a></li>');
  });

  it('redis is not an HTTP server', () => {
    const t = makeShell();
    t.setup('docker pull redis', 'docker run -d --name cache -p 6379:6379 redis');
    expect(t.run('curl localhost:6379')).toMatchObject({ err: 'curl: (1) Received HTTP/0.9 when not allowed\n', code: 1 });
  });

  it('host network mode skips port publishing', () => {
    const t = docker();
    const r = t.run('docker run -d --name hn --network host -p 9999:80 nginx');
    expect(r.err).toContain('WARNING: Published ports are discarded when using host network mode');
    expect(t.run('curl -s localhost:80').out).toContain('Welcome to nginx!');
  });
});
