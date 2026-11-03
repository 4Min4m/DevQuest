import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { merge3, unifiedHunks } from './diff';
import { blobSha, EMPTY_TREE, emptyStore, treeFromFlat, writeCommit, writeTree } from './objects';

/** A shell inside ~/repo with one commit (README.md). */
function repo() {
  const t = makeShell();
  t.setup('mkdir repo', 'cd repo', 'git init -q', 'echo hello > README.md', 'git add .', 'git commit -qm "Initial commit"');
  return t;
}

describe('objects (real Git ids)', () => {
  it('hashes blobs, trees and commits exactly like Git', () => {
    expect(blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    const s = emptyStore();
    expect(writeTree(s, [])).toBe(EMPTY_TREE);
    const tree = treeFromFlat(s, { 'hello.txt': { sha: blobSha('hello\n'), mode: '100644' } });
    expect(tree).toBe('aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7');
    const who = { name: 'A', email: 'a@x', time: 0 };
    expect(writeCommit(s, { tree, parents: [], author: who, committer: who, message: 'm' })).toBe('0dbbea55ccf65389e0b40d7a8dfb5f23e2d347f1');
  });

  it('git hash-object and cat-file expose them', () => {
    const t = repo();
    expect(t.run('git hash-object README.md').out).toBe('ce013625030ba8dba906f756967f9e9ca394464a\n');
    expect(t.run('git cat-file -t HEAD').out).toBe('commit\n');
    expect(t.run('git cat-file -p HEAD').out).toMatch(/^tree [0-9a-f]{40}\nauthor Student <student@devquest\.local> \d+ \+0000\ncommitter .*\n\nInitial commit\n$/);
    expect(t.run('git cat-file -p HEAD^{tree}').out).toBe('100644 blob ce013625030ba8dba906f756967f9e9ca394464a\tREADME.md\n');
    expect(t.run('git cat-file -p ce01362').out).toBe('hello\n');
    expect(t.run('git cat-file -e nope').code).toBe(1);
  });
});

describe('diff engine', () => {
  it('produces unified hunks with context and funcname', () => {
    expect(unifiedHunks('a\nb\nc\n', 'a\nB\nc\n')).toBe('@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
    expect(unifiedHunks('', 'x\n')).toBe('@@ -0,0 +1 @@\n+x\n');
    expect(unifiedHunks('x', 'x\n')).toBe('@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+x\n');
  });

  it('merges non-overlapping changes and marks conflicts', () => {
    expect(merge3('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n', 'HEAD', 'f')).toEqual({ text: 'A\nb\nc\nd\nE\n', conflicts: 0 });
    expect(merge3('x\n', 'y\n', 'z\n', 'HEAD', 'feature')).toEqual({ text: '<<<<<<< HEAD\ny\n=======\nz\n>>>>>>> feature\n', conflicts: 1 });
    expect(merge3('x\n', 'y\n', 'y\n', 'HEAD', 'f').conflicts).toBe(0);
  });
});

describe('init, config, status, add, commit', () => {
  it('outside a repository', () => {
    const t = makeShell();
    expect(t.run('git status')).toMatchObject({ err: 'fatal: not a git repository (or any of the parent directories): .git\n', code: 128 });
    expect(t.run('git --version').out).toBe('git version 2.43.0\n');
  });

  it('init creates .git and uses init.defaultBranch', () => {
    const t = makeShell();
    t.setup('mkdir p', 'cd p');
    expect(t.run('git init').out).toBe('Initialized empty Git repository in /home/student/p/.git/\n');
    expect(t.run('cat .git/HEAD').out).toBe('ref: refs/heads/main\n');
    expect(t.run('git init').out).toBe('Reinitialized existing Git repository in /home/student/p/.git/\n');
    expect(t.run('git status').out).toBe('On branch main\n\nNo commits yet\n\nnothing to commit (create/copy files and use "git add" to track)\n');
  });

  it("init without a configured default uses 'master' and prints the hint", () => {
    const t = makeShell();
    t.setup('rm ~/.gitconfig', 'mkdir p', 'cd p');
    const r = t.shell.run('git init');
    expect(r.output.find((c) => c.note)?.text).toMatch(/^hint: Using 'master' as the name for the initial branch/);
    expect(t.run('git status').out).toMatch(/^On branch master\n/);
  });

  it('refuses to commit without an identity, then config fixes it', () => {
    const t = makeShell();
    t.setup('rm ~/.gitconfig', 'mkdir p', 'cd p', 'git init -q -b main', 'touch a', 'git add a');
    const r = t.run('git commit -m first');
    expect(r.code).toBe(128);
    expect(r.err).toMatch(/^Author identity unknown\n\n\*\*\* Please tell me who you are\./);
    t.setup('git config --global user.name "Ada Lovelace"', 'git config --global user.email ada@example.com');
    expect(t.run('git config user.name').out).toBe('Ada Lovelace\n');
    expect(t.read('/home/student/.gitconfig')).toBe('[user]\n\tname = Ada Lovelace\n\temail = ada@example.com\n');
    expect(t.run('git commit -m first').out).toMatch(/^\[main \(root-commit\) [0-9a-f]{7}\] first\n 1 file changed, 0 insertions\(\+\)\n create mode 100644 a\n$/);
    expect(t.run('git config nosection')).toMatchObject({ code: 2 });
    expect(t.run('git config --list').out).toContain('user.email=ada@example.com\n');
  });

  it('long and short status', () => {
    const t = repo();
    t.setup('echo change >> README.md', 'echo new > b.txt', 'mkdir logs', 'echo x > logs/a.log', 'git add b.txt');
    expect(t.run('git status').out).toBe(
      'On branch main\n' +
        'Changes to be committed:\n  (use "git restore --staged <file>..." to unstage)\n\tnew file:   b.txt\n\n' +
        'Changes not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n  (use "git restore <file>..." to discard changes in working directory)\n\tmodified:   README.md\n\n' +
        'Untracked files:\n  (use "git add <file>..." to include in what will be committed)\n\tlogs/\n\n',
    );
    expect(t.run('git status -s').out).toBe(' M README.md\nA  b.txt\n?? logs/\n');
    t.setup('cd logs');
    expect(t.run('git status -s').out).toBe(' M ../README.md\nA  ../b.txt\n?? ./\n');
  });

  it('commit -a, nothing to commit, empty message', () => {
    const t = repo();
    expect(t.run('git commit -m again')).toMatchObject({ out: 'On branch main\nnothing to commit, working tree clean\n', code: 1 });
    t.setup('echo more >> README.md');
    expect(t.run('git commit -m ""')).toMatchObject({ err: 'Aborting commit due to empty commit message.\n', code: 1 });
    expect(t.run('git commit').err).toMatch(/the commit message editor is not simulated/);
    expect(t.run('git commit -am "More"').out).toMatch(/^\[main [0-9a-f]{7}\] More\n 1 file changed, 1 insertion\(\+\)\n$/);
  });

  it('add: pathspecs, deletions and .gitignore', () => {
    const t = repo();
    expect(t.run('git add nope')).toMatchObject({ err: "fatal: pathspec 'nope' did not match any files\n", code: 128 });
    t.setup("echo -e '*.log\\nsecrets/' > .gitignore", 'echo x > debug.log', 'mkdir secrets', 'echo k > secrets/key');
    expect(t.run('git status -s').out).toBe('?? .gitignore\n');
    expect(t.run('git add debug.log')).toMatchObject({ code: 1, err: expect.stringContaining('The following paths are ignored by one of your .gitignore files:\ndebug.log\n') });
    t.setup('git add -f debug.log', 'rm README.md', 'git add -A');
    expect(t.run('git status -s').out).toBe('A  .gitignore\nD  README.md\nA  debug.log\n');
    expect(t.run('git ls-files').out).toBe('.gitignore\ndebug.log\n');
  });

  it('rm, rm --cached and mv', () => {
    const t = repo();
    t.setup('echo x > a.txt', 'git add a.txt', 'git commit -qm a');
    expect(t.run('git rm --cached a.txt').out).toBe("rm 'a.txt'\n");
    expect(t.run('git status -s').out).toBe('D  a.txt\n?? a.txt\n');
    t.setup('git add a.txt', 'echo y >> a.txt');
    expect(t.run('git rm a.txt')).toMatchObject({ code: 1, err: expect.stringContaining('has local modifications') });
    t.setup('git checkout -- a.txt', 'git mv a.txt b.txt');
    expect(t.run('git status -s').out).toBe('R  a.txt -> b.txt\n');
    expect(t.run('ls').out).toBe('README.md  b.txt\n');
  });
});

describe('history: log, show, diff, reflog', () => {
  it('log formats', () => {
    const t = repo();
    t.setup('echo b > b', 'git add b', 'git commit -qm "Add b"');
    const log = t.run('git log').out;
    expect(log).toMatch(/^commit [0-9a-f]{40} \(HEAD -> main\)\nAuthor: Student <student@devquest\.local>\nDate:   Tue Nov 3 09:00:\d\d 2026 \+0000\n\n    Add b\n\ncommit [0-9a-f]{40}\n/);
    expect(t.run('git log --oneline').out).toMatch(/^[0-9a-f]{7} \(HEAD -> main\) Add b\n[0-9a-f]{7} Initial commit\n$/);
    expect(t.run('git log -1 --format=%s').out).toBe('Add b\n');
    expect(t.run('git log --oneline -- README.md').out).toMatch(/^[0-9a-f]{7} Initial commit\n$/);
    expect(t.run('git log nope')).toMatchObject({ code: 128, err: expect.stringContaining("ambiguous argument 'nope'") });
  });

  it('log --graph shows merges like git', () => {
    const t = repo();
    t.setup('git switch -qc feature', 'echo f > f', 'git add f', 'git commit -qm feat', 'git switch -q main', 'echo m > m', 'git add m', 'git commit -qm main-work', 'git merge -q feature');
    const lines = t.run('git log --oneline --graph').out.split('\n');
    expect(lines[0]).toMatch(/^\* {3}[0-9a-f]{7} \(HEAD -> main\) Merge branch 'feature'$/);
    expect(lines[1]).toBe('|\\');
    expect(lines[2]).toMatch(/^\| \* [0-9a-f]{7} \(feature\) feat$/);
    expect(lines[3]).toMatch(/^\* \| [0-9a-f]{7} main-work$/);
    expect(lines[4]).toBe('|/');
    expect(lines[5]).toMatch(/^\* [0-9a-f]{7} Initial commit$/);
  });

  it('diff, diff --staged, diff between commits, show', () => {
    const t = repo();
    t.setup('echo world >> README.md');
    expect(t.run('git diff').out).toBe('diff --git a/README.md b/README.md\nindex ce01362..94954ab 100644\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n hello\n+world\n');
    expect(t.run('git diff --staged').out).toBe('');
    t.setup('git add README.md');
    expect(t.run('git diff --staged --stat').out).toBe(' README.md | 1 +\n 1 file changed, 1 insertion(+)\n');
    t.setup('git commit -qm world');
    expect(t.run('git diff HEAD~1 HEAD --name-only').out).toBe('README.md\n');
    expect(t.run('git show HEAD~1:README.md').out).toBe('hello\n');
    expect(t.run('git show --stat').out).toMatch(/\n    world\n\n README.md \| 1 \+\n/);
  });

  it('reflog records every move of HEAD', () => {
    const t = repo();
    t.setup('git switch -qc x', 'git switch -q main');
    expect(t.run('git reflog').out).toMatch(
      /^[0-9a-f]{7} \(HEAD -> main, x\) HEAD@\{0\}: checkout: moving from x to main\n[0-9a-f]{7} \(HEAD -> main, x\) HEAD@\{1\}: checkout: moving from main to x\n[0-9a-f]{7} \(HEAD -> main, x\) HEAD@\{2\}: commit \(initial\): Initial commit\n$/,
    );
  });
});

describe('undo: restore, reset, revert, amend', () => {
  it('restore and restore --staged', () => {
    const t = repo();
    t.setup('echo bad > README.md', 'git add README.md');
    t.setup('git restore --staged README.md');
    expect(t.run('git status -s').out).toBe(' M README.md\n');
    t.setup('git restore README.md');
    expect(t.read('/home/student/repo/README.md')).toBe('hello\n');
    expect(t.run('git restore nope')).toMatchObject({ code: 1, err: "error: pathspec 'nope' did not match any file(s) known to git\n" });
  });

  it('reset --soft / --mixed / --hard', () => {
    const t = repo();
    t.setup('echo 2 > two', 'git add two', 'git commit -qm two');
    t.setup('git reset --soft HEAD~1');
    expect(t.run('git status -s').out).toBe('A  two\n');
    t.setup('git commit -qm two');
    expect(t.run('git reset HEAD~1').out).toBe('');
    expect(t.run('git status -s').out).toBe('?? two\n');
    t.setup('git add two', 'git commit -qm two');
    expect(t.run('git reset --hard HEAD~1').out).toMatch(/^HEAD is now at [0-9a-f]{7} Initial commit\n$/);
    expect(t.run('ls').out).toBe('README.md\n');
    // reflog saves the day
    t.setup('git reset -q --hard HEAD@{1}');
    expect(t.run('cat two').out).toBe('2\n');
  });

  it('revert and amend', () => {
    const t = repo();
    t.setup('echo bad >> README.md', 'git commit -qam "Bad change"');
    expect(t.run('git revert HEAD').out).toMatch(/^\[main [0-9a-f]{7}\] Revert "Bad change"\n 1 file changed, 1 deletion\(-\)\n$/);
    expect(t.read('/home/student/repo/README.md')).toBe('hello\n');
    expect(t.run('git log -1 --format=%b').out).toMatch(/This reverts commit [0-9a-f]{40}\./);
    t.setup('git commit -q --amend -m "Revert the bad change"');
    expect(t.run('git log --oneline').out.split('\n')).toHaveLength(4);
    expect(t.run('git commit --amend').err).toMatch(/not simulated/);
  });
});

describe('branches', () => {
  it('create, list, switch, delete', () => {
    const t = repo();
    t.setup('git branch feature');
    expect(t.run('git branch').out).toBe('  feature\n* main\n');
    expect(t.run('git branch feature')).toMatchObject({ err: "fatal: a branch named 'feature' already exists\n", code: 128 });
    expect(t.run('git branch "bad name"')).toMatchObject({ code: 128, err: "fatal: 'bad name' is not a valid branch name\n" });
    const sw = t.shell.run('git switch feature');
    expect(sw.output.find((c) => c.note)?.text).toBe("Switched to branch 'feature'\n");
    expect(t.run('git switch nope')).toMatchObject({ err: 'fatal: invalid reference: nope\n', code: 128 });
    expect(t.run('git branch -d feature')).toMatchObject({ code: 1, err: "error: cannot delete branch 'feature' used by worktree at '/home/student/repo'\n" });
    t.setup('echo f > f', 'git add f', 'git commit -qm f', 'git switch -q main');
    expect(t.run('git branch -d feature')).toMatchObject({ code: 1, err: expect.stringContaining("error: the branch 'feature' is not fully merged") });
    expect(t.run('git branch -D feature').out).toMatch(/^Deleted branch feature \(was [0-9a-f]{7}\)\.\n$/);
  });

  it('refuses to switch over local changes', () => {
    const t = repo();
    t.setup('git switch -qc other', 'echo other > README.md', 'git commit -qam other', 'git switch -q main', 'echo local > README.md');
    expect(t.run('git switch other')).toMatchObject({
      code: 1,
      err: 'error: Your local changes to the following files would be overwritten by checkout:\n\tREADME.md\nPlease commit your changes or stash them before you switch branches.\nAborting\n',
    });
  });

  it('detached HEAD and leaving commits behind', () => {
    const t = repo();
    t.setup('echo 2 >> README.md', 'git commit -qam two');
    const r = t.shell.run('git checkout HEAD~1');
    expect(r.output.map((c) => c.text).join('')).toMatch(/^Note: switching to 'HEAD~1'\.\n\nYou are in 'detached HEAD' state\./);
    expect(t.run('git status').out).toMatch(/^HEAD detached at [0-9a-f]{7}\n/);
    t.setup('echo lost > lost.txt', 'git add lost.txt', 'git commit -qm "experiment"');
    const back = t.shell.run('git switch main');
    expect(back.output.map((c) => c.text).join('')).toMatch(/^Warning: you are leaving 1 commit behind, not connected to\nany of your branches:\n\n {2}[0-9a-f]{7} experiment\n/);
  });
});

describe('merge', () => {
  function diverged() {
    const t = repo();
    t.setup("echo -e 'a\\nb\\nc' > f", 'git add f', 'git commit -qm base', 'git switch -qc feature', "echo -e 'a\\nB\\nc' > f", 'git commit -qam feature-change', 'git switch -q main');
    return t;
  }

  it('fast-forwards when possible', () => {
    const t = diverged();
    const r = t.run('git merge feature');
    expect(r.out).toMatch(/^Updating [0-9a-f]{7}\.\.[0-9a-f]{7}\nFast-forward\n f \| 2 \+-\n 1 file changed, 1 insertion\(\+\), 1 deletion\(-\)\n$/);
    expect(t.run('git merge feature').out).toBe('Already up to date.\n');
  });

  it('three-way merges and conflicts', () => {
    const t = diverged();
    t.setup("echo -e 'A\\nb\\nc' > f", 'git commit -qam main-change');
    expect(t.run('git merge feature')).toMatchObject({ code: 1, out: 'Auto-merging f\nCONFLICT (content): Merge conflict in f\nAutomatic merge failed; fix conflicts and then commit the result.\n' });
    expect(t.read('/home/student/repo/f')).toBe('<<<<<<< HEAD\nA\nb\n=======\na\nB\n>>>>>>> feature\nc\n');
    expect(t.run('git status -s').out).toBe('UU f\n');
    expect(t.run('git commit -m x').code).toBe(128);
    expect(t.run('git switch feature').code).toBe(1);
    t.setup("echo -e 'A\\nB\\nc' > f", 'git add f', 'git commit --no-edit');
    expect(t.run('git log -1 --format=%s%n%p').out).toMatch(/^Merge branch 'feature'\n[0-9a-f]{7} [0-9a-f]{7}\n$/);
  });

  it('merges cleanly when changes do not overlap', () => {
    const t = repo();
    t.setup("echo -e '1\\n2\\n3\\n4\\n5\\n6' > f", 'git add f', 'git commit -qm base', 'git switch -qc feature', "echo -e '1\\n2\\n3\\n4\\n5\\nsix' > f", 'git commit -qam f', 'git switch -q main', "echo -e 'one\\n2\\n3\\n4\\n5\\n6' > f", 'git commit -qam m');
    expect(t.run('git merge feature').out).toBe("Auto-merging f\nMerge made by the 'ort' strategy.\n f | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
    expect(t.read('/home/student/repo/f')).toBe('one\n2\n3\n4\n5\nsix\n');
  });

  it('--abort, --squash and --ff-only', () => {
    const t = diverged();
    t.setup("echo -e 'A\\nb\\nc' > f", 'git commit -qam main-change', 'git merge feature || true');
    t.setup('git merge --abort');
    expect(t.read('/home/student/repo/f')).toBe('A\nb\nc\n');
    expect(t.run('git status -s').out).toBe('');
    expect(t.run('git merge --ff-only feature')).toMatchObject({ code: 128, err: expect.stringContaining('fatal: Not possible to fast-forward, aborting.') });
    expect(t.run('git merge nope')).toMatchObject({ code: 1, err: 'merge: nope - not something we can merge\n' });
  });
});

describe('rebase, cherry-pick, stash', () => {
  it('rebase replays commits and handles conflicts', () => {
    const t = repo();
    t.setup('git switch -qc feature', 'echo f > f', 'git add f', 'git commit -qm f', 'git switch -q main', 'echo m > m', 'git add m', 'git commit -qm m', 'git switch -q feature');
    const r = t.shell.run('git rebase main');
    expect(r.exitCode).toBe(0);
    expect(r.output.map((c) => c.text).join('')).toBe('Successfully rebased and updated refs/heads/feature.\n');
    expect(t.run('git log --format=%s').out).toBe('f\nm\nInitial commit\n');
    expect(t.run('git rebase main').out).toBe('Current branch feature is up to date.\n');
    // conflict
    t.setup('echo theirs > README.md', 'git commit -qam readme-feature', 'git switch -q main', 'echo ours > README.md', 'git commit -qam readme-main', 'git switch -q feature');
    const c = t.run('git rebase main');
    expect(c.code).toBe(1);
    expect(c.err).toMatch(/^error: could not apply [0-9a-f]{7} readme-feature\n/);
    expect(t.run('git status').out).toMatch(/^rebase in progress; onto [0-9a-f]{7}\nYou are currently rebasing branch 'feature' on '[0-9a-f]{7}'\./);
    expect(t.run('git rebase --continue')).toMatchObject({ code: 1, err: expect.stringContaining('README.md: needs merge') });
    t.setup('echo both > README.md', 'git add README.md', 'git rebase --continue');
    expect(t.run('git log --format=%s').out).toBe('readme-feature\nf\nreadme-main\nm\nInitial commit\n');
    expect(t.run('git branch --show-current').out).toBe('feature\n');
  });

  it('rebase --abort restores the branch', () => {
    const t = repo();
    t.setup('git switch -qc feature', 'echo x > README.md', 'git commit -qam x', 'git switch -q main', 'echo y > README.md', 'git commit -qam y', 'git switch -q feature');
    expect(t.run('git rebase main').code).toBe(1);
    t.setup('git rebase --abort');
    expect(t.run('git log --format=%s -1').out).toBe('x\n');
    expect(t.read('/home/student/repo/README.md')).toBe('x\n');
    expect(t.run('git rebase -i HEAD~1').err).toMatch(/interactive rebase \(git rebase -i\) is not simulated/);
  });

  it('cherry-pick copies one commit', () => {
    const t = repo();
    t.setup('git branch release', 'echo feat > feat', 'git add feat', 'git commit -qm feat', 'echo fix >> README.md', 'git commit -qam fix', 'git switch -q release');
    expect(t.run('git cherry-pick main').out).toMatch(/^\[release [0-9a-f]{7}\] fix\n Date: .*\n 1 file changed, 1 insertion\(\+\)\n$/);
    expect(t.run('ls').out).toBe('README.md\n');
  });

  it('stash push / list / pop', () => {
    const t = repo();
    expect(t.run('git stash').out).toBe('No local changes to save\n');
    t.setup('echo wip >> README.md');
    expect(t.run('git stash').out).toMatch(/^Saved working directory and index state WIP on main: [0-9a-f]{7} Initial commit\n$/);
    expect(t.read('/home/student/repo/README.md')).toBe('hello\n');
    expect(t.run('git stash list').out).toMatch(/^stash@\{0\}: WIP on main: /);
    const pop = t.run('git stash pop');
    expect(pop.out).toContain('modified:   README.md');
    expect(pop.out).toMatch(/Dropped refs\/stash@\{0\} \([0-9a-f]{40}\)\n$/);
    expect(t.read('/home/student/repo/README.md')).toBe('hello\nwip\n');
    expect(t.run('git stash pop')).toMatchObject({ code: 1, err: 'No stash entries found.\n' });
  });
});

describe('remotes', () => {
  function hosted() {
    const t = makeShell();
    t.setup('git init -q --bare ~/origin.git', 'git clone -q ~/origin.git work', 'cd work', 'echo v1 > app', 'git add app', 'git commit -qm v1', 'git push -q -u origin main');
    return t;
  }

  it('clone, push -u and tracking info', () => {
    const t = hosted();
    expect(t.run('git status').out).toBe("On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n");
    expect(t.run('git remote -v').out).toBe('origin\t/home/student/origin.git (fetch)\norigin\t/home/student/origin.git (push)\n');
    t.setup('cd ~', 'git clone -q origin.git copy');
    expect(t.run('cat copy/app').out).toBe('v1\n');
    expect(t.run('git clone origin.git copy')).toMatchObject({ code: 128, err: "fatal: destination path 'copy' already exists and is not an empty directory.\n" });
  });

  it('rejects non-fast-forward pushes; pull --rebase fixes it', () => {
    const t = hosted();
    t.setup('cd ~', 'git clone -q origin.git alice', 'cd alice', 'echo a > alice.txt', 'git add .', 'git commit -qm alice', 'git push -q', 'cd ~/work', 'echo me > me.txt', 'git add .', 'git commit -qm mine');
    const r = t.run('git push');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^To \/home\/student\/origin\.git\n ! \[rejected\] {8}main -> main \(fetch first\)\nerror: failed to push some refs/);
    expect(t.run('git pull')).toMatchObject({ code: 128, err: expect.stringContaining('fatal: Need to specify how to reconcile divergent branches.') });
    t.setup('git pull --rebase', 'git push');
    expect(t.run('git log --format=%s origin/main').out).toBe('mine\nalice\nv1\n');
    expect(t.run('git status -sb').out).toBe('## main...origin/main\n');
  });

  it('fetch updates origin/* without moving your branch', () => {
    const t = hosted();
    t.setup('cd ~', 'git clone -q origin.git bob', 'cd bob', 'echo b >> app', 'git commit -qam bob', 'git push -q', 'git switch -qc topic', 'git push -q -u origin topic', 'cd ~/work');
    const r = t.shell.run('git fetch');
    expect(r.output.map((c) => c.text).join('')).toMatch(/From \/home\/student\/origin\.git\n {3}[0-9a-f]{7}\.\.[0-9a-f]{7} {2}main {7}-> origin\/main\n \* \[new branch\] {6}topic {6}-> origin\/topic\n$/);
    expect(t.run('git status').out).toContain("Your branch is behind 'origin/main' by 1 commit, and can be fast-forwarded.");
    t.setup('git switch -q topic');
    expect(t.run('git branch -vv').out).toContain('[origin/topic]');
  });

  it('force-with-lease protects teammates; tags are pushed explicitly', () => {
    const t = hosted();
    t.setup('cd ~', 'git clone -q origin.git carol', 'cd carol', 'echo c >> app', 'git commit -qam carol', 'git push -q', 'cd ~/work', 'git commit -q --amend -m rewritten');
    expect(t.run('git push --force-with-lease').err).toContain('(stale info)');
    t.setup('git tag -a v1.0 -m "First release"');
    expect(t.run('git tag').out).toBe('v1.0\n');
    t.setup('git push -q origin v1.0');
    expect(t.state.git!.remotes['/home/student/origin.git'].tags['v1.0']).toBeDefined();
  });

  it('protected branches refuse direct pushes', () => {
    const t = hosted();
    t.state.git!.remotes['/home/student/origin.git'].protectedBranches = ['main'];
    t.setup('echo x >> app', 'git commit -qam x');
    const r = t.run('git push');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^remote: error: GH006: Protected branch update failed for refs\/heads\/main\./);
  });

  it('unknown remotes and missing upstreams', () => {
    const t = hosted();
    expect(t.run('git clone https://github.com/acme/nope.git').err).toContain("fatal: repository 'https://github.com/acme/nope.git/' not found");
    t.setup('git switch -qc topic');
    expect(t.run('git push').err).toMatch(/^fatal: The current branch topic has no upstream branch\./);
    expect(t.run('git fetch nowhere').err).toMatch(/^fatal: 'nowhere' does not appear to be a git repository/);
  });
});

describe('the git command', () => {
  it('suggests similar commands and explains unsupported ones', () => {
    const t = repo();
    expect(t.run('git stauts')).toMatchObject({ code: 1, err: "git: 'stauts' is not a git command. See 'git --help'.\n\nThe most similar command is\n\tstatus\n" });
    expect(t.run('git bisect start').err).toMatch(/'git bisect' is a real git command, but it is not simulated yet/);
  });

  it('-C and -c global options', () => {
    const t = repo();
    t.setup('cd ~');
    expect(t.run('git -C repo log --format=%s').out).toBe('Initial commit\n');
    t.setup('cd repo', 'echo x >> README.md');
    t.setup('git -c user.name=Bot -c user.email=bot@x commit -qam bot');
    expect(t.run('git log -1 --format=%an').out).toBe('Bot\n');
  });

  it('mirrors refs into .git and forgets a deleted .git', () => {
    const t = repo();
    t.setup('git branch feature');
    expect(t.run('cat .git/refs/heads/feature').out).toBe(t.run('git rev-parse HEAD').out);
    t.setup('rm -rf .git');
    expect(t.run('git status').code).toBe(128);
  });

  it('is not installed inside containers', () => {
    const t = makeShell();
    t.setup('docker run -d --name web nginx');
    t.shell.run('docker exec -it web bash');
    expect(t.run('git status').code).toBe(127);
  });
});
