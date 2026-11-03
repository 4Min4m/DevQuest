import type { SimState, UserEntry } from '../state';
import type { Identity } from '../vfs/vfs';

export function findUser(state: SimState, name: string): UserEntry | undefined {
  return state.users.find((u) => u.name === name);
}

/** Groups of a user, primary group first. */
export function groupsOf(state: SimState, user: string): string[] {
  const entry = findUser(state, user);
  const primary = state.groups.find((g) => g.gid === entry?.gid)?.name ?? user;
  const extra = state.groups.filter((g) => g.members.includes(user) && g.name !== primary).map((g) => g.name);
  return [primary, ...extra];
}

export function identityOf(state: SimState): Identity {
  return { name: state.user, groups: groupsOf(state, state.user) };
}

export function homeOf(state: SimState): string {
  return state.vars.HOME ?? findUser(state, state.user)?.home ?? '/';
}
