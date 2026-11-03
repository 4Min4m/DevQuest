# Linux Process Management

**Parent:** [[000-MASTER-INDEX]]
**Related:** [[03-Linux/04-Performance-Debugging]], [[04-Containers/01-Docker-Fundamentals]]

---

## Processes and Signals

Every running program is a process with a PID. Processes communicate via signals.

| Signal | Number | Meaning |
|---|---|---|
| SIGTERM | 15 | Graceful shutdown request — process should clean up and exit |
| SIGKILL | 9 | Forceful kill — cannot be caught or ignored |
| SIGHUP | 1 | Hang up / reload config (many daemons use this) |
| SIGINT | 2 | Interrupt (Ctrl+C) |

**In Kubernetes:** When a Pod is terminated, K8s sends SIGTERM, waits `terminationGracePeriodSeconds` (default 30s), then SIGKILL. Your app must handle SIGTERM for graceful shutdown (finish in-flight requests, close DB connections).

```python
import signal, sys

def graceful_shutdown(sig, frame):
    print("Shutting down gracefully...")
    # finish work, close connections
    sys.exit(0)

signal.signal(signal.SIGTERM, graceful_shutdown)
```

---

## systemd

The init system on modern Linux (PID 1). Manages services, dependencies, logging.

```bash
systemctl status nginx
systemctl start / stop / restart / reload nginx
systemctl enable nginx      # Start on boot
systemctl disable nginx
journalctl -u nginx -f      # Follow logs for a unit
journalctl -u nginx --since "1 hour ago"
```

**Unit file example:**
```ini
[Unit]
Description=My App
After=network.target

[Service]
ExecStart=/usr/bin/myapp
Restart=always
User=myapp
Environment=PORT=8080

[Install]
WantedBy=multi-user.target
```

---

## Process Inspection

```bash
ps aux                    # All processes
ps aux | grep nginx       # Find specific process
pgrep nginx               # Get PIDs of matching processes
kill -15 <PID>            # SIGTERM
kill -9 <PID>             # SIGKILL (last resort)
lsof -p <PID>             # Files opened by process
lsof -i :8080             # What's listening on port 8080
```

---

## ulimits

Limits on resources per process:

```bash
ulimit -n           # Max open files (default 1024 — too low for servers)
ulimit -n 65536     # Increase for current session

# Permanently (in /etc/security/limits.conf):
nginx soft nofile 65536
nginx hard nofile 65536
```

**Why it matters:** A high-traffic server easily hits the default open files limit → connections fail. Always check and increase `nofile` limits for server processes.

---

## My Notes

> *Add your own insights here as you learn*

---
*Tags: #linux #processes #signals #systemd #interview-prep*
