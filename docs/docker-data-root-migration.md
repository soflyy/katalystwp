# Runbook: move Docker + containerd storage to the block volume

Written 2026-09-20 for the prod droplet at `/root/dev/create-wp-local-dev-agent-sandbox`.
Tracks GitHub issue #84. **Executed 2026-09-26 — see the log at the bottom.**
Kept as the reference for a repeat on another box, and for the rollback and
the pending step 7 cleanup.

## Why

The root disk (`/dev/vda1`, 116 GB) holds every image layer and the build
cache under `/var/lib/containerd`; the 300 GB DigitalOcean block volume
(`/dev/sda`, mounted at `/mnt/volume_nyc1_1783631841059`) holds only env data.
The root disk hit 100 % on 2026-09-20 and env creates failed. After this
migration the root disk carries just the OS, and disk becomes "resize the
volume online" (DO volumes grow without downtime; `resize2fs` afterwards).

## Facts as of 2026-09-20

| Item | Value |
|---|---|
| Docker | 29.5.3, containerd image store (`Storage Driver: overlayfs`, `io.containerd.snapshotter.v1`) |
| containerd | containerd.io v2.2.4, system daemon, socket `/run/containerd/containerd.sock` |
| Docker root | `/var/lib/docker` (121 MB — metadata only) |
| containerd root | `/var/lib/containerd` (82 GB — all snapshots, images, build cache) |
| `/etc/docker/daemon.json` | only `default-address-pools` — **keep it** |
| `/etc/containerd/config.toml` | `disabled_plugins = ["cri"]` only — no `root` set |
| `docker.service` | `ExecStart=/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock`, `After=… containerd.service` |
| Block volume | `/mnt/volume_nyc1_1783631841059`, ext4, 298 GB, 133 GB free (needs > 82 GB) |
| fstab | line 4 mounts the volume by UUID; line 5 bind-mounts it onto `server/data` |
| Running | 58 containers (12 running envs) at time of writing |

New locations chosen: `/mnt/volume_nyc1_1783631841059/containerd` and
`/mnt/volume_nyc1_1783631841059/docker`.

## Downtime

Every env container (WordPress sites, workspaces, agent turns) is down from
step 3 to step 7. Copying 82 GB between two DO disks: budget 20–40 min. The
control server is stopped too so nothing tries to spawn turns or builds. Tell
any agents using the Katalyst MCP to stop first; interrupt running turns from
the UI or `POST /control/interrupt-all`.

## Steps

All as root. Each step is idempotent enough to re-run if it dies mid-way.

### 0. Pre-flight (no downtime)

```bash
V=/mnt/volume_nyc1_1783631841059
df -h / "$V"                                   # need: volume free > 82 GB + ~10 GB slack
du -xsh /var/lib/containerd /var/lib/docker    # what we'll copy
docker images -q | wc -l; docker ps -aq | wc -l  # note counts — compare after
mkdir -p "$V/containerd" "$V/docker"
# warm copy while everything runs (safe: rsync is read-only on the source)
rsync -aHAX --numeric-ids --info=progress2 /var/lib/containerd/ "$V/containerd/"
rsync -aHAX --numeric-ids --info=progress2 /var/lib/docker/     "$V/docker/"
```

The warm copy does the bulk of the transfer with no downtime; step 4 re-runs
rsync to pick up only what changed, so the outage is short.

### 1. Quiesce the control plane

```bash
systemctl stop devbox-server
# optional: confirm no agent turns are still alive in containers
docker ps --format '{{.Names}}' | grep -c workspace
```

### 2. Stop Docker and containerd

```bash
systemctl stop docker.socket docker.service
systemctl stop containerd.service
systemctl is-active docker containerd   # both "inactive"
```

Env containers stop here (compose `restart: unless-stopped` brings them back in step 6).

### 3. Final sync (delta only)

```bash
V=/mnt/volume_nyc1_1783631841059
rsync -aHAX --numeric-ids --delete --info=progress2 /var/lib/containerd/ "$V/containerd/"
rsync -aHAX --numeric-ids --delete --info=progress2 /var/lib/docker/     "$V/docker/"
```

### 4. Repoint both daemons

containerd — add a `root` line (file currently has only `disabled_plugins`):

```bash
cp /etc/containerd/config.toml /etc/containerd/config.toml.bak.pre-move
printf '\nroot = "%s/containerd"\n' "$V" >> /etc/containerd/config.toml
grep -n 'root\|version' /etc/containerd/config.toml
```

Docker — add `data-root`, keeping the existing address pools:

```bash
cp /etc/docker/daemon.json /etc/docker/daemon.json.bak.pre-move
python3 - "$V" <<'EOF'
import json,sys
p='/etc/docker/daemon.json'; d=json.load(open(p)); d['data-root']=sys.argv[1]+'/docker'
json.dump(d,open(p,'w'),indent=2); print(open(p).read())
EOF
```

Park the old dirs (do NOT delete yet — that's the rollback):

```bash
mv /var/lib/containerd /var/lib/containerd.old
mv /var/lib/docker     /var/lib/docker.old
```

### 5. Start and verify

```bash
systemctl start containerd.service
systemctl start docker.socket docker.service
docker info | grep -E 'Docker Root Dir|Storage Driver|containerd version'
#   Docker Root Dir must be $V/docker
docker images -q | wc -l; docker ps -aq | wc -l    # same counts as step 0
docker system df                                    # same totals as before
ls /var/lib/containerd 2>/dev/null || echo "old path empty — good"
```

If `docker info` still says `/var/lib/docker`, dockerd did not read
`daemon.json` — check `journalctl -u docker -n 50`.

### 6. Bring envs and the control server back

```bash
docker ps -q | wc -l          # restart: unless-stopped should have relaunched the 58
systemctl start devbox-server
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4001/health
```

Spot-check: open one env's site URL, then start a short Claude session on a
running env from the UI (`Reply with OK`). That exercises image lookup,
container exec, and the token path end to end.

### 7. Reclaim the root disk (only after a day of normal use)

```bash
rm -rf /var/lib/containerd.old /var/lib/docker.old
df -h /
```

## Rollback (any time before step 7)

```bash
systemctl stop devbox-server docker.socket docker.service containerd.service
cp /etc/containerd/config.toml.bak.pre-move /etc/containerd/config.toml
cp /etc/docker/daemon.json.bak.pre-move   /etc/docker/daemon.json
mv /var/lib/containerd.old /var/lib/containerd
mv /var/lib/docker.old     /var/lib/docker
systemctl start containerd docker.socket docker devbox-server
```

## Gotchas

- **Both roots must move together.** Docker's metadata (`/var/lib/docker`)
  references containerd snapshots by digest; moving only one leaves a store
  that does not match.
- **Keep `default-address-pools`** in `daemon.json` — envs' compose networks
  depend on it.
- **The bind mount in fstab line 5** (`server/data`) is untouched; images and
  env data now share the volume, so `GET /host` disk numbers finally describe
  the disk Docker uses. Issue #84 still asks to make health report it explicitly.
- **`rsync -X`** needs xattr support on the destination; ext4 has it. If rsync
  complains about `user.*` attrs, it is fine to drop `-X` — overlay snapshots
  here rely on `trusted.overlay.*` which `-X` as root does copy.
- **Do not `docker system prune -a`** to "make the copy smaller": it drops the
  image generations that stopped envs still need (10-minute rebuild each on start).
- **Growing later:** DO control panel → resize volume → `resize2fs /dev/sda`
  (online, no unmount).

## Execution log — 2026-09-26

Run by Claude with Louis's go-ahead, with all envs already stopped by Louis.

| Step | Result |
|---|---|
| 0 pre-flight | root 7.7 G free; volume 120 G free; 80 G in `/var/lib/containerd`, 126 M in `/var/lib/docker`; 201 images, 301 containers |
| 0 warm rsync | both dirs copied in ~6 min while daemons were up, exit 0 |
| 1–2 stop | devbox-server, docker.socket, docker, containerd all inactive |
| 3 delta rsync | exit 0 (nothing material changed) |
| 4 repoint | `root = "/mnt/volume_nyc1_1783631841059/containerd"` appended to `/etc/containerd/config.toml`; `"data-root": "/mnt/volume_nyc1_1783631841059/docker"` added to `/etc/docker/daemon.json` (address pools kept); backups `*.bak.pre-move` next to each; old dirs moved to `/var/lib/containerd.old` and `/var/lib/docker.old` |
| 5 verify | `docker info` → Docker Root Dir on the volume; 201 images / 301 containers (identical); `docker system df` totals identical; no dir recreated under the old paths |
| 5b cache probe | a throwaway `docker build` with a 200 MB RUN layer grew the volume's containerd dir by 579 MB and the root disk by 0 MB → **new images and build cache land on the volume** |
| 6 smoke | devbox-server up; swift-meadow-41d9 started via API; a `haiku@low` session returned `OK`; its site answered 200 over https |

Outage window (step 2 → step 6): ~4 minutes, because the warm copy had done the work.

**Pending — step 7 (reclaim root disk):** `/var/lib/containerd.old` (80 G) and
`/var/lib/docker.old` are still on the root disk as the rollback. After a day of
normal use: `rm -rf /var/lib/containerd.old /var/lib/docker.old` → root disk
drops from ~108 G used to ~28 G.

**Volume is now 87 % full (38 G free)** because it carries env data (~164 G)
plus the 80 G store. Resize it in the DO control panel, then `resize2fs /dev/sda`
online. The server's 10 GB `MIN_FREE_DISK_GB` guard now watches the right disk
for both env data and images.
