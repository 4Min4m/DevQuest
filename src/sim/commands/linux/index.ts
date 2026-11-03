import type { CommandDef } from '../../shell/types';
import { cat } from './cat';
import { cd, pwd } from './cd';
import { chmod } from './chmod';
import { chown } from './chown';
import { cp } from './cp';
import { curl } from './curl';
import { df, du } from './disk';
import { echo } from './echo';
import { env, exportCmd, printenv, unset } from './env';
import { find } from './find';
import { grep } from './grep';
import { head, tail } from './headtail';
import { kill } from './kill';
import { ls } from './ls';
import { clear, exit, falseCmd, help, history, nano, sleep, trueCmd, vi, vim } from './misc';
import { mkdir } from './mkdir';
import { mv } from './mv';
import { ps } from './ps';
import { rm } from './rm';
import { sed, tee } from './sed';
import { sort } from './sort';
import { touch } from './touch';
import { uniq } from './uniq';
import { id, whoami } from './user';
import { wc } from './wc';

export const linuxCommands: CommandDef[] = [
  ls, cd, pwd, cat, echo, touch, mkdir, rm, cp, mv, head, tail, grep, find, wc, sort, uniq,
  sed, tee, chmod, chown, ps, kill, whoami, id, env, printenv, exportCmd, unset, df, du, curl,
  help, history, clear, trueCmd, falseCmd, sleep, exit, nano, vi, vim,
];
