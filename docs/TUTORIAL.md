# DevOps Quest — how to use it

DevOps Quest is a free practice ground for DevOps and platform engineering. Everything runs in your
browser: the terminal, the Linux machines, Docker, a Kubernetes cluster, Git hosting with CI, a mock
AWS account, Terraform, Ansible, Prometheus — all simulated. Nothing you type touches a real system,
nothing costs money, and you can't break anything that a **Reset machine** won't fix.

- [1. Start it](#1-start-it)
- [2. The screens](#2-the-screens)
- [3. Playing a mission](#3-playing-a-mission)
- [4. XP, hearts, streaks and badges](#4-xp-hearts-streaks-and-badges)
- [5. Using the terminal](#5-using-the-terminal)
- [6. What you can practise](#6-what-you-can-practise)
- [7. Your progress and data](#7-your-progress-and-data)
- [8. A suggested learning path](#8-a-suggested-learning-path)
- [9. Tips when you're stuck](#9-tips-when-youre-stuck)
- [10. Writing your own lessons](#10-writing-your-own-lessons)
- [11. Known limits](#11-known-limits)

## 1. Start it

**Hosted:** after merging to `main`, the GitHub Actions workflow `.github/workflows/deploy.yml`
publishes the site to GitHub Pages (enable *Settings → Pages → Source: GitHub Actions* once). Open the
Pages URL and play. Any static host works too (Cloudflare Pages, Netlify, S3…): upload `dist/`.

**Locally** (Node 20+):

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts: `npm test` (the simulator and every lesson's reference solution are tested),
`npm run build` (static site in `dist/`), `npm run preview` (serve the build),
`npm run sim -- 'ls -la' 'docker ps'` (drive the simulator from your own terminal).

## 2. The screens

The header has four tabs and your level, XP bar and streak 🔥.

| Screen | What it's for |
|---|---|
| **Skill tree** (home) | Today's panel (daily mission, recall challenges, Interview Mode), then every branch grouped by track. Click a lesson to open it. |
| **Interview** | A timed mock interview: 3 random missions you've already solved, 10 minutes, no hints. |
| **Sandbox** | A throwaway Linux + Docker machine with no task — experiment freely. |
| **Profile** | Level, totals, badges, and your data (export / import / reset). |

**Tracks and branches.** *Theory & interviews* (Foundations, Networking, Storage & Databases, System
Design, SRE) is open from the start — knowledge checks built from the notes. The hands-on tracks unlock
lesson by lesson: Linux → Containers → Git → Kubernetes → Delivery (CI/CD, GitOps) → Cloud & IaC (AWS,
Terraform, Ansible) → Observability & Security (metrics, alerts, DevSecOps, incident response).
A locked lesson tells you which lesson to finish first.

**Inside a lesson** the left pane shows the lesson list, the theory (short, read it once) and the
current mission; the right pane is your terminal on that mission's machine.

## 3. Playing a mission

1. **Read the prompt.** The bold sentence is the goal; the rest is context.
2. **Work in the terminal** exactly as you would on a real box. There is no "right command" to type —
   the mission checks the *result* (a file exists with the right content, a container runs with the
   right port, a pod is healthy, an alert stops firing, a bucket is public...).
3. **The mission completes by itself** as soon as the goal is met — you'll see
   *✓ Mission complete!* in the terminal and the reward panel on the left.
4. **Check** asks "what's still missing?" and lists each unmet goal. A failed check costs a heart, so
   use it when you think you're done, not as a probe.
5. **Hint** reveals the next hint (they get more concrete) and costs a little XP.
6. **Reset machine** restores the starting state (your mission progress — hints, hearts — stays).
7. After success, the **explanation** tells you why it worked and what professionals do in practice.
   **Next mission** moves on; **Replay** starts it again.

**Mission types**

| Type | Hints | What to expect |
|---|---|---|
| Guided | yes | One concept at a time, with progressive hints. |
| Free | no | Same kind of task, you're on your own. |
| Boss fight | no | A broken, realistic system ("payments is down", "the canary is burning the budget"). Diagnose first, then fix. |
| Knowledge check | — | Multiple-choice questions; you can skip, but skipped counts as unsolved. |

**Guards.** Some missions also list things you must *not* break ("keep the receipts bucket", "don't
lock yourself out of SSH"). Breaking a guard is a destructive mistake: it costs a heart and blocks
success until you reset.

## 4. XP, hearts, streaks and badges

- **XP** for each mission, plus bonuses for **no hints** and for finishing **within par** (the number
  of commands an experienced engineer needs). Levels come from total XP.
- **Hearts:** 3 per lesson. Failed checks and broken guards cost one. At zero the mission stops; retry
  and your hearts refill — it's a nudge to slow down and reread, not a punishment.
- **Streak:** complete at least one mission a day.
- **Daily mission:** one mission picked for today, with bonus XP.
- **Recall challenges:** missions you solved days ago come back without hints or theory (spaced
  repetition). Solving them keeps knowledge from fading.
- **Interview Mode:** 3 random solved missions against a 10-minute clock.
- **Badges:** first mission, Linux graduate, CrashLoop fixer, Infrastructure coder, Hardened, Pager hero,
  Boss slayer, Hint-free, streak badges and more — see Profile.

## 5. Using the terminal

It's a bash-like shell with real-looking output and real exit codes.

| Keys | Action |
|---|---|
| ↑ / ↓ | command history |
| Tab | complete commands and paths |
| Ctrl+C | cancel the line · Ctrl+L clear screen · Ctrl+U / Ctrl+K cut to start / end · Ctrl+W delete word |
| `nano FILE` | an editor in the browser (Ctrl+O save, Ctrl+X exit) |
| `help` | list every simulated command; most commands accept `--help` |

**Shell features:** pipes `|`, redirects `> >> < 2> 2>&1 &>`, `&& || ;`, quotes, `$VAR` and `$?`,
`export`, globs `* ? [..]`, `sudo` (you're in the sudo group), `cd -`, `history`.

**Simulated time.** Each command advances the clock a little; `sleep 5m` jumps five minutes (useful to
let a rollout finish, a metric window refresh or an alert resolve).

**Other machines.** `ssh ubuntu@web1` opens a shell on a server (the prompt changes; `exit` returns).
Kubernetes pods: `kubectl exec -it POD -- sh`. Containers: `docker exec -it NAME sh`.

## 6. What you can practise

| Area | Tools in the simulator |
|---|---|
| Linux | files, permissions, users, processes, text processing (grep, sed, sort, uniq, wc, find…), systemd (`systemctl`, `journalctl`, unit files), networking (`ss`, `ip`, `dig`, `ping`, `curl`), disks and performance (`df`, `du`, `lsof`, `top`, `free`), `apt` |
| Containers | `docker` run/ps/logs/exec/build/volumes/networks/ports, Dockerfiles, `docker compose` |
| Git | the full local workflow, branches, merges and conflicts, rebase, stash, remotes with push/pull/PRs |
| Kubernetes | a 3-node cluster: Deployments, Services, ConfigMaps/Secrets, probes, storage, StatefulSets, Jobs, HPA, Ingress, NetworkPolicies, RBAC, Helm |
| Delivery | GitHub Actions and GitLab CI pipelines (`gh`, `glab`), a container registry, deployment strategies, Argo CD |
| Cloud & IaC | a mock AWS account (`aws` CLI: IAM, S3, EC2/VPC), Terraform (init/plan/apply, modules, remote state), Ansible (inventories, playbooks, roles) |
| Observability | Prometheus/PromQL (`promtool`), alert rules, Alertmanager (`amtool`), Loki logs (`logcli`) |
| Security | `trivy` (images, IaC, secrets), `gitleaks`, `openssl` and TLS, `ufw`, `sshd`, key rotation |

The output is modelled on the real tools (messages, tables, exit codes), so what you learn transfers.
Credentials and keys in missions are fake.

## 7. Your progress and data

Progress lives in your browser's localStorage — no account, no server. On **Profile**:

- **Export** downloads a JSON file (back it up, or move to another browser/device),
- **Import** restores such a file,
- **Reset** starts over.

Clearing site data for the page also erases progress, so export now and then.

## 8. A suggested learning path

1. Linux Basics → Files & Permissions → Processes → Text Processing (the foundation for everything).
2. Docker Basics → Images & Dockerfile → Volumes & Networks → Compose → Troubleshooting.
3. Services (systemd), Network Troubleshooting, Performance & Disks.
4. Git (fundamentals, branching, remotes).
5. Kubernetes (seven lessons), then CI/CD, deployment strategies and GitOps.
6. AWS → Terraform basics → Terraform patterns → Ansible.
7. Observability → Security → Incident Response.

Do the theory knowledge checks alongside (they're short), take the daily mission, and run an Interview
Mode session once a week. Aim for "no hints, within par" on the second pass.

## 9. Tips when you're stuck

- **Read the error message** — it's the real tool's message and usually says exactly what's wrong.
- Use **Check** to see which goal is still unmet (cheap compared to guessing).
- Investigate before fixing, as on call: `systemctl status`, `journalctl -u`, `docker logs`,
  `kubectl describe` / `logs`, `terraform plan`, `amtool alert`.
- A command "isn't simulated"? The simulator says so explicitly — use the tool the lesson teaches.
- Took a wrong turn? **Reset machine** and start clean.

## 10. Writing your own lessons

Lessons are YAML files in `src/content/lessons/` (no code changes needed for most content):

```yaml
id: my-lesson
title: My lesson
branch: linux-basics          # a branch from src/game/progress.ts
prerequisites: [processes]    # hands-on lessons: one earlier lesson
theory: |
  Short markdown...
missions:
  - id: unique-id
    title: Do the thing
    type: guided              # guided | free | boss | quiz
    prompt: |
      Context... **The goal in bold.**
    initialState:             # files, setup commands, machines, aws, kube manifests, metrics...
      files:
        /home/student/notes.txt: "hello\n"
      setup:
        - mkdir -p /home/student/out
    hints:
      - { text: "First nudge", cost: 5 }
    validator:
      checks:
        - { type: fileContains, path: /home/student/out/result.txt, text: hello }
      guards: []
    xp: 40
    par: 3
    solution:                 # the reference solution; tests run it against the validator
      - cp notes.txt out/result.txt
    explain: |
      Why it works...
```

`src/game/types.ts` documents every `initialState` field and every check type (files, processes,
containers, Kubernetes objects, Git, CI runs, AWS resources, Terraform state, Prometheus alerts,
certificates, firewall reachability…). `npm test` verifies that each mission starts unsolved, that its
reference solution solves it within par, and that the solution prints no errors.

## 11. Known limits

- The shell has no `$(...)` command substitution, here-documents or loops — use pipes, files and
  `printf` / `echo` instead.
- Tools implement the commonly used subset of their commands and flags; anything else says it isn't
  simulated rather than failing silently.
- Remote resources are offline: Docker images come from a built-in catalog, Terraform modules must be
  local, Helm charts come from a built-in repo.
