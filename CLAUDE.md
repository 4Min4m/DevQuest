# DevOps Quest — Linux & Docker

A free, fully client-side, gamified web app that teaches Linux and Docker through
hands-on missions in a simulated browser terminal. Think Duolingo progression +
KodeKloud-style labs. No backend, no runtime AI calls, no recurring cost.

## Stack
- Vite + React + TypeScript
- xterm.js for the terminal UI
- Zustand for state, persisted to localStorage (export/import progress as JSON)
- Vitest for unit tests (the simulator MUST be well tested)
- Static hosting (Cloudflare Pages / GitHub Pages)

## Architecture (keep these layers separate)
1. `src/sim/vfs` — in-memory virtual filesystem (dirs, files, permissions, owner, mtime)
2. `src/sim/shell` — parser (quotes, pipes `|`, redirects `> >>`, `&&`, `;`, env vars, globbing),
   command registry, exit codes, `$?`
3. `src/sim/commands/linux` — ls, cd, pwd, cat, echo, touch, mkdir, rm, cp, mv, head, tail,
   grep, find, wc, sort, uniq, chmod, chown, ps, kill, whoami, id, env, export, df, du, curl (mocked)
4. `src/sim/docker` — simulated Docker engine: images, containers, volumes, networks, ports,
   logs, exec, a small Dockerfile parser for `docker build`, basic `docker compose up/down/ps`
5. `src/game` — lessons, missions, validators, XP/levels/streaks/hearts/badges, skill tree
6. `src/content` — lessons as JSON/YAML (NOT hardcoded in components)
7. `src/ui` — terminal pane, lesson pane, skill tree, profile, boss-fight screen

The simulator state is plain serializable data so missions can start from any
pre-built (even broken) state and validators can inspect it.

## Fidelity rules
- Output and error messages must match the real tools (e.g. `ls: cannot access 'x': No such file or directory`,
  `Error response from daemon: ...`). Exit codes must be correct.
- Unsupported commands/flags must say so clearly instead of failing silently.
- Every command gets unit tests, including error paths.

## Lesson format
Each lesson: `id`, `title`, `branch`, `prerequisites`, `theory` (short markdown),
`missions[]`. Each mission: `prompt`, `initialState` (vfs + docker state),
`hints[]` (progressive, cost XP), `validator` (declarative checks on final state, e.g.
file exists with content, container running with port mapping, command was used),
`xp`, `par` (expected command count), optional `explain` (shown after success).

Mission types: guided, free (no hints), **boss fight** (pre-broken system to diagnose
and fix: permission denied, container crash-looping, port conflict, full disk, missing volume, bad Dockerfile).

## Gamification
- Skill tree with locked branches: Linux Basics → Files & Permissions → Processes → Text Processing
  → Docker Basics → Images & Dockerfile → Volumes & Networks → Compose → Troubleshooting
- XP, levels, daily streak, 3 hearts per lesson (wrong validations / destructive mistakes cost hearts)
- Bonus XP: no hints, fewer commands than `par`
- Badges (first CrashLoop fix, 10 missions no hints, etc.), daily mission, timed Interview Mode
- Spaced review: finished missions come back as quick "recall" challenges

## MVP scope (build in this order, commit after each step)
1. Project scaffold, terminal component, shell parser, VFS, core Linux commands + tests
2. Mission engine + validators + lesson pane + 8 Linux missions
3. XP / hearts / streak / localStorage persistence / skill tree screen
4. Docker simulator (run, ps, images, stop, rm, logs, exec, volumes, ports) + tests
5. 8 Docker missions + 3 boss fights
6. Badges, daily mission, Interview Mode, deploy

## Content pipeline (later)
A Node script reads Obsidian markdown notes and uses the Claude API to draft lessons/missions
in the JSON format above. Output must be reviewed; a QA pass flags wrong or ambiguous missions.

## Working rules
- Plan first, then implement step by step; run tests after each step.
- Prefer small, composable commands; no giant files.
- Never add runtime network calls or paid services.
