import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { createMachine } from '../machines';
import { evalExpr, renderTemplate } from './jinja';
import { matchPattern, parseIni, parseYamlInventory } from './inventory';

function lab() {
  const t = makeShell();
  t.state.machines = {
    web1: createMachine({ hostname: 'web1', ip: '10.0.2.11' }, t.state.clock),
    web2: createMachine({ hostname: 'web2', ip: '10.0.2.12' }, t.state.clock),
    db1: createMachine({ hostname: 'db1', ip: '10.0.2.21' }, t.state.clock),
  };
  t.setup('mkdir -p ~/infra');
  t.state.cwd = '/home/student/infra';
  const files: Record<string, string> = {
    'inventory.ini': '[web]\nweb1 ansible_host=10.0.2.11\nweb2 ansible_host=10.0.2.12\n\n[db]\ndb1 ansible_host=10.0.2.21\n\n[all:vars]\nansible_user=ubuntu\n',
    'ansible.cfg': '[defaults]\ninventory = inventory.ini\nhost_key_checking = False\n',
    'site.yml': `- name: Web servers
  hosts: web
  become: true
  vars:
    site_title: DevQuest
  tasks:
    - name: Install nginx
      ansible.builtin.apt:
        name: nginx
        state: present
        update_cache: true

    - name: Deploy index page
      ansible.builtin.template:
        src: index.html.j2
        dest: /var/www/html/index.html
        mode: "0644"
      notify: Reload nginx

    - name: Nginx is running
      ansible.builtin.service:
        name: nginx
        state: started
        enabled: true

  handlers:
    - name: Reload nginx
      ansible.builtin.service:
        name: nginx
        state: reloaded
`,
    'templates/index.html.j2': '<h1>{{ site_title }}</h1>\n<p>Served by {{ inventory_hostname }} ({{ ansible_default_ipv4.address }})</p>\n{% for g in group_names %}\n<li>{{ g }}</li>\n{% endfor %}\n',
  };
  const v = t.vfs();
  for (const [p, c] of Object.entries(files)) {
    const full = `/home/student/infra/${p}`;
    v.mkdir(full.replace(/\/[^/]*$/, ''), { parents: true });
    v.writeFile(full, c);
  }
  return t;
}

describe('jinja', () => {
  it('expressions, filters and tests', () => {
    expect(evalExpr("x | default('a')", {})).toBe('a');
    expect(evalExpr('items | join(",")', { items: ['a', 'b'] })).toBe('a,b');
    expect(evalExpr("'web' in group_names", { group_names: ['web'] })).toBe(true);
    expect(evalExpr('x is defined and x > 2', { x: 3 })).toBe(true);
    expect(evalExpr('port | int + 1', { port: '80' })).toBe(81);
    expect(evalExpr('a.b', { a: { b: 'c' } })).toBe('c');
  });
  it('templates with if / for and lazy vars', () => {
    expect(renderTemplate('{% for p in ports %}\nlisten {{ p }};\n{% endfor %}\n', { ports: [80, 443] })).toBe('listen 80;\nlisten 443;\n');
    expect(renderTemplate('{{ dir }}', { base: '/srv', dir: '{{ base }}/app' })).toBe('/srv/app');
    expect(() => renderTemplate('{{ nope }}', {})).toThrow("'nope' is undefined");
  });
});

describe('inventory', () => {
  it('INI groups, children and patterns', () => {
    const inv = parseIni('[web]\nweb[1:2]\n[db]\ndb1\n[prod:children]\nweb\ndb\n[web:vars]\nhttp_port=80\n');
    expect(matchPattern(inv, 'prod').hosts).toEqual(['web1', 'web2', 'db1']);
    expect(matchPattern(inv, 'all:!db').hosts).toEqual(['web1', 'web2']);
    expect(matchPattern(inv, 'web:&prod').hosts).toEqual(['web1', 'web2']);
    expect(matchPattern(inv, 'nope').unmatched).toEqual(['nope']);
  });
  it('YAML inventories', () => {
    const inv = parseYamlInventory('all:\n  children:\n    web:\n      hosts:\n        web1:\n          ansible_host: 10.0.2.11\n');
    expect(matchPattern(inv, 'web').hosts).toEqual(['web1']);
    expect(inv.hosts.get('web1')).toEqual({ ansible_host: '10.0.2.11' });
  });
});

describe('ansible ad-hoc', () => {
  it('ping and command', () => {
    const t = lab();
    const r = t.run('ansible all -m ping');
    expect(r.code).toBe(0);
    expect(r.out).toContain('web1 | SUCCESS => {');
    expect(r.out).toContain('"ping": "pong"');
    expect(t.run('ansible web -a hostname').out).toBe('web1 | CHANGED | rc=0 >>\nweb1\nweb2 | CHANGED | rc=0 >>\nweb2\n');
  });
  it('unreachable and become', () => {
    const t = lab();
    t.state.machines!.db1.machine!.up = false;
    const r = t.run('ansible db -m ping');
    expect(r.code).toBe(4);
    expect(r.out).toContain('db1 | UNREACHABLE! => {');
    expect(r.out).toContain('port 22: Connection timed out');
    expect(t.run('ansible web1 -m apt -a "name=htop"').out).toContain('Failed to lock apt');
    expect(t.run('ansible web1 -b -m apt -a "name=htop update_cache=yes"').out).toContain('web1 | CHANGED');
    expect(t.run('ansible nope -m ping').err).toContain('Could not match supplied host pattern, ignoring: nope');
  });
});

describe('ansible-playbook', () => {
  it('runs a play with handlers and recap, and is idempotent', () => {
    const t = lab();
    const r = t.run('ansible-playbook site.yml');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('PLAY [Web servers] *****');
    expect(r.out).toContain('TASK [Gathering Facts] ****');
    expect(r.out).toContain('changed: [web1]');
    expect(r.out).toContain('RUNNING HANDLER [Reload nginx] ****');
    expect(r.out).toMatch(/web1 {23}: ok=5 {4}changed=3 {4}unreachable=0 {4}failed=0 {4}skipped=0 {4}rescued=0 {4}ignored=0/);
    expect(t.run('curl -s http://10.0.2.12').out).toContain('<p>Served by web2 (10.0.2.12)</p>\n<li>web</li>\n');
    const again = t.run('ansible-playbook site.yml');
    expect(again.out).toMatch(/web1 +: ok=4 +changed=0 /);
    expect(again.out).not.toContain('RUNNING HANDLER');
    expect(t.state.ansible!.runs.length).toBe(2);
  });
  it('check mode changes nothing; diff shows the change', () => {
    const t = lab();
    t.setup('ansible-playbook site.yml');
    t.setup("sed -i 's/site_title: DevQuest/site_title: Quest/' site.yml");
    const r = t.run('ansible-playbook site.yml --check --diff --limit web1');
    expect(r.out).toContain('--- before: /var/www/html/index.html');
    expect(r.out).toContain('-<h1>DevQuest</h1>');
    expect(r.out).toContain('+<h1>Quest</h1>');
    expect(r.out).not.toContain('[web2]');
    expect(t.run('curl -s http://10.0.2.11').out).toContain('DevQuest');
  });
  it('syntax and module errors', () => {
    const t = lab();
    t.vfs().writeFile('/home/student/infra/bad.yml', '- hosts: web\n  tasks:\n    - name: x\n      aptt:\n        name: nginx\n');
    const r = t.run('ansible-playbook bad.yml');
    expect(r.code).toBe(4);
    expect(r.err).toContain("ERROR! couldn't resolve module/action 'aptt'");
    expect(r.err).toContain("line 3, column 7");
    expect(t.run('ansible-playbook missing.yml').err).toContain('ERROR! the playbook: missing.yml could not be found');
  });
  it('failures stop the host; when, loop, register, ignore_errors', () => {
    const t = lab();
    t.vfs().writeFile('/home/student/infra/p.yml', `- hosts: web1
  become: true
  tasks:
    - command: test -f /nope
      register: r
      ignore_errors: true
    - debug:
        msg: "rc was {{ r.rc }}"
    - name: users
      user:
        name: "{{ item }}"
      loop: [alice, bob]
    - name: only on db
      debug: msg=hi
      when: "'db' in group_names"
    - service:
        name: nope
        state: started
    - debug: msg=never
`);
    const r = t.run('ansible-playbook p.yml');
    expect(r.code).toBe(2);
    expect(r.out).toContain('...ignoring');
    expect(r.out).toContain('"msg": "rc was 1"');
    expect(r.out).toContain('changed: [web1] => (item=alice)');
    expect(r.out).toContain('skipping: [web1]');
    expect(r.out).toContain('fatal: [web1]: FAILED! => {"changed": false, "msg": "Could not find the requested service nope: host"}');
    expect(r.out).not.toContain('never');
    expect(r.out).toMatch(/web1 +: ok=\d+ +changed=2 +unreachable=0 +failed=1 +skipped=1 +rescued=0 +ignored=1/);
    expect(t.run('ssh ubuntu@10.0.2.11 id alice').code).toBe(0);
  });
  it('roles with defaults, handlers and files', () => {
    const t = lab();
    const v = t.vfs();
    const w = (p: string, c: string) => {
      v.mkdir(('/home/student/infra/' + p).replace(/\/[^/]*$/, ''), { parents: true });
      v.writeFile('/home/student/infra/' + p, c);
    };
    w('roles/motd/defaults/main.yml', 'motd_text: hello\n');
    w('roles/motd/tasks/main.yml', '- name: motd\n  copy:\n    content: "{{ motd_text }}\\n"\n    dest: /etc/motd\n');
    w('roles.yml', '- hosts: db\n  become: yes\n  gather_facts: false\n  roles:\n    - motd\n');
    const r = t.run('ansible-playbook roles.yml -e motd_text=override');
    expect(r.out).toContain('TASK [motd : motd] ***');
    expect(t.run('ssh ubuntu@10.0.2.21 cat /etc/motd').out).toBe('override\n');
  });
});
