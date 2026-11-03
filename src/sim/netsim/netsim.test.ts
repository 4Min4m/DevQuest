import { describe, expect, it } from 'vitest';
import { makeShell } from '../testing';

describe('dig / nslookup / host', () => {
  it('answers A queries in dig format', () => {
    const t = makeShell();
    const r = t.run('dig example.com');
    expect(r.code).toBe(0);
    expect(r.out).toContain(';; ->>HEADER<<- opcode: QUERY, status: NOERROR');
    expect(r.out).toContain(';example.com.\t\t\tIN\tA\n');
    expect(r.out).toMatch(/;; ANSWER SECTION:\nexample\.com\.\t\t3600\tIN\tA\t93\.184\.216\.34\n/);
    expect(r.out).toContain(';; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)');
  });

  it('+short follows CNAMEs and supports record types', () => {
    const t = makeShell();
    expect(t.run('dig +short www.example.com').out).toBe('example.com.\n93.184.216.34\n');
    expect(t.run('dig +short example.com MX').out).toBe('0 .\n');
    expect(t.run('dig -t AAAA +short example.com').out).toMatch(/^2606:/);
    expect(t.run('dig +short -x 93.184.216.34').out).toBe('example.com.\n');
  });

  it('reports NXDOMAIN (still exit 0, like real dig)', () => {
    const t = makeShell();
    const r = t.run('dig nope.example.com');
    expect(r.code).toBe(0);
    expect(r.out).toContain('status: NXDOMAIN');
    expect(r.out).not.toContain('ANSWER SECTION');
    expect(t.run('dig +short nope.example.com').out).toBe('');
  });

  it('ignores /etc/hosts — unlike curl and ping', () => {
    const t = makeShell();
    t.setup("echo '10.9.9.9 example.com' | sudo tee -a /etc/hosts");
    expect(t.run('dig +short example.com').out).toBe('93.184.216.34\n');
    expect(t.run('ping -c 1 example.com').out).toContain('PING example.com (10.9.9.9)');
  });

  it('times out against an unreachable DNS server', () => {
    const t = makeShell();
    const r = t.run('dig @10.0.0.99 example.com');
    expect(r.code).toBe(9);
    expect(r.out).toContain(';; communications error to 10.0.0.99#53: timed out');
    expect(r.out).toContain(';; no servers could be reached');
    expect(t.run('dig @8.8.8.8 +short example.com').out).toBe('93.184.216.34\n');
  });

  it('nslookup and host', () => {
    const t = makeShell();
    expect(t.run('nslookup www.example.com').out).toContain('www.example.com\tcanonical name = example.com.\nName:\texample.com\nAddress: 93.184.216.34\n');
    expect(t.run('nslookup nope.example.com')).toMatchObject({ out: expect.stringContaining("** server can't find nope.example.com: NXDOMAIN"), code: 1 });
    expect(t.run('host www.example.com').out).toMatch(/^www\.example\.com is an alias for example\.com\.\nexample\.com has address 93\.184\.216\.34\n/);
    expect(t.run('host nope.example.com')).toMatchObject({ out: 'Host nope.example.com not found: 3(NXDOMAIN)\n', code: 1 });
  });
});

describe('ping / traceroute', () => {
  it('pings reachable hosts', () => {
    const t = makeShell();
    const r = t.run('ping -c 3 example.com');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^PING example\.com \(93\.184\.216\.34\) 56\(84\) bytes of data\.\n64 bytes from example\.com \(93\.184\.216\.34\): icmp_seq=1 ttl=56 time=[\d.]+ ms\n/);
    expect(r.out).toContain('3 packets transmitted, 3 received, 0% packet loss');
    expect(r.out).toMatch(/rtt min\/avg\/max\/mdev = [\d.]+\/[\d.]+\/[\d.]+\/[\d.]+ ms\n$/);
    expect(t.run('ping -c1 localhost').out).toContain('ttl=64');
  });

  it('defaults to 4 packets with a note, and reports unknown or unreachable hosts', () => {
    const t = makeShell();
    const r = t.shell.run('ping example.com');
    expect(r.output.map((c) => c.text).join('')).toContain('4 packets transmitted');
    expect(r.output.some((c) => c.note)).toBe(true);
    expect(t.run('ping nope.invalid')).toMatchObject({ err: 'ping: nope.invalid: Name or service not known\n', code: 2 });
    const down = t.run('ping -c 2 10.0.9.9');
    expect(down.code).toBe(1);
    expect(down.out).toContain('2 packets transmitted, 0 received, 100% packet loss');
    expect(t.run('ping')).toMatchObject({ err: 'ping: usage error: Destination address required\n', code: 1 });
  });

  it('traceroute lists the hops', () => {
    const t = makeShell();
    const r = t.run('traceroute example.com');
    expect(r.out).toMatch(/^traceroute to example\.com \(93\.184\.216\.34\), 30 hops max, 60 byte packets\n {2}1 {2}_gateway \(10\.0\.1\.1\)/);
    expect(r.out.trim().split('\n').pop()).toMatch(/example\.com \(93\.184\.216\.34\)/);
  });
});

describe('ss / netstat / lsof', () => {
  it('shows listening ports; processes only for root', () => {
    const t = makeShell();
    const user = t.run('ss -tlnp').out;
    expect(user).toMatch(/^State +Recv-Q Send-Q +Local Address:Port +Peer Address:Port Process\nLISTEN 0 +4096 +0\.0\.0\.0:22 +0\.0\.0\.0:\*\n$/);
    expect(t.run('sudo ss -tlnp').out).toContain('users:(("sshd",pid=655,fd=3))');
    expect(t.run('ss -tl').out).toContain('*:ssh');
  });

  it('includes docker-proxy for published container ports', () => {
    const t = makeShell();
    t.setup('docker run -d --name web -p 8080:80 nginx');
    expect(t.run('sudo ss -tlnp').out).toMatch(/0\.0\.0\.0:8080 .*"docker-proxy"/);
    expect(t.run('sudo lsof -i :8080').out).toBe('');
  });

  it('netstat warns non-root users', () => {
    const t = makeShell();
    const r = t.run('netstat -tlnp');
    expect(r.out).toMatch(/^\(Not all processes could be identified/);
    expect(r.out).toMatch(/tcp +0 +0 0\.0\.0\.0:22 +0\.0\.0\.0:\* +LISTEN +-\n/);
    expect(t.run('sudo netstat -tlnp').out).toContain('655/sshd');
  });

  it('lsof -i :PORT and -p PID', () => {
    const t = makeShell();
    expect(t.run('lsof -i :22')).toMatchObject({ out: '', code: 1 }); // root's process is invisible to student
    const r = t.run('sudo lsof -i :22');
    expect(r.out).toMatch(/^COMMAND +PID +USER +FD +TYPE +DEVICE +SIZE\/OFF +NODE NAME\nsshd +655 +root +3u +IPv4 .* TCP \*:22 \(LISTEN\)\n$/);
    expect(t.run('sudo lsof -p 655').out).toContain(' cwd ');
    expect(t.run('lsof -z').code).toBe(1);
  });
});

describe('ip / hostname', () => {
  it('shows addresses and routes', () => {
    const t = makeShell();
    expect(t.run('ip addr').out).toContain('inet 10.0.1.15/24 brd 10.0.1.255 scope global eth0');
    expect(t.run('ip a').out).toContain('inet 127.0.0.1/8 scope host lo');
    expect(t.run('ip route').out).toMatch(/^default via 10\.0\.1\.1 dev eth0/);
    expect(t.run('ip link').code).toBe(1);
    expect(t.run('hostname').out).toBe('devquest\n');
    expect(t.run('hostname -I').out).toBe('10.0.1.15 \n');
  });
});

describe('curl over the simulated network', () => {
  it('reaches remote hosts by DNS and reports the failing layer', () => {
    const t = makeShell();
    t.state.net!.records.push({ name: 'down.internal', type: 'A', value: '10.0.9.9', ttl: 60 });
    expect(t.run('curl -s http://example.com/').out).toContain('Example Domain');
    expect(t.run('curl nope.invalid')).toMatchObject({ err: 'curl: (6) Could not resolve host: nope.invalid\n', code: 6 });
    expect(t.run('curl example.com:8080')).toMatchObject({ code: 7 });
    expect(t.run('curl down.internal')).toMatchObject({ code: 28 });
    expect(t.run('curl --connect-timeout 5 down.internal').err).toBe('curl: (28) Failed to connect to down.internal port 80 after 5001 ms: Timeout was reached\n');
    expect(t.run('curl example.com:443').err).toBe('curl: (52) Empty reply from server\n');
  });

  it('-v shows the connection and headers on stderr', () => {
    const t = makeShell();
    const r = t.run('curl -v example.com');
    expect(r.out).toContain('Example Domain');
    expect(r.err).toMatch(/^\* {3}Trying 93\.184\.216\.34:80\.\.\.\n\* Connected to example\.com \(93\.184\.216\.34\) port 80\n> GET \/ HTTP\/1\.1\n> Host: example\.com\n/);
    expect(r.err).toContain('< HTTP/1.1 200 OK\n');
    expect(r.err).toMatch(/\* Connection #0 to host example\.com left intact\n$/);
  });

  it('-w prints transfer variables; -o /dev/null discards the body', () => {
    const t = makeShell();
    expect(t.run("curl -s -o /dev/null -w '%{http_code}\\n' example.com").out).toBe('200\n');
    t.setup('docker run -d --name web -p 8080:80 nginx');
    expect(t.run("curl -s -o /dev/null -w '%{http_code}' localhost:8080/missing").out).toBe('404');
    expect(t.run("curl -s -w '%{http_code} %{remote_ip}' nope.invalid")).toMatchObject({ out: '000 ', code: 6 });
    expect(t.run('curl -m x example.com').code).toBe(2);
  });

  it('talks to services on this host', () => {
    const t = makeShell();
    expect(t.run('curl localhost:22').err).toBe('curl: (1) Received HTTP/0.9 when not allowed\n');
    expect(t.run('curl 10.0.1.15:22').code).toBe(1);
  });
});
