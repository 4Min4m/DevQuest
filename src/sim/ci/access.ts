/** Cluster access from CI runners: only with a kubeconfig, like a real pipeline. */
import { clusterOf } from '../kube/cluster';
import type { CommandContext } from '../shell/types';
import { resolvePath } from '../vfs/path';

/**
 * On a runner, attach the cluster when KUBECONFIG (or ~/.kube/config) points at a non-empty file.
 * Returns an error message when the job has no way to reach the cluster.
 */
export function runnerClusterAccess(ctx: CommandContext, tool: 'kubectl' | 'helm'): string | null {
  const r = ctx.state.runner;
  if (!r) return null;
  const env = ctx.env.KUBECONFIG;
  const path = env ? resolvePath(ctx.state.cwd, env.split(':')[0]) : `${ctx.env.HOME ?? '/root'}/.kube/config`;
  let content = '';
  try {
    content = ctx.vfs.readFile(path);
  } catch {
    if (env) return `error: error loading config file "${path}": open ${path}: no such file or directory`;
  }
  if (!content.trim()) {
    return tool === 'kubectl'
      ? 'E1106 09:00:00.000000    2214 memcache.go:265] "Unhandled Error" err="couldn\'t get current server API group list: Get \\"http://localhost:8080/api?timeout=32s\\": dial tcp 127.0.0.1:8080: connect: connection refused"\nThe connection to the server localhost:8080 was refused - did you specify the right host or port?'
      : 'Error: Kubernetes cluster unreachable: Get "http://localhost:8080/version": dial tcp 127.0.0.1:8080: connect: connection refused';
  }
  ctx.state.kube = clusterOf(r.host);
  return null;
}
