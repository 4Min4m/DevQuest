# DevOps Quest

A free, fully client-side, gamified app for learning Linux and Docker in a simulated
browser terminal. No backend, no runtime network calls. See [CLAUDE.md](CLAUDE.md) for the full design.

## Status

- **Step 1 done:** project scaffold, virtual filesystem, shell parser/executor and the core
  Linux commands, all unit-tested, wired to an xterm.js terminal page.
- **Step 2 done:** mission engine, declarative validators, lesson pane and 8 Linux missions
  (Linux Basics, Files & Permissions, Processes, Text Processing).
- **Step 3 done:** XP and levels, daily streak, 3 hearts per lesson, unlocking, skill tree
  and profile screens, progress saved in localStorage with JSON export/import.
- **Step 4 done:** simulated Docker engine — images, containers, ports, logs, exec (including
  interactive `exec -it` shells), volumes, bind mounts, networks with container DNS, inspect —
  plus a free-play Sandbox page.
- **Step 5 done:** `docker build` (Dockerfile interpreter) and `docker compose`, a `nano` editor,
  Docker validators, and 8 Docker missions + 3 boss fights (CrashLoop, port conflict, broken nginx config).

## Develop

```bash
npm install
npm run dev        # http://localhost:5173 — lessons + terminal
npm test           # Vitest suite
npm run typecheck
npm run build      # static site in dist/
npm run sim -- 'ls -la' 'cat /etc/passwd | grep student'   # drive the simulator from your shell
```

## Layout

```
src/sim/state.ts            SimState: the whole simulated machine as serializable data
src/sim/vfs/                in-memory filesystem (modes, owners, mtimes, errno-style errors)
src/sim/shell/              lexer/parser → AST, expansion ($VAR, ~, globs), executor
                            (pipes, > >> < 2> 2>&1 &>, && || ;), tab completion
src/sim/commands/linux/     one module per command group, each with tests
src/sim/docker/             Docker engine: catalog (offline registry), programs (what runs in
                            containers: nginx, postgres, redis, python/node apps...), engine,
                            build.ts (Dockerfile), compose.ts (Compose v2),
                            cli/ (docker run, ps, exec, logs, build, compose, volume, network...)
src/sim/net.ts              simulated HTTP for curl (containers register as providers)
src/game/                   mission engine: initial-state builder, validators, MissionSession;
                            progress.ts (XP, levels, streak, hearts, unlocking, skill tree),
                            store.ts (Zustand store persisted to localStorage)
src/content/lessons/*.yaml  lesson content (theory, missions, hints, checks, reference solutions)
src/ui/terminal/            line editor (history, Ctrl keys, Tab) + xterm.js pane
src/ui/lesson/              lesson list + mission pane
src/ui/tree/, src/ui/profile/  skill tree and profile (export / import / reset) screens
scripts/sim-cli.ts          run the simulator in a real terminal
```

## Simulated commands

`ls cd pwd cat echo touch mkdir rm cp mv head tail grep find wc sort uniq chmod chown
ps kill whoami id env export unset df du curl help history clear true false`

`docker`: `run create ps start stop restart kill rm logs exec port inspect images pull rmi`,
`volume create|ls|rm|inspect|prune`, `network create|ls|rm|inspect|connect|disconnect`,
`build`, `compose up|down|ps|logs|exec|build|start|stop|restart|config`, `container …` / `image …`
aliases. Offline images: nginx, httpd, redis, postgres, mysql, alpine, busybox, ubuntu, node, python,
hello-world, curlimages/curl. `nano FILE` (also `vi`/`vim`) opens a simple editor in the browser.

Run `<command> --help` to see which options the simulator supports. Real commands that
aren't simulated yet (e.g. `sed`, `vim`, `sudo`) say so explicitly instead of failing silently.

## Game rules

- **XP** per mission = base XP − hint costs (never below 25 % of base) + 20 % for no hints
  + 20 % for finishing within `par` commands. Replays only award the improvement over your best.
- **Levels** need 100, 300, 600, 1000… total XP.
- **Hearts:** each lesson has 3. A failed Check or a broken guard costs one; at zero the mission
  fails and you retry with full hearts. Completing a lesson refills them.
- **Streak:** complete at least one mission per calendar day.
- **Unlocking:** a lesson opens when its prerequisites are complete; missions open in order.

## Writing missions

Lessons are YAML files in `src/content/lessons/`, validated at load time (`src/content/schema.ts`).
A mission declares how its machine differs from the default one, the checks that define
success, and optional **guards** (things that must stay true — breaking one is a
"destructive mistake" and blocks success until Reset):

```yaml
- id: lock-down-secrets
  type: free            # guided | free (no hints) | boss
  prompt: Make ~/secrets.env private and move it into ~/config/
  initialState:
    files:
      /home/student/secrets.env: { content: "DB_PASSWORD=hunter2\n", mode: "666" }
  hints: []
  validator:
    checks:
      - { type: fileMode, path: /home/student/config/secrets.env, mode: "600" }
    guards:
      - { type: fileExists, path: /home/student/config/secrets.env, message: Don't delete the secret }
  xp: 30
  par: 2
  solution: [chmod 600 secrets.env, mv secrets.env config/]
```

Check types: `fileExists`, `fileMissing`, `fileContains` (text / regex / equals), `fileMode`,
`fileOwner`, `cwd`, `varEquals`, `processRunning`, `processAbsent`, `commandUsed`,
`outputContains`, `anyOf`, `not`, and for Docker: `containerRunning`, `containerAbsent`,
`containerPort`, `containerEnv`, `containerMount`, `containerNetwork`, `containerInspect`,
`containerFile`, `imageExists`, `imageInspect`, `volumeExists`, `networkExists`, `httpResponds`.

`initialState.setup` runs real shell commands (e.g. `docker run ...`) to build the starting
machine, so boss fights can start from a genuinely broken system. The content QA test (`src/content/content.test.ts`) proves every
mission starts unsolved and is solved by its `solution` without errors or broken guards.
