/**
 * The simulated code-hosting platforms (GitHub, GitLab) around the hosted Git remotes:
 * repository settings (secrets, variables, environments), CI runs, caches and artifacts,
 * plus a container registry. Plain JSON, so it lives inside SimState.
 */

export type ForgeKind = 'github' | 'gitlab';

export type JobStatus =
  /** Not started yet (waiting for earlier jobs). */
  | 'created'
  /** Waiting for someone to start it (GitLab `when: manual`). */
  | 'manual'
  /** No runner matches its labels / tags. */
  | 'stuck'
  | 'success'
  | 'failure'
  | 'skipped'
  | 'cancelled';

export interface CiStep {
  name: string;
  status: 'success' | 'failure' | 'skipped';
  startedAt: number;
  completedAt: number;
  log: string[];
}

export interface CiJob {
  id: number;
  name: string;
  /** Key in the config (before matrix expansion). */
  key: string;
  /** GitLab stage. */
  stage?: string;
  status: JobStatus;
  /** Manual GitLab job / allow_failure. */
  when?: string;
  allowFailure?: boolean;
  needs: string[];
  startedAt?: number;
  completedAt?: number;
  steps: CiStep[];
  outputs: Record<string, string>;
  environment?: string;
  /** Matrix values for this copy of the job. */
  matrix?: Record<string, unknown>;
  /** Runner labels / tags it asked for. */
  labels?: string[];
}

export interface CiRun {
  id: number;
  /** Per-workflow counter (GitHub #N) or pipeline iid (GitLab). */
  number: number;
  attempt: number;
  /** Workflow name (GitHub) or "pipeline" (GitLab). */
  workflow: string;
  file: string;
  event: string;
  branch: string;
  /** Set for tag pushes. */
  tag?: string;
  sha: string;
  /** Commit subject (or the workflow name for dispatches). */
  title: string;
  actor: string;
  createdAt: number;
  jobs: CiJob[];
  /** Invalid workflow / pipeline configuration: the run fails without jobs. */
  error?: string;
  /** workflow_dispatch inputs. */
  inputs?: Record<string, string>;
  /** Artifacts uploaded by jobs: name → files. */
  artifacts: Record<string, Record<string, string>>;
}

export interface ForgeVariable {
  value: string;
  /** GitLab: only exposed to pipelines on protected branches. */
  protected?: boolean;
  masked?: boolean;
  /** GitLab "file" variable: the value is written to a file and the variable holds its path. */
  file?: boolean;
  updatedAt: number;
}

export interface ForgeRepo {
  url: string;
  kind: ForgeKind;
  /** "acme/shop" */
  slug: string;
  secrets: Record<string, ForgeVariable>;
  variables: Record<string, ForgeVariable>;
  /** Deployment environments and their own secrets. */
  environments: Record<string, { secrets: Record<string, ForgeVariable> }>;
  runs: CiRun[];
  /** actions/cache and GitLab cache entries: key → files. */
  caches: Record<string, Record<string, string>>;
  /** Tags of the GitLab runners available to this project (default: the shared SaaS runners). */
  runnerTags?: string[];
}

export interface ForgeState {
  repos: Record<string, ForgeRepo>;
  nextId: number;
}

export interface RegistryImage {
  digest: string;
  pushedAt: number;
}

export interface RegistryState {
  images: Record<string, RegistryImage>;
}

/** How a project's simulated toolchain behaves (`npm test`, `npm run lint`, `npm run build`). */
export interface ProjectSpec {
  tests?: TestSpec[];
  lint?: LintRule[];
  /** Files `npm run build` writes (relative to the project), default dist/index.html + dist/assets/app.js. */
  build?: Record<string, string>;
}

export interface TestSpec {
  /** Test file shown in the report, e.g. src/cart.test.js. */
  suite: string;
  /** "cart › applies a 10% discount" */
  name: string;
  /** Source file the test exercises. */
  file: string;
  /** The test passes while the file matches this regex… */
  regex?: string;
  /** …and doesn't match this one. */
  absent?: string;
  /** Jest's failure detail, e.g. "Expected: 90\nReceived: 110". */
  failure: string;
}

export interface LintRule {
  file: string;
  /** A match of this regex is a lint error. */
  pattern: string;
  /** "12:7  error  'total' is assigned a value but never used  no-unused-vars" */
  message: string;
}
