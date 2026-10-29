# Vault Lock & Backup — Obsidian plugin

Personal plugin for a single Windows laptop and a VPS. Four things:

1. **Lock screen.** Passphrase overlay at launch, after N idle minutes, and on the command
   *Lock vault now*. While locked, hotkeys and the command palette are dead and nothing
   underneath is painted.
2. **Private folder.** `Private/` is renamed to `.Private/` (plus the Windows hidden attribute)
   while locked. Obsidian ignores dot-folders completely: explorer, search, graph, quick
   switcher. Nothing is encrypted — this is a privacy screen, not a safe. BitLocker is what
   protects a lost laptop.
3. **One-way backup.** Every file in the vault (including `.obsidian/`, minus the excludes) is
   pushed to a WebDAV folder on the server as plain files. Nothing is ever deleted on the
   server: files you delete or rename away are moved into `_trash/<timestamp>/`. The server
   always sees the private folder as `Private/`.
4. **Server-side control.** The server can change the plugin's settings, send it commands,
   repair or restore the vault, and see its health — by editing JSON files in `_control/`.

How the backup stays reliable: there is exactly one mechanism, a *reconcile* that compares
every local file (mtime + size) against an index on the server (`_manifest.json`) and uploads
whatever differs. It runs at startup, every N minutes, when the laptop comes back online, and
one minute after any failure. Live file events only make the same thing happen sooner. Errors
show in the status bar (`Backup: ⚠ retrying`), never silently.

Limit, true of every plugin: nothing uploads while Obsidian is closed. The startup reconcile
catches up.

---

## 1. Server (VPS)

```
mkdir -p /opt/obsidian-webdav && cd /opt/obsidian-webdav
# copy server/docker-compose.yml and server/config.yml here
docker run --rm ghcr.io/hacdias/webdav:latest bcrypt 'YOUR-PASSWORD'   # paste result into config.yml
# edit docker-compose.yml: set the edge-caddy network name
docker compose up -d
```

Add `server/Caddyfile.snippet` to edge-caddy and reload it. Check:
`curl -u obsidian:YOUR-PASSWORD -X PROPFIND https://vault.815431624.xyz/` returns XML, not 401.

The vault lands in `/opt/obsidian-webdav/data/`. Recommended: a nightly snapshot of `data/`
to somewhere off the VPS (restic, or `tar czf /backups/vault-$(date +%F).tgz data`).

## 2. Plugin (laptop), via BRAT

1. Settings → Community plugins → Browse → install **BRAT** → enable it.
2. Open this link: `obsidian://brat?plugin=obsidian-lock/vault-lock-backup`
   (or BRAT settings → *Add beta plugin* → `obsidian-lock/vault-lock-backup`).
3. Settings → **Vault Lock & Backup**:
   - set a passphrase;
   - *Private folder*: default `Private`; create it and move private notes in;
   - *Backup*: URL `https://vault.815431624.xyz/`, user `obsidian`, the password →
     **Test** → **Back up now**. Status bar shows `Backup: syncing…` then `Backup: ✓ HH:MM`.

BRAT checks for a newer release one minute after every Obsidian start and installs it.

### Commands (Ctrl+P)

- **Lock vault now**
- **Back up now** — full reconcile immediately
- **Reset backup index** — forget `_manifest.json`, re-upload everything
- **Restore vault from server** — download every indexed file that is missing or differs
  locally (new laptop, or repair). Overwritten local versions are parked in `_trash/` first.

## 3. Controlling the plugin from the server

Everything is in `data/_control/`. The plugin reads it at every reconcile (default: every
10 minutes and at startup) and writes `status.json` afterwards.

**`config.json`** — any subset; the server's value wins and is saved on the laptop:
```json
{ "idleMinutes": 5, "lockOnBlur": false, "reconcileMinutes": 10,
  "excludes": [".trash/", ".obsidian/workspace"] }
```

**`commands.json`** — a list; each `id` runs once, ever, and is acknowledged in `status.json`.
To run something again, add it with a new id.
```json
[
  { "id": "2026-10-29-a", "cmd": "reconcile" },
  { "id": "2026-10-29-b", "cmd": "reset-index" },
  { "id": "2026-10-29-c", "cmd": "lock" },
  { "id": "2026-10-29-d", "cmd": "pull", "paths": ["Notes/todo.md", "Projects"] },
  { "id": "2026-10-29-e", "cmd": "restore-all" }
]
```
- `pull` writes the server's copy of those files/folders into the vault, unconditionally.
  Use it after editing files in `data/` on the server (e.g. with Claude Code). The local
  version is parked in `_trash/` first, so nothing is lost on either side.
- `restore-all` writes every indexed file that is missing or differs locally.
- `lock` needs a passphrase to be set.

**`status.json`** — written by the plugin:
```json
{ "at": "…", "version": "1.0.0", "locked": false,
  "lastReconcile": { "reason": "interval", "files": 812, "uploaded": 3, "trashed": 0 },
  "lastError": null, "settings": { … }, "commands": { "2026-10-29-d": { "ok": true, "at": "…", "detail": "4 files written" } } }
```
A cron on the VPS can alert (Matrix, email) when `at` is older than a day.

**Updating the plugin from the server:** bump `version` in `manifest.json`, commit, then
`git tag <version> && git push origin main --tags`. GitHub Actions builds and publishes the
release; BRAT installs it at the next Obsidian start.

## Notes

- Lost passphrase: delete `.obsidian\plugins\vault-lock-backup\data.json` (you lose the WebDAV
  settings too) and rename `.Private` back to `Private`. This also means the lock is only a
  screen; anyone with file access can do the same.
- The WebDAV password is stored in that `data.json`. That file is never uploaded.
- Files over 100 MB are skipped with a notice.
- Default excludes: `.trash/` and `.obsidian/workspace*`.
- Don't put the vault inside a OneDrive/iCloud-synced folder: two sync engines fighting over
  the `Private` ↔ `.Private` rename is the one thing that can corrupt this setup.
- If both `Private` and `.Private` exist (only possible by hand), the plugin refuses to rename
  and tells you; merge them manually.

## Building from source

```
npm install
npm run check   # type-check
npm run build   # -> main.js
```
