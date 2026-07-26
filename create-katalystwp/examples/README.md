# Examples

Sample inputs for the scaffolder's setup flags. Point the `create-` command at
them from the repo root, or copy them next to your own project and adapt.

## Files

- **`breakdance-setup.sh`** — a `--setup-script`: runs inside the workspace
  container (as `node`, cwd `/home/node`, WordPress at `/home/node/wp`). It
  clones `soflyy/breakdance` and runs its installer against the site.
- **`breakdance-defines.json`** — a `--defines` file: a JSON object of
  `{ "WP_CONST": value }` pairs written into `wp-config.php` as constants
  (booleans/numbers become raw PHP literals; strings are quoted).
- **`breakdance-dev.sh`** — a `--dev-script`: runs in the long-lived `dev`
  container for as long as the stack is up (here, Breakdance's `npm run dev`
  watch task against the `/home/node/breakdance` checkout).

## Run it

```bash
npm create katalystwp@latest my-breakdance -- \
  --port=8090 \
  --setup-script=./examples/breakdance-setup.sh \
  --dev-script=./examples/breakdance-dev.sh \
  --defines=./examples/breakdance-defines.json \
  --activate=oxygen-elements,breakdance-elements,breakdance-main
```

Order of operations on first setup: install WordPress → write the `--defines`
constants → run the setup script (clone + Breakdance installer, which drops the
plugins into `wp-content`) → activate `oxygen-elements`, then
`breakdance-elements`, then `breakdance-main`, in that order. The dev script runs
in parallel in its own container the whole time (`npm run dev:logs` to watch it).

`soflyy/breakdance` is private, so `gh` needs auth in the workspace — run
`gh auth login` once inside (`npm run bash`), or export `GH_TOKEN` on your host
before setup (it's forwarded into the container).
