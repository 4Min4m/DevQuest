# Linux Networking Tools

**Parent:** [[000-MASTER-INDEX]]
**Related:** [[02-Networking/01-OSI-and-TCP-IP]], [[03-Linux/04-Performance-Debugging]]

---

## Essential Tools

### ss / netstat
Check open ports and connections:

```bash
ss -tlnp              # TCP listening ports with process
ss -tunp              # TCP+UDP, numeric, with process
ss -s                 # Summary stats

# Old way (still works, slower)
netstat -tlnp
```

### curl
Test HTTP endpoints:

```bash
curl -v https://api.example.com/health           # Verbose (see headers)
curl -I https://api.example.com                  # Headers only
curl -X POST -H "Content-Type: application/json" \
  -d '{"key":"value"}' https://api.example.com/endpoint
curl -o /dev/null -s -w "%{http_code}" https://api.example.com  # Just status code
curl --connect-timeout 5 --max-time 10 https://api.example.com  # With timeouts
```

### dig / nslookup
DNS lookups:

```bash
dig api.example.com          # Full DNS output
dig api.example.com A        # A record only
dig api.example.com +short   # Just the IP
dig @8.8.8.8 api.example.com # Use specific resolver
dig -x 1.2.3.4               # Reverse lookup (PTR record)
```

### tcpdump
Capture network packets:

```bash
tcpdump -i eth0 port 8080             # Capture on interface, filter port
tcpdump -i any host 10.0.1.5          # Traffic to/from an IP
tcpdump -i eth0 -w capture.pcap       # Save to file for Wireshark
tcpdump -i eth0 'tcp port 443 and host api.example.com'
```

### ping / traceroute
Connectivity testing:

```bash
ping -c 4 api.example.com             # 4 pings
traceroute api.example.com            # Hop-by-hop path
mtr api.example.com                   # Real-time traceroute (better)
```

---

## Troubleshooting Workflow

**"I can't reach the service":**
```bash
1. ping <host>                     # L3 reachable?
2. curl -v http://<host>:<port>    # L7 reachable?
3. ss -tlnp | grep <port>          # Is the service listening?
4. dig <host>                      # DNS resolving correctly?
5. iptables -L / nft list          # Any firewall rules blocking?
6. tcpdump -i any port <port>      # Is traffic arriving at all?
```

---

## My Notes

> *Add your own insights here as you learn*

---
*Tags: #linux #networking #curl #dig #tcpdump #troubleshooting #interview-prep*
