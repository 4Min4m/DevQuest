/** The packages `apt install` knows (Ubuntu 24.04 names and versions) and what installing them does. */
import type { BinarySpec } from '../systemd/types';

export interface PackageSpec {
  version: string;
  size: number;
  /** Packages pulled in with it. */
  deps?: string[];
  files?: Record<string, string>;
  binaries?: Record<string, BinarySpec>;
  /** systemd units: name → unit file (installed to /lib/systemd/system). */
  units?: Record<string, string>;
  /** Started and enabled on install, like Debian's postinst does. */
  start?: string[];
  summary: string;
}

const NGINX_DEFAULT = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
</body>
</html>
`;

const unit = (desc: string, exec: string, extra = '') => `[Unit]
Description=${desc}
After=network.target

[Service]
${extra}ExecStart=${exec}
Restart=on-failure

[Install]
WantedBy=multi-user.target
`;

export const PACKAGES: Record<string, PackageSpec> = {
  nginx: {
    version: '1.24.0-2ubuntu7.1',
    size: 552,
    deps: ['nginx-common'],
    summary: 'small, powerful, scalable web/proxy server',
    files: {
      '/etc/nginx/nginx.conf': 'user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents {\n\tworker_connections 768;\n}\n\nhttp {\n\tsendfile on;\n\tinclude /etc/nginx/mime.types;\n\taccess_log /var/log/nginx/access.log;\n\terror_log /var/log/nginx/error.log;\n\tinclude /etc/nginx/conf.d/*.conf;\n\tinclude /etc/nginx/sites-enabled/*;\n}\n',
      '/etc/nginx/sites-available/default': 'server {\n\tlisten 80 default_server;\n\tlisten [::]:80 default_server;\n\troot /var/www/html;\n\tindex index.html index.htm index.nginx-debian.html;\n\tserver_name _;\n\tlocation / {\n\t\ttry_files $uri $uri/ =404;\n\t}\n}\n',
      '/etc/nginx/sites-enabled/default': 'server {\n\tlisten 80 default_server;\n\troot /var/www/html;\n\tindex index.html index.htm index.nginx-debian.html;\n}\n',
      '/var/www/html/index.nginx-debian.html': NGINX_DEFAULT,
      '/var/log/nginx/access.log': '',
    },
    binaries: { '/usr/sbin/nginx': { name: 'nginx', listen: 80, staticRoot: '/var/www/html', server: 'nginx/1.24.0 (Ubuntu)', startLog: [] } },
    units: { 'nginx.service': unit('A high performance web server and a reverse proxy server', "/usr/sbin/nginx -g 'daemon off;'", 'Type=simple\n') },
    start: ['nginx.service'],
  },
  'nginx-common': { version: '1.24.0-2ubuntu7.1', size: 31, summary: 'small, powerful, scalable web/proxy server - common files', files: { '/etc/nginx/mime.types': 'types {\n    text/html html htm;\n    text/css css;\n}\n' } },
  apache2: {
    version: '2.4.58-1ubuntu8.5',
    size: 90,
    summary: 'Apache HTTP Server',
    files: { '/var/www/html/index.html': '<!DOCTYPE html>\n<html><head><title>Apache2 Ubuntu Default Page: It works</title></head><body><h1>It works!</h1></body></html>\n', '/etc/apache2/apache2.conf': 'ServerRoot "/etc/apache2"\nListen 80\n' },
    binaries: { '/usr/sbin/apache2': { name: 'apache2', listen: 80, staticRoot: '/var/www/html', server: 'Apache/2.4.58 (Ubuntu)' } },
    units: { 'apache2.service': unit('The Apache HTTP Server', '/usr/sbin/apache2 -DFOREGROUND') },
    start: ['apache2.service'],
  },
  'redis-server': {
    version: '5:7.0.15-1build2',
    size: 1170,
    summary: 'Persistent key-value database with network interface',
    files: { '/etc/redis/redis.conf': 'bind 127.0.0.1 -::1\nport 6379\n' },
    binaries: { '/usr/bin/redis-server': { name: 'redis-server', listen: 6379, startLog: ['Ready to accept connections tcp'] } },
    units: { 'redis-server.service': unit('Advanced key-value store', '/usr/bin/redis-server /etc/redis/redis.conf') },
    start: ['redis-server.service'],
  },
  postgresql: {
    version: '16+257build1.1',
    size: 4,
    summary: 'object-relational SQL database (supported version)',
    binaries: { '/usr/lib/postgresql/16/bin/postgres': { name: 'postgres', listen: 5432, startLog: ['database system is ready to accept connections'] } },
    units: { 'postgresql.service': unit('PostgreSQL RDBMS', '/usr/lib/postgresql/16/bin/postgres') },
    start: ['postgresql.service'],
  },
  htop: { version: '3.3.0-4build1', size: 171, summary: 'interactive processes viewer' },
  tree: { version: '2.1.1-2ubuntu3', size: 47, summary: 'displays an indented directory tree, in color' },
  git: { version: '1:2.43.0-1ubuntu7.1', size: 3680, summary: 'fast, scalable, distributed revision control system' },
  curl: { version: '8.5.0-2ubuntu10.4', size: 227, summary: 'command line tool for transferring data with URL syntax' },
  unzip: { version: '6.0-28ubuntu4', size: 174, summary: 'De-archiver for .zip files' },
  jq: { version: '1.7.1-3build1', size: 65, summary: 'lightweight and flexible command-line JSON processor' },
  ufw: { version: '0.36.2-6', size: 169, summary: 'program for managing a Netfilter firewall' },
  'python3-pip': { version: '24.0+dfsg-1ubuntu1', size: 1324, summary: 'Python package installer' },
  fail2ban: {
    version: '1.0.2-3ubuntu0.1',
    size: 409,
    summary: 'ban hosts that cause multiple authentication errors',
    files: { '/etc/fail2ban/jail.conf': '[sshd]\nenabled = true\n' },
    binaries: { '/usr/bin/fail2ban-server': { name: 'fail2ban-server' } },
    units: { 'fail2ban.service': unit('Fail2Ban Service', '/usr/bin/fail2ban-server -xf start') },
    start: ['fail2ban.service'],
  },
};

/** Installed on a fresh Ubuntu server image. */
export const BASE_PACKAGES: Record<string, string> = {
  bash: '5.2.21-2ubuntu4',
  coreutils: '9.4-3ubuntu6',
  curl: '8.5.0-2ubuntu10.4',
  'openssh-server': '1:9.6p1-3ubuntu13.5',
  openssl: '3.0.13-0ubuntu3.4',
  ufw: '0.36.2-6',
  python3: '3.12.3-0ubuntu2',
  sudo: '1.9.15p5-3ubuntu5',
  systemd: '255.4-1ubuntu8.4',
};
