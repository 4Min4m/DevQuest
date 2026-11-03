# Linux Filesystem & Storage

**Parent:** [[000-MASTER-INDEX]]
**Related:** [[03-Linux/01-Process-Management]], [[11-Storage-and-Databases/01-Storage-Types]]

---

## Filesystem Hierarchy

```
/           Root
├── bin     Essential binaries (ls, cp, bash)
├── etc     Configuration files
├── var     Variable data (logs: /var/log, databases: /var/lib)
├── tmp     Temporary files (cleared on reboot)
├── home    User home directories
├── proc    Virtual filesystem — kernel/process info
├── sys     Virtual filesystem — kernel/hardware
├── dev     Device files
├── mnt     Mount points (temporary)
└── opt     Optional third-party software
```

---

## inodes

Every file/directory is represented by an inode — stores metadata:
- File permissions, owner, timestamps
- Pointers to data blocks on disk

**Important:** Inode count is fixed at filesystem creation. You can run out of inodes before running out of disk space (common with millions of small files):

```bash
df -h        # Check disk space
df -i        # Check inode usage  ← also check this
```

---

## Permissions

```
-rw-r--r-- 1 user group 1234 Jan 1 12:00 file.txt
│├──┤├──┤├──┤
││  │  │  └── other: read only (4)
││  │  └───── group: read only (4)
││  └──────── owner: read+write (6)
│└─────────── type: - (file), d (dir), l (symlink)
```

```bash
chmod 755 file.sh     # rwxr-xr-x
chmod +x script.sh    # Add execute
chown user:group file
```

**Octal quick ref:** 4=read, 2=write, 1=execute. 7=rwx, 6=rw, 5=rx, 4=r

---

## Key Commands

```bash
# Disk usage
df -h                     # Filesystem usage
du -sh /var/log/*         # Size of each item
ncdu /                    # Interactive disk usage explorer

# Find files
find /var/log -name "*.log" -mtime +7   # Logs older than 7 days
find / -size +100M                       # Files larger than 100MB

# Mount
mount /dev/sdb1 /mnt/data
umount /mnt/data
lsblk                                    # List block devices
```

---

## My Notes

> *Add your own insights here as you learn*

---
*Tags: #linux #filesystem #permissions #storage #interview-prep*
