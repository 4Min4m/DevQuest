/** The simulated network around the machine: interfaces, DNS data and remote hosts. */

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'PTR';

export interface DnsRecord {
  /** Fully qualified, without the trailing dot. */
  name: string;
  type: RecordType;
  value: string;
  ttl: number;
}

export type RemoteService = { kind: 'http'; status?: number; body: string; headers?: Record<string, string> } | { kind: 'tcp' };

export interface RemoteHost {
  ip: string;
  /** Reverse-DNS / display name. */
  name?: string;
  /** Down hosts don't answer at all (ping loss, connect timeouts). */
  up: boolean;
  /** Round-trip time in ms. */
  latency: number;
  /** Intermediate hops for traceroute (IP or "name (ip)"); '*' for a silent hop. */
  hops?: string[];
  /** Open ports. Closed ports refuse connections. */
  services: Record<number, RemoteService>;
}

export interface NetState {
  interfaces: { name: string; ip: string; prefix: number; mac?: string }[];
  gateway: string;
  /** Nameservers from /etc/resolv.conf (127.0.0.53 = systemd-resolved stub). */
  resolver: string;
  /** Reachable nameservers (for `dig @server`). */
  nameservers: string[];
  records: DnsRecord[];
  remotes: RemoteHost[];
}
