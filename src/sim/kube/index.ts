import type { CommandContext, CommandDef } from '../shell/types';
import { settle } from './controllers';
import { KubectlError, kctx } from './cli/common';
import { impersonate, kubectlAuth, kubectlAutoscale, kubectlCordon, kubectlDrain, kubectlTaint, takeImpersonation } from './cli/admin';
import { ADMIN } from './rbac';
import { kubectlDescribe, kubectlGet } from './cli/get';
import { kubectlApiResources, kubectlClusterInfo, kubectlConfig, kubectlExec, kubectlLogs, kubectlPortForward, kubectlTop, kubectlVersion } from './cli/pods';
import { kubectlApply, kubectlCreate, kubectlDelete, kubectlEdit, kubectlExpose, kubectlLabel, kubectlRollout, kubectlRun, kubectlScale, kubectlSet } from './cli/workloads';
import './net';

export type * from './types';
export { reconcile, advance } from './controllers';
export { clusterOf } from './cluster';
export { setPodShellFactory } from './podshell';

const HELP = `kubectl controls the Kubernetes cluster manager.

Basic Commands (Beginner):
  create          Create a resource from a file or from stdin
  expose          Take a replication controller, service, deployment or pod and expose it as a new Kubernetes service
  run             Run a particular image on the cluster
  set             Set specific features on objects

Basic Commands (Intermediate):
  get             Display one or many resources
  edit            Edit a resource on the server
  delete          Delete resources by file names, stdin, resources and names, or by resources and label selector

Deploy Commands:
  rollout         Manage the rollout of a resource
  scale           Set a new size for a deployment, replica set, or replication controller
  autoscale       Auto-scale a deployment, replica set, stateful set, or replication controller

Cluster Management Commands:
  cluster-info    Display cluster information
  top             Display resource (CPU/memory) usage
  cordon          Mark node as unschedulable
  uncordon        Mark node as schedulable
  drain           Drain node in preparation for maintenance
  taint           Update the taints on one or more nodes

Troubleshooting and Debugging Commands:
  describe        Show details of a specific resource or group of resources
  logs            Print the logs for a container in a pod
  exec            Execute a command in a container
  port-forward    Forward one or more local ports to a pod

Advanced Commands:
  apply           Apply a configuration to a resource by file name or stdin

Settings Commands:
  label           Update the labels on a resource
  annotate        Update the annotations on a resource

Other Commands:
  auth            Inspect authorization
  api-resources   Print the supported API resources on the server
  config          Modify kubeconfig files
  version         Print the client and server version information

Usage:
  kubectl [flags] [options]
`;

const LATER = new Set(['certificate', 'patch', 'replace', 'wait', 'debug', 'attach', 'cp', 'proxy', 'kustomize', 'diff', 'plugin', 'events', 'explain']);

export const kubectl: CommandDef = {
  name: 'kubectl',
  summary: 'control the (simulated) Kubernetes cluster',
  run(ctx) {
    const [sub, ...args] = ctx.args;
    if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
      ctx.out(HELP);
      return 0;
    }
    if (sub === 'version' && args.includes('--client')) {
      ctx.out('Client Version: v1.31.2\nKustomize Version: v5.4.2\n');
      return 0;
    }
    try {
      return dispatch(ctx, sub, args);
    } catch (e) {
      if (e instanceof KubectlError) {
        ctx.err(e.message.endsWith('\n') ? e.message : e.message + '\n');
        return e.code;
      }
      throw e;
    } finally {
      if (ctx.state.kube || ctx.state.context?.host?.kube) settle(ctx.state);
    }
  },
};

function dispatch(ctx: CommandContext, sub: string, rawArgs: string[]): number {
      const imp = takeImpersonation(rawArgs);
      const args = imp.args;
      const k = kctx(ctx, imp.as === null ? ADMIN : impersonate(imp.as, imp.groups));
      switch (sub) {
        case 'get':
          return kubectlGet(k, args);
        case 'describe':
          return kubectlDescribe(k, args);
        case 'apply':
          return kubectlApply(k, args);
        case 'create':
          return kubectlCreate(k, args);
        case 'delete':
          return kubectlDelete(k, args);
        case 'edit':
          return kubectlEdit(k, args);
        case 'run':
          return kubectlRun(k, args);
        case 'expose':
          return kubectlExpose(k, args);
        case 'scale':
          return kubectlScale(k, args);
        case 'set':
          return kubectlSet(k, args);
        case 'rollout':
          return kubectlRollout(k, args);
        case 'label':
          return kubectlLabel(k, args);
        case 'annotate':
          return kubectlLabel(k, args, true);
        case 'logs':
          return kubectlLogs(k, args);
        case 'exec':
          return kubectlExec(k, args);
        case 'port-forward':
          return kubectlPortForward(k, args);
        case 'top':
          return kubectlTop(k, args);
        case 'config':
          return kubectlConfig(k, args);
        case 'version':
          return kubectlVersion(k, args);
        case 'cluster-info':
          return kubectlClusterInfo(k);
        case 'api-resources':
          return kubectlApiResources(k);
        case 'cordon':
        case 'uncordon':
          return kubectlCordon(k, args, sub === 'cordon');
        case 'drain':
          return kubectlDrain(k, args);
        case 'taint':
          return kubectlTaint(k, args);
        case 'autoscale':
          return kubectlAutoscale(k, args);
        case 'auth':
          return kubectlAuth(k, args);
      }
      if (LATER.has(sub)) {
        ctx.err(`devquest: 'kubectl ${sub}' is real, but not simulated yet (it arrives in the next Kubernetes step)\n`);
        return 1;
      }
      ctx.err(`error: unknown command "${sub}" for "kubectl"\n\nDid you mean this?\n\t${['get', 'describe', 'apply', 'logs', 'exec', 'delete'].find((c) => c[0] === sub[0]) ?? 'get'}\n`);
      return 1;
}

export const kubeCommands = [kubectl];
