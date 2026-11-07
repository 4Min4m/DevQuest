/** Extension points for programs with their own behaviour (Prometheus, Alertmanager, Loki...). */
import type { HttpResult, Request } from '../net';
import type { SimState } from '../state';

/** `systemctl reload` / SIGHUP: (state, unit, main pid) → log lines (errors as priority 3). */
export const reloadHooks: ((state: SimState, unit: string, exe: string) => { msg: string; prio: number }[] | undefined)[] = [];

/** HTTP handlers for BinarySpec.app programs. */
export const appHandlers: Record<string, (state: SimState, req: Request & { body?: string }) => HttpResult> = {};

/** A unit started successfully: (state, unit). */
export const startHooks: ((state: SimState, unit: string) => void)[] = [];
