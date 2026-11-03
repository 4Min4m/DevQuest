# DevOps Quest

A free, fully client-side, gamified app for learning Linux and Docker in a simulated
browser terminal. No backend, no runtime network calls. See [CLAUDE.md](CLAUDE.md) for the full design.

## Status

- **Step 1 done:** project scaffold, virtual filesystem, shell parser/executor and the core
  Linux commands, all unit-tested, wired to an xterm.js terminal page.
- **Step 2 done:** mission engine, declarative validators, lesson pane and 8 Linux missions
  (Linux Basics, Files & Permissions, Processes, Text Processing).

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
src/game/                   mission engine: initial-state builder, validators, MissionSession
src/content/lessons/*.yaml  lesson content (theory, missions, hints, checks, reference solutions)
src/ui/terminal/            line editor (history, Ctrl keys, Tab) + xterm.js pane
src/ui/lesson/              lesson list + mission pane
scripts/sim-cli.ts          run the simulator in a real terminal
```

## Simulated commands

`ls cd pwd cat echo touch mkdir rm cp mv head tail grep find wc sort uniq chmod chown
ps kill whoami id env export unset df du curl help history clear true false`

Run `<command> --help` to see which options the simulator supports. Real commands that
aren't simulated yet (e.g. `sed`, `vim`, `sudo`) say so explicitly instead of failing silently.

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
`outputContains`, `anyOf`, `not`. The content QA test (`src/content/content.test.ts`) proves every
mission starts unsolved and is solved by its `solution` without errors or broken guards.
