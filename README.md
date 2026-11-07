# DevOps Quest

A free, fully client-side, gamified app for learning DevOps and platform engineering in a simulated
browser terminal — Linux, Docker, Git, Kubernetes, CI/CD and GitOps, AWS, Terraform, Ansible,
observability, security and incident response. No backend, no runtime network calls, no cost.

**New here? Read the [tutorial](docs/TUTORIAL.md)** — how to run it, the screens, how missions,
hints, hearts and XP work, terminal tips, and how to write your own lessons.

**Content:** 38 lessons (one per skill-tree branch) — 100 hands-on missions, 29 boss fights and 44
knowledge checks — built from the knowledge vault. See [CLAUDE.md](CLAUDE.md) for the design.

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
- **Step 9 done:** a **Git simulator** with real object ids (blobs, trees and commits hash exactly
  like Git), index, `.gitignore`, reflog, three-way merges with conflict markers, rebase,
  cherry-pick, revert, stash, tags and offline remotes (clone, fetch, pull, push with rejections,
  `--force-with-lease`, protected branches). Three lessons — Git fundamentals, Branching & merging,
  Remotes & teamwork — with 13 missions, 3 knowledge checks and 3 boss fights (lost work after a
  `reset --hard`, a release-day merge, a Friday hotfix with a rejected push).
- **Step 10 done:** a **Kubernetes cluster simulator** (3-node kind-style cluster, time-stepped
  controllers: Deployments/ReplicaSets with real rolling updates and rollbacks, DaemonSets, Jobs, a
  scheduler with requests and taints, kubelets with image pulls, CrashLoopBackOff back-off, OOMKilled,
  liveness/readiness/startup probes, ConfigMap/Secret env and volumes, Services with endpoints,
  cluster DNS, NodePorts and port-forward) and `kubectl` (get/describe/logs/exec/run/create/apply/
  delete/edit/expose/scale/set/rollout/label/top/port-forward/config, `-o yaml|json|name|jsonpath|
  custom-columns`, strict manifest validation). Three lessons — Pods & Deployments, Services &
  configuration, Probes & troubleshooting — with 13 missions, 3 knowledge checks and 3 boss fights.
- **Step 11 done:** Kubernetes part 2. **Storage:** a default `standard` StorageClass (local-path,
  WaitForFirstConsumer) that provisions PVs pinned to a node, data that outlives pods, `pvc-protection`,
  StatefulSets (ordered pods, per-pod claims, headless Services) and CronJobs. **Scheduling:**
  `taint`/`cordon`/`uncordon`/`drain` with kubectl's real refusals, tolerations, node and pod
  (anti-)affinity, an HPA driven by simulated load (`<unknown>` without requests, 5-minute scale-down
  stabilization). **Traffic:** ingress-nginx on port 80 (host/path routing, nginx 404/503/504 pages,
  `curl -H "Host: …"` or `/etc/hosts`) and enforced NetworkPolicies (blocked traffic times out, egress
  isolation breaks DNS). **RBAC:** Roles/ClusterRoles/bindings, `kubectl auth can-i`/`whoami`, `--as`
  impersonation and exact Forbidden errors. **Helm:** a Go-template engine with the Sprig functions
  charts use, `helm create/lint/template/install/upgrade/rollback/uninstall/list/history/get/status`,
  `--set`/`-f`/`--reuse-values`/`--wait`/`--atomic`, releases stored as Secrets, Helm's ownership
  checks, and an offline `bitnami` repo. Four lessons — Storage & stateful apps, Scheduling &
  autoscaling, Ingress & network policies, RBAC & Helm — with 12 missions, 4 knowledge checks and 4
  boss fights (a Pending database, Black Friday autoscaling, a dark storefront, a Forbidden pipeline).
- **Step 12 done:** CI/CD and GitOps. Pushing to a hosted remote starts **pipelines** that run on fresh,
  simulated runner machines: **GitHub Actions** (triggers with branch/path filters, `needs`/`if`,
  matrices, env/secrets/vars, step outputs, artifacts, caches, `workflow_dispatch`, invalid-workflow
  annotations, and the common marketplace actions) with `gh run list/view/watch/rerun`,
  `gh workflow run` and `gh secret`; **GitLab CI** (stages, needs, rules/only/except, manual jobs,
  artifacts, caches, protected/masked/file variables, runner tags) with `glab ci
  status/trace/trigger/retry/run/lint` and `glab variable`. A simulated `npm` (jest/eslint/vite output
  driven by each mission), `docker tag/login/push` to a registry the cluster pulls from (a tag CI never
  pushed fails with `ImagePullBackOff`). **Deployment strategies:** `kubectl patch`, `kubectl set
  selector`, Recreate/rolling knobs, blue/green, ingress-nginx canaries (weight, header, cookie).
  **Argo CD:** installed into the cluster with Application CRDs; a controller that polls Git, renders
  YAML or Helm charts, shows sync and health status, and auto-syncs with prune and self-heal; the
  `argocd app` CLI (create/set/sync/wait/diff/history/rollback/delete). Four lessons — GitHub Actions,
  pipeline design with GitLab CI, deployment strategies, GitOps with Argo CD — with 12 missions, 4
  knowledge checks and 4 boss fights (a silent pipeline, release day, a canary gone wrong, a drifted
  GitOps app).
- **Step 13 done:** Cloud and infrastructure as code. **Servers:** other simulated Linux machines on the
  network, reachable with `ssh` (keys, `-i` with real permission checks, known_hosts) and curl, with
  `apt`/`apt-get` installing packages from an Ubuntu catalog (nginx, apache2, redis, postgresql...)
  whose services start under systemd. **Ansible:** `ansible`, `ansible-playbook`, `ansible-inventory`
  with INI/YAML inventories, host patterns, `ansible.cfg`, group_vars/host_vars, a Jinja2 subset,
  the core modules (apt, copy, template, file, lineinfile, service, user, command, shell, debug,
  assert, set_fact, stat), loops, `when`, `register`, handlers, roles, blocks, tags, `--check --diff`
  and the real PLAY/TASK/RECAP output. **Mock AWS** behind one API: the `aws` CLI (credentials,
  profiles, regions, IAM allow-lists, `--query` JMESPath, json/text/table) for STS, IAM, S3 (website
  endpoints, public-access block, bucket policies, versioning) and EC2 (VPCs, subnets, internet
  gateways, route tables, security groups, key pairs, EBS, EIPs, instances that boot real simulated
  machines from user data and are reachable only when routes and security groups allow it).
  **Terraform:** an HCL2 parser and evaluator (~60 functions, unknown values), `init` (lock file,
  local modules, backends), `fmt`, `validate`, `plan` in the real diff format with drift detection,
  `apply`/`destroy` in dependency order, variables/tfvars/validation, outputs, count/for_each,
  dynamic blocks, lifecycle, data sources, `state list/show/mv/rm`, `import`, `taint`, local and S3
  backends with locks and `force-unlock`; providers aws, random, local, null. Four lessons — AWS
  fundamentals, Terraform basics, Terraform patterns & state, Ansible — with 16 missions, 4
  knowledge checks and 4 boss fights (an unreachable API, production drift, a stuck state, a
  failing deploy).

- **Step 14 done:** Observability, security and incident response. **Metrics** are models computed on
  demand (counters integrate rates, histograms follow a latency distribution) and can depend on the
  live system, so a rollback or a config fix shows up in the graphs. A **PromQL** engine (selectors,
  range vectors, rate/increase/*_over_time, histogram_quantile, aggregations, vector matching), Prometheus
  as a service with alerting and recording rules (`for:`, templated annotations, reload), its HTTP API,
  `promtool` (check rules/config, query instant/range), Alertmanager with `amtool` (alerts, silences),
  and Loki with a LogQL subset via `logcli`. **Security:** simulated X.509 with `openssl`
  (genrsa/req/x509 signing with SANs/verify/s_client/checkend), a trust store, HTTPS services and
  certificate verification in curl; `trivy` image/fs/config scanning against an offline CVE and
  misconfiguration database; `gitleaks` over the full git history; `ufw` firewalls enforced on the
  network; `sshd -t/-T` with sshd applying its config on reload; AWS access-key rotation. Three lessons —
  Metrics, logs and alerts; DevSecOps essentials; Incident response — with 11 missions, 3 knowledge
  checks and 4 boss fights (a latency regression, an audit of privileged pods, payments down after a
  DNS clean-up, a canary burning the error budget), plus 3 new badges and the [tutorial](docs/TUTORIAL.md).

### Roadmap (from the knowledge vault)

| Step | Chapters | What gets built |
|---|---|---|
| ~~8~~ | 03 Linux (rest), 02 Networking tools | ✅ done (see above) |
| ~~9~~ | 01 Version Control | ✅ done (see above) |
| ~~10~~ | 05 Kubernetes (1) | ✅ done (see above) |
| ~~11~~ | 05 Kubernetes (2) | ✅ done (see above) |
| ~~12~~ | 06 CI/CD, GitOps | ✅ done (see above) |
| ~~13~~ | 07 Cloud, 08 IaC | ✅ done (see above) |
| ~~14~~ | 09 Observability, 10 Security, 13 SRE | ✅ done (see above) — all steps complete |

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
src/sim/git/                Git: objects (SHA-1), diff/merge3, repo plumbing, ops, cli/ (porcelain)
src/sim/kube/               Kubernetes: object store, controllers (time-stepped reconcile), extra.ts
                            (storage, StatefulSets, CronJobs, HPA), images, manifest admission,
                            printers, net (DNS / NodePort / port-forward / ingress-nginx), netpol,
                            rbac, cli/
src/sim/helm/               Helm: Go-template parser + executor, Sprig functions, charts and values,
                            releases (Secrets), offline repo, the helm CLI
src/sim/forge/              GitHub/GitLab around the hosted remotes: settings, CI runs, registry
src/sim/ci/                 pipeline engines (github.ts, gitlab.ts), runner machines, marketplace
                            actions, expressions, gh / glab / npm commands
src/sim/argocd/             the argocd CLI (the controller lives in src/sim/kube/argocd.ts)
src/sim/machines/           managed servers (state.machines), apt package catalog, ssh
src/sim/ansible/            inventory, Jinja2 subset, modules, playbook runner, CLI
src/sim/aws/                mock AWS account: api.ts (one API for CLI + Terraform), shapes, jmes
                            (--query), cli.ts (aws), S3 endpoints and EC2 reachability
src/sim/terraform/          hcl.ts (parser), eval.ts + functions.ts, config.ts (modules, diagnostics),
                            engine.ts (plan), apply.ts, render.ts (plan output), providers.ts,
                            state.ts (tfstate, backends, locks), fmt.ts, cli.ts
src/sim/obs/                metrics.ts (series models), promql.ts, prometheus.ts (rules, alerts, HTTP API,
                            promtool, amtool), logs.ts (LogQL, logcli), install.ts (the monitoring stack)
src/sim/security/           tls.ts (certificates, openssl, curl verification), trivy.ts + vulndb.ts,
                            gitleaks.ts, hardening.ts (ufw, sshd)
src/game/                   mission engine: initial-state builder, validators, MissionSession;
                            progress.ts (XP, levels, streak, hearts, unlocking, skill tree),
                            store.ts (Zustand store persisted to localStorage)
src/content/lessons/*.yaml  lesson content (theory, missions, hints, checks, reference solutions)
docs/TUTORIAL.md            how to use the app and write lessons
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

`git`: `init clone config status add rm mv commit restore reset log show diff reflog tag clean
branch switch checkout merge rebase cherry-pick revert stash remote fetch pull push cat-file
hash-object rev-parse ls-files`, plus `git -C DIR` and `git -c key=value`. Remotes are simulated
(hosted URLs such as `https://github.com/acme/shop.git`, or local bare repos from `git init --bare`).
`git rebase -i` and the commit-message editor are not simulated (use `-m`).

`kubectl`: `get describe logs exec run create apply delete edit expose scale set (image|env|resources)
rollout (status|history|undo|restart|pause|resume) label annotate top port-forward config version
cluster-info api-resources`. Pods run real images from the offline catalog (nginx serves its html
directory, postgres needs `POSTGRES_PASSWORD`, busybox runs your command) or mission-defined apps.
Cluster time advances one second per command; `sleep N` or `kubectl rollout status` wait longer.

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
for the host: `serviceActive`, `serviceEnabled`, `diskUsageBelow`, `inodeUsageBelow`,
and for Git: `gitRepo`, `gitBranch`, `gitHead`, `gitClean`, `gitCommit` (message `pattern`),
`gitFile` (content at a ref), `gitHistory` (count, linear, merges), `gitTracked`, `gitStash`,
`gitRemote` (remote branch commits / files / tags), and for Kubernetes: `kubeResource` (any field
by dotted path), `kubePods` (ready / status / no crash loop), `kubeRollout`, `kubeEndpoints`, `kubeHttp`.

Host scenarios can also set `binaries` (what a program does when systemd runs it: port, required
env vars/files, DB connection, open-file needs), `dns` records, `remotes` (hosts on the network),
`perf` (load, memory, CPU), `disks` (sizes and inode counts), `bulkFiles` (thousands of small files)
a file `size` (an 18 GB log without 18 GB of content), and `gitHosted` (empty hosted remotes that
`setup` can clone and push to; `protected` branches refuse direct pushes once setup is done).
`kubeImages` defines container images (ports, HTTP routes, required env, logs, crash exit codes,
memory use, warm-up time) and `kubeManifests` pre-applies YAML to the cluster; the cluster then runs
for `setupAge` seconds before the learner arrives.
A solution line ending in `|| true` marks a step that is expected to fail (like a merge that stops
on a conflict).

`initialState.setup` runs real shell commands (e.g. `docker run ...`) to build the starting
machine, so boss fights can start from a genuinely broken system. The content QA test (`src/content/content.test.ts`) proves every
mission starts unsolved and is solved by its `solution` without errors or broken guards.
