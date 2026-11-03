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
- **Step 6 done:** 16 badges, daily mission, spaced-review recall challenges, timed Interview Mode,
  CI and GitHub Pages deployment.
- **Step 7 done:** knowledge checks (quiz missions) and the **Theory & interviews** track, built from
  the knowledge vault: Foundations, Networking, Storage & Databases, System Design, SRE (22 checks).
- **Step 8 done:** the rest of Linux plus network tools. `sudo`, simulated **systemd** (unit files,
  `systemctl`, `journalctl`, restart loops, `daemon-reload`), a simulated **network** (DNS zone,
  `/etc/hosts`, remote hosts: `dig`, `nslookup`, `host`, `ping`, `traceroute`, `ss`, `netstat`, `ip`,
  `curl -v / -w`), **performance** tools (`top`, `free`, `uptime`, `vmstat`, `pgrep`, `lsof`,
  `ulimit`, `/proc`), real disk accounting (`df -i`, ENOSPC for full disks and exhausted inodes),
  and `sed` / `tee`. Three new Linux lessons (Services, Network troubleshooting, Performance &
  disks) with 7 missions, 3 knowledge checks and 4 boss fights: a crash-looping API,
  "it's always DNS", disk full at 2 AM, and inode exhaustion.

### Roadmap (from the knowledge vault)

| Step | Chapters | What gets built |
|---|---|---|
| ~~8~~ | 03 Linux (rest), 02 Networking tools | ✅ done (see above) |
| 9 | 01 Version Control | Git simulator (commit, branch, merge, rebase, stash, cherry-pick, remotes) + missions |
| 10–11 | 05 Kubernetes | `kubectl` simulator: workloads, services, config, probes, scheduling, HPA, storage, RBAC, Helm |
| 12 | 06 CI/CD, GitOps | Pipeline runner (GitHub Actions / GitLab CI), deployment strategies, ArgoCD-style sync |
| 13 | 07 Cloud, 08 IaC | Terraform, Ansible, mock AWS |
| 14 | 09 Observability, 10 Security | PromQL, logs, alerting, DevSecOps + incident boss fights |

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
src/sim/net.ts              simulated HTTP for curl (containers, services, remote hosts register as providers)
src/sim/netsim/             DNS zone, /etc/hosts resolution, remote hosts; dig, ping, ss, ip...
src/sim/systemd/            unit-file parser, service manager (failure modes), systemctl, journalctl
src/sim/disk.ts             disk usage per mount (bytes + inodes) and the ENOSPC guard
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

`ls cd pwd cat echo touch mkdir rm cp mv head tail grep find wc sort uniq sed tee chmod chown
ps kill whoami id env export unset df du curl help history clear true false sudo`

Services and diagnostics: `systemctl` (status, start, stop, restart, reload, enable, disable,
is-active, is-enabled, is-failed, cat, daemon-reload, list-units, reset-failed), `journalctl`
(`-u`, `-n`, `-p`, `-xeu`), `dig`, `nslookup`, `host`, `ping`, `traceroute`, `ss`, `netstat`, `ip`,
`hostname`, `top`, `free`, `uptime`, `vmstat`, `nproc`, `pgrep`, `lsof`, `ulimit`.

`docker`: `run create ps start stop restart kill rm logs exec port inspect images pull rmi`,
`volume create|ls|rm|inspect|prune`, `network create|ls|rm|inspect|connect|disconnect`,
`build`, `compose up|down|ps|logs|exec|build|start|stop|restart|config`, `container …` / `image …`
aliases. Offline images: nginx, httpd, redis, postgres, mysql, alpine, busybox, ubuntu, node, python,
hello-world, curlimages/curl. `nano FILE` (also `vi`/`vim`) opens a simple editor in the browser.

Run `<command> --help` to see which options the simulator supports. Real commands that
aren't simulated yet (e.g. `awk`, `tcpdump`, `strace`) say so explicitly instead of failing silently.

## Deploy

It's a static site (`npm run build` → `dist/`) with hash-based routing, so it works on any static host
and from any sub-path.

- **GitHub Pages:** `.github/workflows/deploy.yml` builds, tests and publishes `main`. One-time setup:
  *Settings → Pages → Build and deployment → Source: GitHub Actions*. The site appears at
  `https://<user>.github.io/<repo>/`.
- **Cloudflare Pages:** connect the repository; build command `npm run build`, output directory
  `dist`, environment variable `NODE_VERSION=22`.
- **Locally / offline:** `npm run build && npx vite preview`, or serve `dist/` with any static server.

`.github/workflows/ci.yml` runs typecheck, tests and build on every push and pull request.

## Game rules

- **XP** per mission = base XP − hint costs (never below 25 % of base) + 20 % for no hints
  + 20 % for finishing within `par` commands. Replays only award the improvement over your best.
- **Levels** need 100, 300, 600, 1000… total XP.
- **Hearts:** each lesson has 3. A failed Check or a broken guard costs one; at zero the mission
  fails and you retry with full hearts. Completing a lesson refills them.
- **Streak:** complete at least one mission per calendar day.
- **Unlocking:** a lesson opens when its prerequisites are complete; missions open in order.
- **Recall challenges (spaced review):** finished missions come back after 1, 3, 7, 14, 30, 60 days.
  No hints, separate practice hearts; a clean recall is worth 30 % of the mission XP. Failing resets the interval.
- **Daily mission:** picked when the day starts (most overdue review, else your next new mission);
  finishing it pays +25 XP.
- **Interview Mode:** 3 random missions you've completed, 10 minutes, no hints. 15 XP per solve,
  +30 for solving all in time.
- **Badges:** 16, from *First steps* and *CrashLoop fixer* to *Boss slayer*, *Flawless* (a lesson
  without losing a heart) and *Hired!* (pass an interview). See them on the Profile page.

## Knowledge checks

Theory chapters use `type: quiz` missions answered in the lesson pane instead of the terminal.
Wrong answers cost a heart and the question comes back at the end; the mission passes when every
question is answered correctly. Question kinds:

```yaml
- kind: single      # options + answer (index)
- kind: multi       # options + answers (indices)
- kind: number      # answer, optional tolerance and unit ("1,000" and "43.2 min" are accepted)
- kind: order       # items listed in the correct order; the UI shuffles them
- kind: text        # accept: exact strings (case-insensitive) or /regex/
```

Lessons can list `sources:` (notes in the knowledge vault, e.g. `02-Networking/02-DNS`), shown in the
lesson pane. Content QA checks that every correct answer grades as correct and a wrong one doesn't.

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
`containerFile`, `imageExists`, `imageInspect`, `volumeExists`, `networkExists`, `httpResponds`,
and for the host: `serviceActive`, `serviceEnabled`, `diskUsageBelow`, `inodeUsageBelow`.

Host scenarios can also set `binaries` (what a program does when systemd runs it: port, required
env vars/files, DB connection, open-file needs), `dns` records, `remotes` (hosts on the network),
`perf` (load, memory, CPU), `disks` (sizes and inode counts), `bulkFiles` (thousands of small files)
and a file `size` (an 18 GB log without 18 GB of content).

`initialState.setup` runs real shell commands (e.g. `docker run ...`) to build the starting
machine, so boss fights can start from a genuinely broken system. The content QA test (`src/content/content.test.ts`) proves every
mission starts unsolved and is solved by its `solution` without errors or broken guards.
