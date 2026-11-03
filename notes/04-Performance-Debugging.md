# Linux Performance Debugging

**Parent:** [[000-MASTER-INDEX]]
**Related:** [[03-Linux/01-Process-Management]], [[09-Observability/01-Three-Pillars]]

---

## The USE Method (Brendan Gregg)

For every resource, check:
- **U**tilization — how busy is the resource? (%)
- **S**aturation — is work queuing up? (queue length)
- **E**rrors — are there errors?

Resources to check: CPU, memory, disk I/O, network I/O, each process.

---

## Essential Commands

### CPU
```bash
top / htop              # Live CPU per process
mpstat 1                # Per-CPU utilization every 1s
vmstat 1                # CPU, memory, I/O summary
pidstat -u 1            # CPU per process
```

### Memory
```bash
free -h                 # Total/used/available memory
cat /proc/meminfo       # Detailed memory stats
vmstat 1                # Memory + swap activity
```

**Free vs Available:** `free` shows unused memory. `available` includes memory that can be reclaimed from page cache — this is the real "free" number. Don't panic if `free` is low; `available` is what matters.

### Disk I/O
```bash
iostat -x 1             # Per-disk utilization, queue depth
iotop                   # I/O per process (like top for disk)
```

### Network
```bash
ss -tlnp                # Listening TCP sockets with process
ss -s                   # Summary stats
iftop                   # Network usage per connection
nethogs                 # Network usage per process
```

### Process-level debugging
```bash
strace -p <PID>         # System calls made by process
strace -c -p <PID>      # Count system calls (summary)
lsof -p <PID>           # Files/sockets open by process
```

---

## Interpreting Load Average

```bash
uptime
# 15:30:00 up 10 days,  load average: 1.5, 2.0, 1.8
#                                      1min  5min  15min
```

Load average = number of runnable (running or waiting for CPU) processes.

- On a **4-core** machine: load of 4.0 = fully utilized, no queuing
- Load > number of CPUs = saturation (processes waiting for CPU)
- Load of 1.5 on 4 cores = 37.5% utilized — fine

---

## Common Debugging Scenarios

**High CPU:**
1. `top` → find PID consuming CPU
2. `strace -p <PID>` → see what it's doing
3. `perf top` → see which functions are hot

**Memory leak:**
1. `watch -n1 'ps aux | grep myapp'` → watch RSS grow
2. `valgrind` or language-specific profiler

**High disk I/O:**
1. `iostat -x 1` → which disk, what utilization/queue
2. `iotop` → which process

**Port not listening:**
1. `ss -tlnp | grep 8080` → is the process listening?
2. `systemctl status myapp` → did it start? crash?

---

## My Notes

> *Add your own insights here as you learn*

---
*Tags: #linux #performance #debugging #monitoring #interview-prep*
