# Contributing

Notes for working on the scaffolder itself. (End-user usage lives in the
[README](README.md).)

This package lives in the `create-katalystwp/` directory of the
[soflyy/katalystwp](https://github.com/soflyy/katalystwp) monorepo — all
commands below run from that directory unless noted.

## Developing this scaffolder

The two things you edit:

- **`index.js`** — the CLI logic (arg parsing, file copying, substitutions)
- **`templates/`** — the files that get scaffolded (compose file, Dockerfile, the project's `package.json` scripts, etc.)

By default the scaffolder also runs `npm run setup` in the generated project (docker compose up + WordPress/plugin install). Use `--scaffold-only` to just generate files — then it creates no `wp/`/`db/`/`workspace/` data, which only appears once Docker runs inside a *generated* project.

### Test a change end to end

```bash
cd <this-repo>/create-katalystwp

# 1. Scaffold into a throwaway dir (use a port that won't clash with other instances)
#    Drop --scaffold-only to also build + boot + install in one go (Docker must be running).
node index.js /tmp/try-it --port=8090 --scaffold-only

# 2. Inspect the generated config files
ls /tmp/try-it

# 3. Boot + provision it (Docker must be running)
cd /tmp/try-it
npm run setup            # up -d --build, then installs WordPress + plugins
#   → open http://localhost:8090 and log in at /wp-admin with admin / password
#     (default; configurable via WP_ADMIN_USER / WP_ADMIN_PASSWORD in .env)
#   (after the first run, `npm run start` is all you need)

# 4. Get into the workspace container to test it (lands you in /wp)
npm run bash
#     inside the container, e.g.:
#       wp plugin list          # WP-CLI talks to the DB over the network
#       claude --version        # Claude Code is installed
#       cursor-agent --version  # Cursor CLI is installed
#       php -v
#     type `exit` to leave
npm run claude           # or launch Claude Code directly
npm run cursor           # or launch the Cursor CLI agent directly

# 5. Useful while testing
npm run logs             # tail all service logs
npm run ps               # container status

# 6. Tear down — STOP CONTAINERS FIRST, then delete the dir
npm run down             # stop + remove containers (releases the bind-mounted folders)
cd ~
rm -rf /tmp/try-it       # now safe to delete (incl. the db/ wp/ workspace/ data)
```

> **Step 6 order matters:** always `npm run down` *before* `rm -rf`. Deleting the `db/`/`wp/` folders out from under running containers can corrupt the database. Stop first, then delete.

> **No clash with other instances:** Compose names containers after the directory, so `/tmp/try-it` gets its own `try-it-*` containers. Just keep the **port different** so multiple instances can run at once.

To exercise the real `bin` entry (not just the file), use `npm link`:

```bash
npm link
create-katalystwp /tmp/try-it
npm unlink -g create-katalystwp   # when done
```

## Releasing a new version

Releases are published to npm **automatically by GitHub Actions** when a GitHub
Release is published — see [`.github/workflows/publish.yml`](.github/workflows/publish.yml).
Auth is npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC),
so there are no tokens in the repo and the package ships with build provenance.

**Do not run `npm publish` locally.** To cut a release, from a clean `master`,
in `create-katalystwp/` (`npm version` works from the subdirectory — the commit
and tag land on the repo as usual):

```bash
cd create-katalystwp
npm version patch          # or `minor` / `major` — bumps package.json, commits, and tags vX.Y.Z
git push --follow-tags     # push the commit and the new tag
gh release create "v$(node -p "require('./package.json').version")" --generate-notes
```

Publishing the GitHub Release triggers the workflow, which publishes the version
currently in `package.json` to npm. Watch it with `gh run watch`.

> One-time account setup: the package's **Trusted Publisher** on npmjs.com must
> point at this repo (`soflyy/katalystwp`) and `.github/workflows/publish.yml`.
> The very first publish of a new package name must be done manually
> (`npm publish` from `create-katalystwp/`) to create it — after that, Trusted
> Publishing takes over.
