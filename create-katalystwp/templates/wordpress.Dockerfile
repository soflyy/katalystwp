FROM wordpress:latest

# Run Apache (and thus PHP) as uid/gid 1000 instead of root. The compose file
# sets APACHE_RUN_USER/GROUP to "#1000", but the stock image has no user/group
# with that id, so Apache can't resolve `User #1000` and silently stays root —
# which makes everything PHP writes at runtime (uploads, plugin logs, generated
# files) root-owned, and the workspace `node` user (also uid 1000) then can't
# read/edit them. Creating the id lets Apache drop to it, so the whole tree stays
# uid 1000 — consistent with the workspace and the bind-mounted host dir.
RUN groupadd -g 1000 devbox \
    && useradd -u 1000 -g 1000 -M -s /usr/sbin/nologin devbox
