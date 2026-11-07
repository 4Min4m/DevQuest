/** X.509 certificates (simulated PEM), openssl, update-ca-certificates, and TLS verification for curl. */
import type { CommandContext, CommandDef } from '../shell/types';
import type { SimState } from '../state';
import { Vfs } from '../vfs/vfs';

export interface Name {
  CN?: string;
  O?: string;
  C?: string;
  OU?: string;
}

export interface Cert {
  subject: Name;
  issuer: Name;
  sans: string[];
  notBefore: number;
  notAfter: number;
  serial: string;
  keyId: string;
  issuerKeyId: string;
  isCA?: boolean;
}

interface Key {
  keyId: string;
  bits: number;
}
interface Csr {
  subject: Name;
  sans: string[];
  keyId: string;
}

const PEM = { cert: 'CERTIFICATE', key: 'PRIVATE KEY', csr: 'CERTIFICATE REQUEST' } as const;

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}
function unb64(s: string): string {
  return decodeURIComponent(escape(atob(s)));
}

export function pem(kind: keyof typeof PEM, obj: object): string {
  const body = 'MII' + b64(JSON.stringify(obj));
  return `-----BEGIN ${PEM[kind]}-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END ${PEM[kind]}-----\n`;
}

/** All objects of a kind in a PEM text (a bundle may hold several certs). */
export function unpem<T>(kind: keyof typeof PEM, text: string): T[] {
  const out: T[] = [];
  const re = new RegExp(`-----BEGIN ${PEM[kind]}-----([\\s\\S]*?)-----END ${PEM[kind]}-----`, 'g');
  for (const m of text.matchAll(re)) {
    try {
      out.push(JSON.parse(unb64(m[1].replace(/\s/g, '').replace(/^MII/, ''))) as T);
    } catch {
      /* not ours */
    }
  }
  return out;
}

let seq = 0;
function hex(n: number, len: number): string {
  let x = (n * 2654435761 + 0x9e3779b9) >>> 0;
  let s = '';
  while (s.length < len) {
    x = (x * 1103515245 + 12345) >>> 0;
    s += (x >>> 8).toString(16).padStart(6, '0');
  }
  return s.slice(0, len);
}
function newKeyId(state: SimState): string {
  seq++;
  return hex(Math.floor(state.clock / 1000) + seq * 7919, 40);
}

export function makeCert(o: { subject: Name; issuer?: Name; sans?: string[]; days: number; from: number; keyId: string; issuerKeyId?: string; isCA?: boolean; serial?: string }): Cert {
  return { subject: o.subject, issuer: o.issuer ?? o.subject, sans: o.sans ?? [], notBefore: o.from, notAfter: o.from + o.days * 86400000, serial: o.serial ?? hex(o.from / 1000 + o.keyId.length, 40), keyId: o.keyId, issuerKeyId: o.issuerKeyId ?? o.keyId, isCA: o.isCA };
}

export const keyPem = (keyId: string, bits = 2048) => pem('key', { keyId, bits } satisfies Key);

const fmtName = (n: Name) => (['C', 'O', 'OU', 'CN'] as const).filter((k) => n[k]).map((k) => `${k} = ${n[k]}`).join(', ');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function osslDate(ms: number): string {
  const d = new Date(ms);
  return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${d.toISOString().slice(11, 19)} ${d.getUTCFullYear()} GMT`;
}
const colonHex = (h: string) => h.toUpperCase().match(/.{2}/g)!.join(':');

function parseSubj(s: string): Name {
  const n: Name = {};
  for (const part of s.split('/').filter(Boolean)) {
    const [k, v] = part.split('=');
    if (['CN', 'O', 'C', 'OU'].includes(k)) n[k as keyof Name] = v;
  }
  return n;
}

const SANS = (s: string) => s.replace(/^subjectAltName\s*=\s*/, '').split(',').map((x) => x.trim()).filter((x) => /^(DNS|IP):/.test(x)).map((x) => x.replace(/^(DNS|IP):/, ''));

// ------------------------------------------------------------------ trust & verification

/** Certificates in the system trust store (/etc/ssl/certs). */
export function trustStore(state: SimState): Cert[] {
  const v = new Vfs(state.fs, { name: 'root', groups: ['root'] });
  const out: Cert[] = [];
  try {
    for (const f of v.readdir('/etc/ssl/certs')) {
      if (!/\.(pem|crt)$/.test(f)) continue;
      try {
        out.push(...unpem<Cert>('cert', v.readFile(`/etc/ssl/certs/${f}`)));
      } catch {
        /* unreadable */
      }
    }
  } catch {
    /* no store */
  }
  return out;
}

const hostMatches = (pat: string, host: string) => pat === host || (pat.startsWith('*.') && host.endsWith(pat.slice(1)) && host.split('.').length === pat.split('.').length);

/** Verify a server certificate like curl/OpenSSL: an error message (curl code 60) or null. */
export function verifyCert(state: SimState, certPem: string, host: string, extraCa?: string): { code: number; reason: string; ossl: number } | null {
  const [cert] = unpem<Cert>('cert', certPem);
  if (!cert) return { code: 35, reason: 'OpenSSL/3.0.13: error:0A000126:SSL routines::unexpected eof while reading', ossl: 0 };
  const trusted = [...trustStore(state), ...(extraCa ? unpem<Cert>('cert', extraCa) : [])];
  const selfSigned = cert.issuerKeyId === cert.keyId;
  const anchor = trusted.find((c) => c.keyId === cert.issuerKeyId);
  if (!anchor) return selfSigned ? { code: 60, reason: 'self-signed certificate', ossl: 18 } : { code: 60, reason: 'unable to get local issuer certificate', ossl: 20 };
  if (cert.notAfter < state.clock) return { code: 60, reason: 'certificate has expired', ossl: 10 };
  if (cert.notBefore > state.clock) return { code: 60, reason: 'certificate is not yet valid', ossl: 9 };
  if (anchor.notAfter < state.clock && !selfSigned) return { code: 60, reason: 'certificate has expired', ossl: 10 };
  const names = cert.sans.length ? cert.sans : [];
  if (!names.some((n) => hostMatches(n, host))) return { code: 60, reason: `__host__`, ossl: 62 };
  return null;
}

export function curlTlsMessage(e: { code: number; reason: string }, host: string): string {
  if (e.reason === '__host__') return `SSL: no alternative certificate subject name matches target host name '${host}'\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the webpage mentioned above.`;
  if (e.code !== 60) return e.reason;
  return `SSL certificate problem: ${e.reason}\nMore details here: https://curl.se/docs/sslcerts.html\n\ncurl failed to verify the legitimacy of the server and therefore could not\nestablish a secure connection to it. To learn more about this situation and\nhow to fix it, please visit the webpage mentioned above.`;
}

/** The certificate a TLS service on this machine presents on `port` (as loaded at start). */
export function servedCert(state: SimState, port: number): string | undefined {
  return state.processes.find((p) => p.ports?.includes(port) && p.tls)?.tls;
}

// ------------------------------------------------------------------ openssl

function textOf(c: Cert): string {
  return `Certificate:
    Data:
        Version: 3 (0x2)
        Serial Number:
            ${colonHex(c.serial.slice(0, 32)).toLowerCase()}
        Signature Algorithm: sha256WithRSAEncryption
        Issuer: ${fmtName(c.issuer)}
        Validity
            Not Before: ${osslDate(c.notBefore)}
            Not After : ${osslDate(c.notAfter)}
        Subject: ${fmtName(c.subject)}
        Subject Public Key Info:
            Public Key Algorithm: rsaEncryption
                Public-Key: (2048 bit)
        X509v3 extensions:
${c.sans.length ? `            X509v3 Subject Alternative Name: \n                ${c.sans.map((s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? `IP Address:${s}` : `DNS:${s}`)).join(', ')}\n` : ''}            X509v3 Basic Constraints: critical
                CA:${c.isCA ? 'TRUE' : 'FALSE'}
            X509v3 Subject Key Identifier: 
                ${colonHex(c.keyId)}
            X509v3 Authority Key Identifier: 
                ${colonHex(c.issuerKeyId)}
    Signature Algorithm: sha256WithRSAEncryption
`;
}

class OsslError extends Error {}

export const openssl: CommandDef = {
  name: 'openssl',
  summary: 'TLS toolkit: x509, req, genrsa, verify, s_client (simulated keys and certificates)',
  run(ctx) {
    const [sub, ...rest] = ctx.args;
    const opts: Record<string, string | true> = {};
    const flagsWithValue = new Set(['in', 'out', 'key', 'keyout', 'newkey', 'days', 'subj', 'addext', 'CA', 'CAkey', 'extfile', 'connect', 'servername', 'checkend', 'CAfile', 'algorithm', 'pkeyopt', 'ext', 'copy_extensions', 'set_serial', 'extensions', 'name']);
    const pos: string[] = [];
    const order: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a.startsWith('-') && a.length > 1) {
        const k = a.slice(1);
        order.push(k);
        if (flagsWithValue.has(k)) opts[k] = rest[++i] ?? '';
        else opts[k] = true;
      } else pos.push(a);
    }
    const read = (p: string) => {
      try {
        return ctx.vfs.readFile(ctx.resolve(p));
      } catch {
        throw new OsslError(`Could not open file or uri for loading ${p.endsWith('.key') || p.includes('key') ? 'private key' : 'certificate'} from ${p}\n4057A7F7A27F0000:error:80000002:system library:file_open:No such file or directory:../providers/implementations/storemgmt/file_store.c:267:calling stat(${p})`);
      }
    };
    const emit = (path: string | undefined, text: string) => {
      if (path) ctx.vfs.writeFile(ctx.resolve(path), text);
      else ctx.out(text);
    };
    const inCert = (): Cert => {
      const t = typeof opts.in === 'string' ? read(opts.in) : ctx.stdin;
      const [c] = unpem<Cert>('cert', t);
      if (!c) throw new OsslError('Could not read certificate from ' + (typeof opts.in === 'string' ? opts.in : '<stdin>') + '\nUnable to load certificate');
      return c;
    };
    try {
      switch (sub) {
        case 'version':
          ctx.out('OpenSSL 3.0.13 30 Jan 2024 (Library: OpenSSL 3.0.13 30 Jan 2024)\n');
          return 0;
        case 'genrsa':
        case 'genpkey': {
          const bits = Number(pos[0] ?? (typeof opts.pkeyopt === 'string' ? opts.pkeyopt.split(':')[1] : 2048));
          emit(opts.out as string | undefined, keyPem(newKeyId(ctx.state), bits));
          return 0;
        }
        case 'rsa':
        case 'pkey': {
          const [k] = unpem<Key>('key', typeof opts.in === 'string' ? read(opts.in) : ctx.stdin);
          if (!k) throw new OsslError('Could not read private key from ' + (opts.in ?? '<stdin>'));
          if (opts.modulus) ctx.out(`Modulus=${k.keyId.toUpperCase().repeat(13).slice(0, 512)}\n`);
          if (opts.check) ctx.out('RSA key ok\n');
          if (!opts.noout && !opts.modulus) emit(opts.out as string | undefined, keyPem(k.keyId, k.bits));
          return 0;
        }
        case 'md5':
        case 'sha256': {
          let h = 0;
          for (const ch of ctx.stdin) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          ctx.out(`${sub.toUpperCase()}(stdin)= ${hex(h, sub === 'md5' ? 32 : 64)}\n`);
          return 0;
        }
        case 'req': {
          if (opts.in && opts.noout) {
            const [r] = unpem<Csr>('csr', read(opts.in as string));
            if (!r) throw new OsslError('Unable to load X509 request');
            if (opts.text) ctx.out(`Certificate Request:\n    Data:\n        Version: 1 (0x0)\n        Subject: ${fmtName(r.subject)}\n        Attributes:\n            Requested Extensions:\n${r.sans.length ? `                X509v3 Subject Alternative Name: \n                    ${r.sans.map((s) => `DNS:${s}`).join(', ')}\n` : ''}`);
            if (opts.subject) ctx.out(`subject=${fmtName(r.subject)}\n`);
            return 0;
          }
          if (typeof opts.subj !== 'string') throw new OsslError('devquest: pass the subject with -subj "/CN=example.com" (interactive prompts are not simulated)');
          const subject = parseSubj(opts.subj);
          const sans = typeof opts.addext === 'string' ? SANS(opts.addext) : [];
          let keyId: string;
          if (typeof opts.key === 'string') {
            const [k] = unpem<Key>('key', read(opts.key));
            if (!k) throw new OsslError(`Could not read private key from ${opts.key}`);
            keyId = k.keyId;
          } else {
            keyId = newKeyId(ctx.state);
            if (!opts.nodes && !opts.noenc) throw new OsslError('devquest: key passphrases are not simulated; add -nodes (or -noenc)');
            emit((opts.keyout as string) ?? 'privkey.pem', keyPem(keyId));
            if (!opts.keyout) ctx.note('Writing private key to privkey.pem\n');
          }
          if (opts.x509) {
            const c = makeCert({ subject, sans, days: Number(opts.days ?? 30), from: ctx.state.clock, keyId, isCA: !sans.length && /CA/i.test(subject.CN ?? '') });
            emit(opts.out as string | undefined, pem('cert', c));
          } else emit(opts.out as string | undefined, pem('csr', { subject, sans, keyId } satisfies Csr));
          return 0;
        }
        case 'x509': {
          if (opts.req) {
            const [r] = unpem<Csr>('csr', typeof opts.in === 'string' ? read(opts.in) : ctx.stdin);
            if (!r) throw new OsslError('Unable to load X509 request');
            if (typeof opts.CA !== 'string' || typeof opts.CAkey !== 'string') throw new OsslError('devquest: sign with -CA ca.pem -CAkey ca.key');
            const [ca] = unpem<Cert>('cert', read(opts.CA));
            const [cak] = unpem<Key>('key', read(opts.CAkey));
            if (!ca || !cak) throw new OsslError('Unable to load CA certificate or key');
            if (ca.keyId !== cak.keyId) throw new OsslError('CA certificate and CA private key do not match');
            let sans: string[] = [];
            if (typeof opts.extfile === 'string') sans = SANS(read(opts.extfile).split('\n').find((l) => /subjectAltName/.test(l)) ?? '');
            if (opts.copy_extensions === 'copy' || opts.copy_extensions === 'copyall') sans = r.sans;
            const c = makeCert({ subject: r.subject, issuer: ca.subject, sans, days: Number(opts.days ?? 30), from: ctx.state.clock, keyId: r.keyId, issuerKeyId: ca.keyId });
            ctx.note(`Certificate request self-signature ok\nsubject=${fmtName(r.subject)}\n`);
            emit(opts.out as string | undefined, pem('cert', c));
            return 0;
          }
          const c = inCert();
          for (const k of order) {
            if (k === 'text') ctx.out(textOf(c));
            else if (k === 'subject') ctx.out(`subject=${fmtName(c.subject)}\n`);
            else if (k === 'issuer') ctx.out(`issuer=${fmtName(c.issuer)}\n`);
            else if (k === 'dates') ctx.out(`notBefore=${osslDate(c.notBefore)}\nnotAfter=${osslDate(c.notAfter)}\n`);
            else if (k === 'startdate') ctx.out(`notBefore=${osslDate(c.notBefore)}\n`);
            else if (k === 'enddate') ctx.out(`notAfter=${osslDate(c.notAfter)}\n`);
            else if (k === 'serial') ctx.out(`serial=${c.serial.slice(0, 32).toUpperCase()}\n`);
            else if (k === 'fingerprint') ctx.out(`SHA1 Fingerprint=${colonHex(c.keyId.slice(0, 40))}\n`);
            else if (k === 'modulus') ctx.out(`Modulus=${c.keyId.toUpperCase().repeat(13).slice(0, 512)}\n`);
            else if (k === 'ext') ctx.out(c.sans.length ? `X509v3 Subject Alternative Name: \n    ${c.sans.map((s) => `DNS:${s}`).join(', ')}\n` : 'No extensions in certificate\n');
          }
          if (typeof opts.checkend === 'string') {
            const ok = c.notAfter > ctx.state.clock + Number(opts.checkend) * 1000;
            ctx.out(ok ? 'Certificate will not expire\n' : 'Certificate will expire\n');
            return ok ? 0 : 1;
          }
          if (!opts.noout) emit(opts.out as string | undefined, pem('cert', c));
          return 0;
        }
        case 'verify': {
          const extra = typeof opts.CAfile === 'string' ? read(opts.CAfile) : undefined;
          let code = 0;
          for (const f of pos) {
            const t = read(f);
            const [c] = unpem<Cert>('cert', t);
            const e = verifyCert(ctx.state, t, c?.sans[0] ?? '', extra);
            if (!e || e.reason === '__host__') ctx.out(`${f}: OK\n`);
            else {
              ctx.err(`${c ? fmtName(c.subject).replace(/ = /g, '=') : ''}\nerror ${e.ossl} at 0 depth lookup: ${e.reason}\nerror ${f}: verification failed\n`);
              code = 2;
            }
          }
          return code;
        }
        case 's_client': {
          const target = typeof opts.connect === 'string' ? opts.connect : '';
          const [host, portS] = target.split(':');
          const port = Number(portS ?? 443);
          const local = ['localhost', '127.0.0.1', ctx.state.hostname].includes(host) || (host && /\.local$/.test(host) && resolveLocal(ctx, host));
          const certPem = local ? servedCert(ctx.state, port) : undefined;
          if (!certPem) {
            ctx.err(`4057A7F7A27F0000:error:8000006F:system library:BIO_connect:Connection refused:../crypto/bio/bio_sock2.c:114:calling connect()\nconnect:errno=111\n`);
            return 1;
          }
          const c = unpem<Cert>('cert', certPem)[0];
          const name = typeof opts.servername === 'string' ? opts.servername : host;
          const e = verifyCert(ctx.state, certPem, name, typeof opts.CAfile === 'string' ? read(opts.CAfile) : undefined);
          const code = !e ? 0 : e.reason === '__host__' ? 0 : e.ossl;
          const reason = !e || e.reason === '__host__' ? 'ok' : e.reason;
          ctx.out(`CONNECTED(00000003)\n`);
          ctx.note(`depth=0 ${fmtName(c.subject)}\n${code ? `verify error:num=${code}:${reason}\n${code === 10 ? `notAfter=${osslDate(c.notAfter)}\n` : ''}` : 'verify return:1\n'}`);
          ctx.out(`---\nCertificate chain\n 0 s:${fmtName(c.subject)}\n   i:${fmtName(c.issuer)}\n   a:PKEY: rsaEncryption, 2048 (bit); sigalg: RSA-SHA256\n   v:NotBefore: ${osslDate(c.notBefore)}; NotAfter: ${osslDate(c.notAfter)}\n---\nServer certificate\n${opts.showcerts ? certPem : ''}subject=${fmtName(c.subject)}\nissuer=${fmtName(c.issuer)}\n---\nNo client certificate CA names sent\nPeer signing digest: SHA256\nPeer signature type: RSA-PSS\nServer Temp Key: X25519, 253 bits\n---\nSSL handshake has read 1462 bytes and written 393 bytes\nVerification${code ? ' error' : ''}: ${reason === 'ok' ? 'OK' : reason}\n---\nNew, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384\nServer public key is 2048 bit\nVerify return code: ${code} (${reason})\n---\nDONE\n`);
          return 0;
        }
      }
      ctx.err(`Invalid command '${sub ?? ''}'; type "help" for a list.\n(devquest simulates: version, genrsa, genpkey, rsa, pkey, req, x509, verify, s_client, md5, sha256)\n`);
      return 1;
    } catch (e) {
      if (e instanceof OsslError) {
        ctx.err(e.message + '\n');
        return 1;
      }
      throw e;
    }
  },
};

function resolveLocal(ctx: CommandContext, host: string): boolean {
  try {
    return new Vfs(ctx.state.fs, { name: 'root', groups: ['root'] }).readFile('/etc/hosts').split('\n').some((l) => /^127\./.test(l) && l.split(/\s+/).includes(host));
  } catch {
    return false;
  }
}

export const updateCaCertificates: CommandDef = {
  name: 'update-ca-certificates',
  summary: 'add the CAs in /usr/local/share/ca-certificates to the system trust store',
  run(ctx) {
    if (ctx.state.user !== 'root') {
      ctx.err('ln: failed to create symbolic link \'/etc/ssl/certs/ca-certificates.crt\': Permission denied\n');
      return 1;
    }
    const v = new Vfs(ctx.state.fs, { name: 'root', groups: ['root'] }, () => ctx.state.clock);
    let added = 0;
    v.mkdir('/etc/ssl/certs', { parents: true });
    try {
      for (const f of v.readdir('/usr/local/share/ca-certificates')) {
        if (!f.endsWith('.crt')) continue;
        const dst = `/etc/ssl/certs/${f.replace(/\.crt$/, '.pem')}`;
        if (!v.exists(dst)) added++;
        v.writeFile(dst, v.readFile(`/usr/local/share/ca-certificates/${f}`));
      }
    } catch {
      /* none */
    }
    ctx.out(`Updating certificates in /etc/ssl/certs...\n${added} added, 0 removed; done.\nRunning hooks in /etc/ca-certificates/update.d...\ndone.\n`);
    return 0;
  },
};
