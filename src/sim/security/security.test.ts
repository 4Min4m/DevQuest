import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';
import { createMachine } from '../machines';
import { createAwsState, DEFAULT_KEY } from '../aws/api';
import { keyPem, makeCert, pem } from './tls';
import { Vfs } from '../vfs/vfs';

function tlsLab(days: number) {
  const t = makeShell();
  const day = 86400000;
  const ca = makeCert({ subject: { CN: 'DevQuest Internal CA', O: 'DevQuest' }, days: 3650, from: t.state.clock - 400 * day, keyId: 'ca'.repeat(20), isCA: true });
  const leaf = makeCert({ subject: { CN: 'shop.local' }, issuer: ca.subject, sans: ['shop.local'], days, from: t.state.clock - 90 * day, keyId: 'aa'.repeat(20), issuerKeyId: ca.keyId });
  const v = new Vfs(t.state.fs, { name: 'root', groups: ['root'] });
  v.mkdir('/etc/ssl/devquest-ca', { parents: true });
  v.mkdir('/etc/shop/tls', { parents: true });
  v.mkdir('/usr/local/bin', { parents: true });
  v.mkdir('/etc/systemd/system', { parents: true });
  v.mkdir('/etc/ssl/certs', { parents: true });
  v.writeFile('/etc/ssl/certs/devquest-ca.pem', pem('cert', ca));
  v.writeFile('/etc/ssl/devquest-ca/ca.pem', pem('cert', ca));
  v.writeFile('/etc/ssl/devquest-ca/ca.key', keyPem(ca.keyId));
  v.writeFile('/etc/shop/tls/shop.crt', pem('cert', leaf));
  v.writeFile('/etc/shop/tls/shop.key', keyPem(leaf.keyId));
  v.writeFile('/usr/local/bin/shop', 'bin');
  v.chmod('/usr/local/bin/shop', 0o755);
  v.writeFile('/etc/systemd/system/shop.service', '[Unit]\nDescription=Shop\n[Service]\nExecStart=/usr/local/bin/shop\n[Install]\nWantedBy=multi-user.target\n');
  v.writeFile('/etc/hosts', v.readFile('/etc/hosts') + '127.0.0.1 shop.local\n');
  t.state.systemd!.binaries['/usr/local/bin/shop'] = { name: 'shop', listen: 443, tls: { cert: '/etc/shop/tls/shop.crt', key: '/etc/shop/tls/shop.key' }, http: { '/': { body: 'shop ok\n' } } };
  t.setup('sudo systemctl daemon-reload', 'sudo systemctl start shop');
  return t;
}

describe('TLS', () => {
  it('verifies certificates like curl', () => {
    const t = tlsLab(60);
    const r = t.run('curl -sS https://shop.local');
    expect(r.code).toBe(60);
    expect(r.err).toContain('curl: (60) SSL certificate problem: certificate has expired');
    expect(t.run('curl -sk https://shop.local').out).toBe('shop ok\n');
    expect(t.run('openssl x509 -in /etc/shop/tls/shop.crt -noout -subject -enddate').out).toMatch(/^subject=CN = shop.local\nnotAfter=\w{3} [ \d]\d \d\d:\d\d:\d\d \d{4} GMT\n$/);
    expect(t.run('openssl x509 -in /etc/shop/tls/shop.crt -noout -checkend 0').code).toBe(1);
    expect(t.run('openssl s_client -connect shop.local:443 -servername shop.local').out).toContain('Verify return code: 10 (certificate has expired)');
  });
  it('issues a new certificate from the CA (SANs need -copy_extensions)', () => {
    const t = tlsLab(60);
    t.setup('openssl genrsa -out shop.key 2048', 'openssl req -new -key shop.key -out shop.csr -subj "/CN=shop.local" -addext "subjectAltName=DNS:shop.local"');
    t.setup('sudo openssl x509 -req -in shop.csr -CA /etc/ssl/devquest-ca/ca.pem -CAkey /etc/ssl/devquest-ca/ca.key -out nosan.crt -days 90');
    t.setup('sudo cp nosan.crt /etc/shop/tls/shop.crt', 'sudo cp shop.key /etc/shop/tls/shop.key', 'sudo systemctl restart shop');
    expect(t.run('curl -sS https://shop.local').err).toContain("no alternative certificate subject name matches target host name 'shop.local'");
    t.setup('sudo openssl x509 -req -in shop.csr -CA /etc/ssl/devquest-ca/ca.pem -CAkey /etc/ssl/devquest-ca/ca.key -copy_extensions copy -out shop.crt -days 90', 'sudo cp shop.crt /etc/shop/tls/shop.crt');
    expect(t.run('curl -sS https://shop.local').err).toContain('no alternative');
    t.setup('sudo systemctl restart shop');
    expect(t.run('curl -sS https://shop.local').out).toBe('shop ok\n');
    expect(t.run('openssl verify -CAfile /etc/ssl/devquest-ca/ca.pem shop.crt').out).toBe('shop.crt: OK\n');
  });
  it('a mismatched key keeps the service down', () => {
    const t = tlsLab(60);
    t.setup('openssl genrsa -out other.key 2048', 'sudo cp other.key /etc/shop/tls/shop.key');
    t.setup('sudo systemctl restart shop');
    expect(t.run('systemctl is-active shop').out).toBe('failed\n');
    expect(t.run('journalctl -u shop --no-pager').out).toContain('tls: private key does not match public key');
  });
});

describe('trivy', () => {
  it('scans images and finds fixable criticals', () => {
    const t = makeShell();
    t.setup('mkdir app', "printf 'flask==0.12.2\\nrequests==2.31.0\\n' > app/requirements.txt", "printf 'FROM python:3.8\\nCOPY requirements.txt /app/requirements.txt\\nCMD [\"python3\"]\\n' > app/Dockerfile", 'docker build -q -t shop:1 app');
    const r = t.run('trivy image -q --severity CRITICAL shop:1');
    expect(r.out).toContain('shop:1 (debian 11.6)');
    expect(r.out).toContain('CVE-2022-37434');
    expect(r.out).not.toContain('CVE-2023-4911');
    expect(t.run('trivy image -q --severity CRITICAL --exit-code 1 shop:1').code).toBe(1);
    const all = t.run('trivy image -q shop:1');
    expect(all.out).toContain('app/requirements.txt (pip)');
    expect(all.out).toContain('CVE-2018-1000656');
    t.setup("sed -i 's/python:3.8/python:3.12-slim/' app/Dockerfile", "sed -i 's/flask==0.12.2/flask==3.0.3/' app/requirements.txt", 'docker build -q -t shop:2 app');
    expect(t.run('trivy image -q --severity HIGH,CRITICAL --exit-code 1 shop:2').code).toBe(0);
  });
  it('config and secret scanning', () => {
    const t = makeShell();
    t.setup('mkdir k8s', "printf 'apiVersion: apps/v1\\nkind: Deployment\\nmetadata:\\n  name: api\\nspec:\\n  template:\\n    spec:\\n      containers:\\n        - name: api\\n          image: api:1\\n          securityContext:\\n            privileged: true\\n' > k8s/api.yaml");
    const c = t.run('trivy config -q k8s');
    expect(c.out).toContain('AVD-KSV-0017 (HIGH)');
    expect(c.out).toContain('Failures: 6');
    t.setup("printf 'AWS_ACCESS_KEY_ID=AKIAQWERTYUIOPASDFGH\\n' > k8s/.env");
    expect(t.run('trivy fs -q --scanners secret k8s').out).toContain('CRITICAL: AWS Access Key ID (aws-access-token)');
  });
});

describe('gitleaks', () => {
  it('finds secrets in git history even after deletion', () => {
    const t = makeShell();
    t.setup('mkdir api', 'cd api', 'git init -q', "printf 'DB_HOST=db\\nAWS_ACCESS_KEY_ID=AKIAQWERTYUIOPASDFGH\\n' > .env", 'git add .', "git commit -qm 'add config'", 'git rm -q .env', 'git commit -qm "remove env"');
    const r = t.run('gitleaks git -v');
    expect(r.code).toBe(1);
    expect(r.out).toContain('RuleID:      aws-access-token');
    expect(r.out).toContain('File:        .env');
    expect(r.err).toContain('WRN leaks found: 1');
    expect(t.run('gitleaks dir .').code).toBe(0);
  });
});

describe('hardening', () => {
  it('ufw blocks connections; sshd honours PermitRootLogin after a reload', () => {
    const t = makeShell();
    t.state.machines = { web1: createMachine({ hostname: 'web1', ip: '10.0.2.11', packages: ['nginx'], sshUsers: ['ubuntu', 'root'] }, t.state.clock) };
    t.setup("echo '10.0.2.11 web1' | sudo tee -a /etc/hosts");
    expect(t.run('ssh ubuntu@web1 sudo ufw status').out).toBe('Status: inactive\n');
    t.setup('ssh ubuntu@web1 sudo ufw allow OpenSSH', 'ssh ubuntu@web1 sudo ufw --force enable');
    expect(t.run('curl -s -m 3 http://web1').code).toBe(28);
    t.setup("ssh ubuntu@web1 sudo ufw allow 'Nginx HTTP'");
    expect(t.run('curl -s http://web1').out).toContain('Welcome to nginx');
    expect(t.run('ssh root@web1 hostname').out).toBe('web1\n');
    t.setup("ssh ubuntu@web1 \"echo 'PermitRootLogin no' | sudo tee -a /etc/ssh/sshd_config\"");
    expect(t.run('ssh root@web1 hostname').out).toBe('web1\n');
    t.setup("ssh ubuntu@web1 \"echo 'PermitRootLogn no' | sudo tee -a /etc/ssh/sshd_config\"");
    expect(t.run('ssh ubuntu@web1 sudo sshd -t').err).toContain('Bad configuration option: PermitRootLogn');
    t.setup("ssh ubuntu@web1 sudo sed -i '/PermitRootLogn/d' /etc/ssh/sshd_config", 'ssh ubuntu@web1 sudo sshd -t', 'ssh ubuntu@web1 sudo systemctl reload ssh');
    expect(t.run('ssh root@web1 hostname').err).toContain('Permission denied (publickey)');
  });
  it('rotating a leaked AWS key', () => {
    const t = makeShell();
    t.state.aws = createAwsState();
    t.setup(`aws configure set aws_access_key_id ${DEFAULT_KEY.id}`, `aws configure set aws_secret_access_key ${DEFAULT_KEY.secret}`);
    const created = JSON.parse(t.run('aws iam create-access-key').out).AccessKey;
    expect(t.run('aws iam list-access-keys --query "AccessKeyMetadata[].Status" --output text').out).toBe('Active\tActive\n');
    t.setup(`aws configure set aws_access_key_id ${created.AccessKeyId}`, `aws configure set aws_secret_access_key ${created.SecretAccessKey}`, `aws iam update-access-key --access-key-id ${DEFAULT_KEY.id} --status Inactive`);
    expect(t.run(`AWS_ACCESS_KEY_ID=${DEFAULT_KEY.id} AWS_SECRET_ACCESS_KEY=${DEFAULT_KEY.secret} aws sts get-caller-identity`).err).toContain('InvalidClientTokenId');
    expect(t.run('aws sts get-caller-identity').code).toBe(0);
  });
});
