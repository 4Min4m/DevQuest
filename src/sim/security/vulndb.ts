/** A tiny offline vulnerability and misconfiguration database (real CVE ids, simplified data). */

export type Severity = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Vuln {
  pkg: string;
  id: string;
  severity: Severity;
  installed: string;
  fixed?: string;
  title: string;
}

/** OS package findings by base image. */
export const IMAGE_VULNS: Record<string, { os: string; vulns: Vuln[] }> = {
  'python:3.8': {
    os: 'debian 11.6',
    vulns: [
      { pkg: 'curl', id: 'CVE-2023-38545', severity: 'CRITICAL', installed: '7.74.0-1.3+deb11u7', fixed: '7.74.0-1.3+deb11u10', title: 'curl: heap based buffer overflow in the SOCKS5 proxy handshake' },
      { pkg: 'zlib1g', id: 'CVE-2022-37434', severity: 'CRITICAL', installed: '1:1.2.11.dfsg-2+deb11u1', fixed: '1:1.2.11.dfsg-2+deb11u2', title: 'zlib: heap-based buffer over-read and overflow in inflate() in inflate.c via a large gzip header extra field' },
      { pkg: 'libc6', id: 'CVE-2023-4911', severity: 'HIGH', installed: '2.31-13+deb11u5', fixed: '2.31-13+deb11u7', title: 'glibc: buffer overflow in ld.so leading to privilege escalation' },
      { pkg: 'libpython3.9-stdlib', id: 'CVE-2023-24329', severity: 'HIGH', installed: '3.9.2-1', fixed: '3.9.2-1+deb11u1', title: 'python: urllib.parse url blocklisting bypass' },
      { pkg: 'libssl1.1', id: 'CVE-2023-0286', severity: 'HIGH', installed: '1.1.1n-0+deb11u3', fixed: '1.1.1n-0+deb11u4', title: 'openssl: X.400 address type confusion in X.509 GeneralName' },
      { pkg: 'apt', id: 'CVE-2011-3374', severity: 'LOW', installed: '2.2.4', title: 'It was found that apt-key in apt, all versions, do not correctly validate ...' },
    ],
  },
  'node:16': {
    os: 'debian 11.7',
    vulns: [
      { pkg: 'zlib1g', id: 'CVE-2022-37434', severity: 'CRITICAL', installed: '1:1.2.11.dfsg-2+deb11u1', fixed: '1:1.2.11.dfsg-2+deb11u2', title: 'zlib: heap-based buffer over-read and overflow in inflate() in inflate.c via a large gzip header extra field' },
      { pkg: 'libc6', id: 'CVE-2023-4911', severity: 'HIGH', installed: '2.31-13+deb11u6', fixed: '2.31-13+deb11u7', title: 'glibc: buffer overflow in ld.so leading to privilege escalation' },
      { pkg: 'apt', id: 'CVE-2011-3374', severity: 'LOW', installed: '2.2.4', title: 'It was found that apt-key in apt, all versions, do not correctly validate ...' },
    ],
  },
  'nginx:1.16.0': {
    os: 'debian 9.9',
    vulns: [
      { pkg: 'libssl1.1', id: 'CVE-2021-3711', severity: 'CRITICAL', installed: '1.1.0j-1~deb9u1', fixed: '1.1.0l-1~deb9u4', title: 'openssl: SM2 Decryption Buffer Overflow' },
      { pkg: 'nginx', id: 'CVE-2021-23017', severity: 'HIGH', installed: '1.16.0-1~stretch', fixed: '1.20.1-1~stretch', title: 'nginx: Off-by-one in ngx_resolver_copy() when labels are followed by a pointer to a root domain name' },
      { pkg: 'zlib1g', id: 'CVE-2018-25032', severity: 'HIGH', installed: '1:1.2.8.dfsg-5', fixed: '1:1.2.8.dfsg-5+deb9u1', title: 'zlib: A flaw found in zlib when compressing (not decompressing) certain inputs' },
    ],
  },
};

/** Images not listed: current Debian images carry only low, unfixed findings; alpine ones none. */
export const CURRENT_DEBIAN: Vuln[] = [
  { pkg: 'apt', id: 'CVE-2011-3374', severity: 'LOW', installed: '2.6.1', title: 'It was found that apt-key in apt, all versions, do not correctly validate ...' },
  { pkg: 'coreutils', id: 'CVE-2017-18018', severity: 'LOW', installed: '9.1-1', title: 'coreutils: race condition vulnerability in chown and chgrp' },
];

/** Language package findings: name → [vulnerable below `fixed`, id, severity, title]. */
export const PKG_VULNS: Record<'pip' | 'npm', Record<string, { fixed: string; id: string; severity: Severity; title: string }[]>> = {
  pip: {
    flask: [{ fixed: '0.12.3', id: 'CVE-2018-1000656', severity: 'HIGH', title: 'flask: Denial of Service via crafted JSON file' }],
    requests: [{ fixed: '2.20.0', id: 'CVE-2018-18074', severity: 'HIGH', title: 'python-requests: Redirect from HTTPS to HTTP does not remove Authorization header' }],
    pyyaml: [{ fixed: '5.4', id: 'CVE-2020-14343', severity: 'CRITICAL', title: 'PyYAML: incomplete fix for CVE-2020-1747' }],
    jinja2: [{ fixed: '2.10.1', id: 'CVE-2019-10906', severity: 'HIGH', title: 'python-jinja2: str.format_map allows sandbox escape' }],
    django: [{ fixed: '2.2.9', id: 'CVE-2019-19844', severity: 'CRITICAL', title: 'Django: crafted email address allows account takeover' }],
    urllib3: [{ fixed: '1.24.2', id: 'CVE-2019-11324', severity: 'HIGH', title: 'python-urllib3: Certification mishandle when error should be thrown' }],
  },
  npm: {
    lodash: [
      { fixed: '4.17.19', id: 'CVE-2020-8203', severity: 'HIGH', title: 'nodejs-lodash: prototype pollution in zipObjectDeep function' },
      { fixed: '4.17.21', id: 'CVE-2021-23337', severity: 'HIGH', title: 'nodejs-lodash: command injection via template' },
    ],
    minimist: [{ fixed: '1.2.6', id: 'CVE-2021-44906', severity: 'CRITICAL', title: 'minimist: prototype pollution' }],
    axios: [{ fixed: '0.21.2', id: 'CVE-2021-3749', severity: 'HIGH', title: 'nodejs-axios: Regular expression denial of service in trim function' }],
    jsonwebtoken: [{ fixed: '9.0.0', id: 'CVE-2022-23529', severity: 'HIGH', title: 'jsonwebtoken: Unrestricted key type could lead to legacy keys usage' }],
    qs: [{ fixed: '6.10.3', id: 'CVE-2022-24999', severity: 'HIGH', title: 'express: "qs" prototype poisoning causes the hang of the node process' }],
  },
};

export function versionLess(a: string, b: string): boolean {
  const pa = a.replace(/^[^\d]*/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^[^\d]*/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

export interface Misconfig {
  id: string;
  severity: Severity;
  title: string;
  message: string;
  url: string;
}
