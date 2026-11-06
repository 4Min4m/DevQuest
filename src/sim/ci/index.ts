/** CI/CD on the simulated hosting platforms: push hooks start pipelines; gh / glab / npm commands. */
import { onPush } from '../git/hooks';
import { isHosted, kindOf } from '../forge';
import { githubOnPush } from './github';
import { gitlabOnPush } from './gitlab';
import { gh } from './gh';
import { glab } from './glab';
import { node, npm } from './npm';

export { setRunnerShellFactory } from './runner';

onPush((state, url, remote, updates) => {
  if (!isHosted(url)) return;
  for (const u of updates) {
    try {
      if (kindOf(url) === 'gitlab') gitlabOnPush(state, url, remote, u);
      else githubOnPush(state, url, remote, u);
    } catch (e) {
      // CI must never break the push itself; the failure shows up as a broken run instead.
      console.error('devquest CI engine error', e);
    }
  }
});

export const ciCommands = [gh, glab, npm, node];
