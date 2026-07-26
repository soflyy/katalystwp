# Moving environment storage onto a DigitalOcean Block Volume

The devbox host is a DigitalOcean **droplet**. Docker and every environment's
data live on the droplet's root disk (`/dev/vda1`). Environments are the bulk of
the growth: each scaffolded env keeps its WordPress tree, database, and
`node_modules` as **host bind mounts** under `server/data/envs/<name>/`. On a
busy box that directory is tens of gigabytes and climbing.

When the root disk gets tight you have two independent levers. They can be done
separately or together:

| Lever | Frees | Risk | Notes |
|-------|-------|------|-------|
| **A. Env data → volume** (`server/data`) | The big one — all env bind mounts (~tens of GB) | Low, *if* you keep the path identical (below) | **Recommended.** This is where the space actually goes. |
| **B. Docker images/cache → volume** (`/var/lib/docker`) | Image layers + build cache (usually 10–25 GB, fully rebuildable) | Low | Optional. Do it if images/cache alone are pushing you over. |

> **Nothing here deletes data.** Every step copies first, verifies, and keeps the
> original aside (`*.old`) until you remove it by hand. Absolute paths stored in
> `registry.json` / `sessions.json` are preserved by mounting the volume back at
> the **same path** (see "Why the same path" below).

---

## 0. Create and attach the volume (DigitalOcean)

1. **Control panel → Volumes → Create Volume.** Same region/datacenter as the
   droplet (a volume can only attach to a droplet in its own region). Size it for
   growth — the env dir is ~73 GB today, so 150–250 GB buys real headroom. DO
   volumes can be resized larger later.
2. Attach it to the droplet. It appears as a new block device — typically
   `/dev/sda` (and a stable alias under `/dev/disk/by-id/scsi-0DO_Volume_<name>`).
   Confirm with `lsblk` — it's the new disk with no partitions and no mountpoint.

A freshly attached DO volume does **not** auto-expand `/`. It's a separate disk
you format and mount. (If instead you just want a bigger root disk with no
mounting at all, resizing the *droplet* — which grows `/dev/vda1` directly — is
the simplest option, but it's pricier per GB and caps lower than volumes.)

### Format and mount it

DO's console gives you the exact commands per-volume; they amount to:

```bash
VOL=/dev/disk/by-id/scsi-0DO_Volume_<your-volume-name>   # stable alias from `ls -l /dev/disk/by-id/`
sudo mkfs.ext4 -F "$VOL"                                  # ONLY on a brand-new, empty volume
sudo mkdir -p /mnt/devbox_data
sudo mount -o discard,defaults "$VOL" /mnt/devbox_data

# Persist across reboots (use the by-id path, not /dev/sda which can renumber):
echo "$VOL /mnt/devbox_data ext4 defaults,nofail,discard 0 0" | sudo tee -a /etc/fstab
```

Verify: `findmnt /mnt/devbox_data` shows it mounted on the new device.

---

## A. Move env data onto the volume (recommended)

### Why the same path

`registry.json` stores each env's **absolute** directory (`dir`,
`setupLogPath`), and `sessions.json` stores each session's absolute
`eventLogPath`. The server uses `env.dir` as the working directory for every
`docker compose` call. If you moved the data and *changed* the path, all those
stored absolute paths would point at nothing.

So we don't change the path. We move the *bytes* to the volume and then mount the
volume **back onto the original `server/data` path** with a bind mount. Every
stored path stays valid; only the underlying storage changed. (The per-env
compose files use **relative** bind paths like `./db`, so they keep working as
long as each env dir moves as a whole — which it does.)

### Do it with the helper (recommended)

`scripts/move-data-to-volume.sh` performs exactly this, defaulting to a **dry
run** that changes nothing and just prints the plan:

```bash
# 1. Dry run — prints the plan, verifies preflight, touches nothing:
sudo bash scripts/move-data-to-volume.sh --volume /mnt/devbox_data

# 2. When the plan looks right, apply it:
sudo bash scripts/move-data-to-volume.sh --volume /mnt/devbox_data --apply
```

**How long / how to tell it's working.** Copying is dominated by *file count*, not
size — an env is ~90k small files (node_modules + WP core). Measured rate on this
box: ~3 GB / 90k files in ~19 s, so **~75 GB ≈ 10–15 min** of downtime (plan for
20). The copy step streams a live `rsync --info=progress2` line (% done, speed,
ETA). The verify step then re-scans every file on both sides and stays quiet for a
minute or two — the script prints a dot every 10 s there so it never looks hung.
To watch from a second SSH session: `watch df -h <volume>` (used space climbing)
or `du -sh <volume>`.

What `--apply` does, in order:

1. Stops the `devbox-server` service and any env containers whose bind mounts
   live under the data dir (so nothing is writing to the files mid-copy — this is
   what keeps databases consistent).
2. `rsync -aHAX --numeric-ids` the data dir onto the volume (preserves
   permissions, hardlinks, ACLs, xattrs, and does **not** delete the source).
3. Verifies the copy — file count and byte totals must match.
4. Renames the original to `server/data.old`, recreates `server/data` as an empty
   dir, and adds an `/etc/fstab` **bind mount** from the volume path onto it, then
   mounts it.
5. Restarts `devbox-server` and checks `/host` reports the same environment count.
6. Leaves `server/data.old` in place and prints how to reclaim it once you're
   confident.

### Verify, then reclaim

- In the UI, open a couple of environments and confirm their sites load and the
  session transcripts are intact.
- `df -h /` should show the ~70 GB freed *after* you remove the old copy.
- When satisfied: `sudo rm -rf /root/dev/create-katalystwp/server/data.old`

### Rollback (if `/host` looks wrong before you delete `.old`)

```bash
sudo systemctl stop devbox-server
sudo umount /root/dev/create-katalystwp/server/data
sudo rmdir  /root/dev/create-katalystwp/server/data
sudo sed -i '\# /root/dev/create-katalystwp/server/data #d' /etc/fstab   # remove the bind line
sudo mv /root/dev/create-katalystwp/server/data.old \
        /root/dev/create-katalystwp/server/data
sudo systemctl start devbox-server
```

Nothing was deleted, so rollback restores the exact original.

---

## B. (Optional) Move Docker's data-root onto the volume

If image layers + build cache are what's filling the disk, relocate Docker's
storage. This is pure infrastructure — it touches no env or session data, and
anything lost here just rebuilds.

```bash
sudo systemctl stop devbox-server
sudo systemctl stop docker docker.socket
sudo rsync -aHAX /var/lib/docker/ /mnt/devbox_data/docker/     # or a second volume
# Point the daemon at the new location:
#   /etc/docker/daemon.json  ->  { "data-root": "/mnt/devbox_data/docker" }
sudo systemctl start docker
sudo systemctl start devbox-server
docker info | grep -i 'docker root dir'                        # confirm new path
# Once verified: sudo rm -rf /var/lib/docker.old   (after moving the old aside)
```

> Don't put **both** env data and Docker's data-root on the *same* volume without
> checking the volume is big enough for both plus growth. Two volumes (or a
> generously sized single one) is cleaner.

---

## The disk guard

The server refuses new env creates and warm-pool builds when free space on the
data filesystem drops below `MIN_FREE_DISK_GB` (default 10). After moving env
data to the volume, the guard measures the **volume's** free space (it stats the
data dir), which is exactly what you want. Raise the floor once you have room:

```bash
# in server/.env
MIN_FREE_DISK_GB=20
```

Then `sudo systemctl restart devbox-server`.
