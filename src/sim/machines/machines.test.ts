import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { createMachine } from './index';

function lab() {
  const t = makeShell();
  t.state.machines = {
    web1: createMachine({ hostname: 'web1', ip: '10.0.2.11' }, t.state.clock),
    db1: createMachine({ hostname: 'db1', ip: '10.0.2.21', packages: ['postgresql'] }, t.state.clock),
  };
  t.setup("echo '10.0.2.11 web1' | sudo tee -a /etc/hosts", "echo '10.0.2.21 db1' | sudo tee -a /etc/hosts");
  return t;
}

describe('apt', () => {
  it('needs root', () => {
    const t = makeShell();
    const r = t.run('apt-get install -y nginx');
    expect(r.code).toBe(100);
    expect(r.err).toContain('are you root?');
  });
  it('installs nginx, starts and enables it, serves the default page', () => {
    const t = makeShell();
    const r = t.run('sudo apt-get install -y nginx');
    expect(r.code).toBe(0);
    expect(r.out).toContain('The following NEW packages will be installed:\n  nginx nginx-common');
    expect(r.out).toContain('Setting up nginx (1.24.0-2ubuntu7.1) ...');
    expect(t.run('systemctl is-active nginx').out).toBe('active\n');
    expect(t.run('systemctl is-enabled nginx').out).toBe('enabled\n');
    expect(t.run('curl -s localhost').out).toContain('Welcome to nginx!');
    expect(t.run('sudo apt-get install -y nginx').out).toContain('nginx is already the newest version');
  });
  it('unknown packages and the prompt', () => {
    const t = makeShell();
    expect(t.run('sudo apt install -y nginxx').err).toContain('E: Unable to locate package nginxx');
    const r = t.run('sudo apt-get install nginx');
    expect(r.code).toBe(1);
    expect(r.out).toContain('Abort.');
    expect(t.run('echo y | sudo apt-get install nginx').code).toBe(0);
  });
  it('remove stops the service', () => {
    const t = makeShell();
    t.setup('sudo apt-get install -y nginx');
    expect(t.run('sudo apt-get remove -y nginx').out).toContain('Removing nginx');
    expect(t.run('curl -s localhost').code).toBe(7);
    expect(t.run('apt list --installed').out).not.toContain('nginx/');
  });
});

describe('ssh and machines', () => {
  it('fresh servers need apt update first', () => {
    const t = lab();
    const r = t.run('ssh ubuntu@web1 sudo apt-get install -y nginx');
    expect(r.err).toContain('E: Unable to locate package nginx');
    expect(t.run('ssh ubuntu@web1 sudo apt-get update').code).toBe(0);
    expect(t.run('ssh ubuntu@web1 sudo apt-get install -y nginx').code).toBe(0);
    expect(t.run('curl -s http://web1').out).toContain('Welcome to nginx!');
    expect(t.run('curl -s http://10.0.2.11/').out).toContain('Welcome to nginx!');
  });
  it('runs commands as the remote user', () => {
    const t = lab();
    expect(t.run('ssh ubuntu@web1 hostname').out).toBe('web1\n');
    expect(t.run('ssh ubuntu@web1 whoami').out).toBe('ubuntu\n');
    expect(t.run('ssh ubuntu@web1 "docker ps"').code).toBe(127);
    expect(t.run('ssh ubuntu@db1 systemctl is-active postgresql').out).toBe('active\n');
  });
  it('errors like ssh', () => {
    const t = lab();
    expect(t.run('ssh web1 hostname').err).toContain('student@web1: Permission denied (publickey).');
    expect(t.run('ssh ubuntu@nope true').err).toContain('Could not resolve hostname nope');
    t.state.machines!.web1.machine!.up = false;
    expect(t.run('ssh ubuntu@web1 true').err).toContain('port 22: Connection timed out');
  });
  it('key files must exist and be private', () => {
    const t = lab();
    t.state.machines!.web1.machine!.keyFile = 'deploy.pem';
    t.setup('mkdir -p ~/.ssh', 'echo KEY > ~/.ssh/deploy.pem');
    expect(t.run('ssh ubuntu@web1 true').err).toContain('Permission denied (publickey)');
    expect(t.run('ssh -i ~/.ssh/deploy.pem ubuntu@web1 true').err).toContain('UNPROTECTED PRIVATE KEY FILE');
    t.setup('chmod 600 ~/.ssh/deploy.pem');
    expect(t.run('ssh -i ~/.ssh/deploy.pem ubuntu@web1 hostname').out).toBe('web1\n');
  });
});
