# Vault Lock & Backup

[![Latest release](https://img.shields.io/github/v/release/obsidian-lock/vault-lock-backup?sort=semver&label=release)](https://github.com/obsidian-lock/vault-lock-backup/releases/latest)
[![CI](https://github.com/obsidian-lock/vault-lock-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/obsidian-lock/vault-lock-backup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/obsidian-lock/vault-lock-backup)](LICENSE)
![Obsidian 1.5+ desktop](https://img.shields.io/badge/Obsidian-1.5%2B%20desktop-7c3aed?logo=obsidian&logoColor=white)

An Obsidian plugin for one person, one computer, and a server you control:

- **Lock screen.** A passphrase overlay at launch, after a few idle minutes, or on demand.
- **Private folder.** One folder disappears from Obsidian whenever the vault is locked.
- **One-way backup.** Every file in the vault is copied to your own WebDAV server as plain
  files. Nothing on the server is ever deleted.
- **Server-side control.** The server can change settings, send commands, and read the
  plugin's health by editing a few JSON files next to the backup. Nothing connects in to
  your computer.

> [!IMPORTANT]
> This is a **privacy screen, not a safe.** Nothing is encrypted. Anyone with access to the
> vault's files can read them, private folder included. Use full-disk encryption
> (BitLocker, FileVault, LUKS) to protect a lost or stolen laptop. See
> [Security model](#security-model).

## Contents

- [Design principles](#design-principles)
- [Install](#install)
- [Set up](#set-up)
- [Commands](#commands)
- [How the backup works](#how-the-backup-works)
- [Server setup](#server-setup)
- [Controlling the plugin from the server](#controlling-the-plugin-from-the-server)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Building and releasing](#building-and-releasing)

## Design principles

- **Never lose data.** The server never deletes anything. Files you delete or rename away
  are moved into `_trash/<timestamp>/`. A restore parks the local copy in `_trash/` before
  overwriting it.
- **One mechanism.** Backup reliability comes from a single *reconcile* that compares every
  local file with an index on the server and uploads whatever differs. Live file events
  only make it happen sooner, so a missed event can never cause a missed file.
- **Plain files.** The backup is your vault as ordinary files. No database and no
  proprietary format, so you can read or restore it with any tool.
- **Failures are visible.** Errors show in the status bar and retry on their own. Nothing
  fails silently.

## Install

The plugin is not in the Obsidian community catalogue. Install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat), which also keeps it up to date.

1. *Settings → Community plugins → Browse*, install **BRAT** and enable it.
2. Open this link in your browser. Obsidian will ask BRAT to add the plugin:
   ```
   obsidian://brat?plugin=obsidian-lock/vault-lock-backup
   ```
   Or go to *BRAT settings → Add beta plugin* and enter `obsidian-lock/vault-lock-backup`.
3. Enable **Vault Lock & Backup** under *Settings → Community plugins*.

BRAT checks for a newer release shortly after every Obsidian start and installs it.

**Manual install:** download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/obsidian-lock/vault-lock-backup/releases/latest) into
`<vault>/.obsidian/plugins/vault-lock-backup/`, then enable the plugin.

Desktop only (Windows, macOS, Linux). Obsidian 1.5.0 or newer.

## Set up

Open *Settings → Vault Lock & Backup*.

**Lock**

1. **Set passphrase.** At least 4 characters. Until one is set, the vault never locks and
   the private folder is always visible.
2. **Lock after idle (minutes).** Default 5. `0` turns the idle lock off.
3. **Lock when the window loses focus.** Off by default.
4. **Private folder.** Default `Private`, a top-level folder. Create it and move private
   notes into it. Change the name only while unlocked.

**Backup**

1. Turn on **Enable backup**.
2. **WebDAV URL**: the folder URL on your server, for example `https://vault.example.com/`.
3. **Username** and **Password** for that server.
4. Press **Test**. You should see *Connected (empty backup folder)*.
5. Press **Back up now**. The status bar shows `Backup: syncing…`, then `Backup: ✓ HH:MM`.

Optional: **Full check every (minutes)** (default 10) and **Exclude**, one path prefix per
line (default `.trash/` and `.obsidian/workspace`).

## Commands

Open the command palette (Ctrl/Cmd+P):

| Command | What it does |
| --- | --- |
| **Lock vault now** | Locks immediately. Needs a passphrase. |
| **Back up now** | Runs a full reconcile right away. |
| **Reset backup index** | Forgets the server index and re-uploads every file. |
| **Restore vault from server** | Downloads every indexed file that is missing or different locally. Use it for a new computer or a repair. Local copies it overwrites go to `_trash/` on the server first. |

## How the backup works

The reconcile lists every local file (modification time and size) and compares it with
`_manifest.json` on the server. It uploads whatever is new or changed. Anything in the index
that no longer exists locally is moved to `_trash/`. It runs:

- 8 seconds after Obsidian starts,
- every *N* minutes (default 10),
- when the computer comes back online,
- one minute after any failure, until it succeeds.

Edits, renames and deletes are also sent within a couple of seconds as they happen. The
reconcile is the safety net that catches anything those miss.

What the server folder looks like:

```
<WebDAV folder>/
├── Notes/…, Private/…           your vault as plain files, including .obsidian/
├── _manifest.json               index: path → modification time + size
├── _trash/<timestamp>/…         deleted, renamed-away, or overwritten files
└── _control/
    ├── config.json              you write: settings overrides
    ├── commands.json            you write: one-shot commands
    └── status.json              the plugin writes: health, last run, command results
```

Details:

- The private folder is always stored as `Private/` on the server, even while it is hidden
  locally as `.Private/`.
- Always skipped: the plugin's own `data.json` (it holds your passphrase hash and WebDAV
  password), files over 100 MB (with a notice), and top-level `_manifest.json`, `_trash/`
  and `_control/` in the vault, because those names are reserved on the server.
- Status bar: `Backup: off`, `Backup: syncing…`, `Backup: ✓ 14:05`, or `Backup: ⚠ retrying`.
- Nothing uploads while Obsidian is closed. The reconcile at the next start catches up.

## Server setup

Any WebDAV server works. The [`server/`](server) folder has a tested setup:
[hacdias/webdav](https://github.com/hacdias/webdav) in Docker behind
[Caddy](https://caddyserver.com), which provides HTTPS automatically.

```sh
mkdir -p /opt/obsidian-webdav && cd /opt/obsidian-webdav
# copy server/docker-compose.yml and server/config.yml here
docker run --rm ghcr.io/hacdias/webdav:latest bcrypt 'YOUR-PASSWORD'   # paste the hash into config.yml
# docker-compose.yml: set the Docker network your reverse proxy is on
docker compose up -d
```

1. Point a DNS name (for example `vault.example.com`) at the server.
2. Add [`server/Caddyfile.snippet`](server/Caddyfile.snippet) to your Caddyfile and reload
   Caddy. If you use another reverse proxy, **don't rewrite the `Host` header**: WebDAV
   `MOVE` compares it with the destination URL.
3. Check it. This should print XML, not `401`:
   ```sh
   curl -u obsidian:YOUR-PASSWORD -X PROPFIND https://vault.example.com/
   ```

The vault lands in `/opt/obsidian-webdav/data/`. Take a nightly snapshot of that folder to
somewhere off the server, for example with restic or
`tar czf /backups/vault-$(date +%F).tgz data`.

## Controlling the plugin from the server

Everything happens in `_control/` inside the backup folder. The plugin reads it at the
start of every reconcile (at startup and every 10 minutes by default) and writes
`status.json` afterwards.

**`config.json`**: any subset of these. The server's value wins and is saved on the
computer.

```json
{ "idleMinutes": 5, "lockOnBlur": false, "reconcileMinutes": 10,
  "excludes": [".trash/", ".obsidian/workspace"] }
```

**`commands.json`**: a list. Each `id` runs once, ever, and its result is reported in
`status.json`. To run something again, add it with a new id.

```json
[
  { "id": "2026-10-29-a", "cmd": "reconcile" },
  { "id": "2026-10-29-b", "cmd": "reset-index" },
  { "id": "2026-10-29-c", "cmd": "lock" },
  { "id": "2026-10-29-d", "cmd": "pull", "paths": ["Notes/todo.md", "Projects"] },
  { "id": "2026-10-29-e", "cmd": "restore-all" }
]
```

| Command | Effect |
| --- | --- |
| `reconcile` | Does nothing extra. Commands are read at the start of a reconcile, so this only confirms the channel works. |
| `reset-index` | Forgets the index; every file is re-uploaded. |
| `lock` | Locks the vault. Fails if no passphrase is set. |
| `pull` | Writes the server's copy of the listed files or folders into the vault, unconditionally. Use it after editing files directly on the server. |
| `restore-all` | Writes every indexed file that is missing or different locally. |

`pull` and `restore-all` upload the local version to `_trash/` before overwriting it, so
nothing is lost on either side.

**`status.json`**: written by the plugin.

```json
{ "at": "2026-10-29T18:00:00.000Z", "version": "1.0.0", "locked": false,
  "lastReconcile": { "reason": "interval", "files": 812, "uploaded": 3, "trashed": 0 },
  "lastError": null, "settings": { "idleMinutes": 5, "…": "…" },
  "commands": { "2026-10-29-d": { "ok": true, "at": "…", "detail": "4 files written" } } }
```

A cron job on the server can alert you when `at` is older than a day, which means the
computer has stopped backing up.

## Security model

**What it does**

- The passphrase is never stored. Only a PBKDF2-SHA256 hash (200,000 iterations, random
  salt) is kept in the plugin's `data.json`.
- Each wrong passphrase adds a growing delay, up to 5 seconds.
- While locked, an overlay covers the whole window. Hotkeys and the command palette don't
  work, and the window title shows only "Obsidian".
- On lock, tabs showing private notes are closed and the private folder is renamed to a
  dot-folder (`Private/` → `.Private/`). Obsidian ignores dot-folders completely: file
  explorer, search, graph and quick switcher. On Windows the folder also gets the hidden
  attribute.
- If Obsidian crashes while unlocked, the folder is hidden again and the vault locks at
  the next start, before the interface appears.

**What it does not do**

- **No encryption.** Notes, including the private folder, are plain files on disk and on the
  server. Anyone who can open the files, or delete the plugin's `data.json`, gets past the
  lock.
- The WebDAV password is stored in plain text in `data.json`. That file is never uploaded.
- **Whoever can write to the WebDAV folder controls the plugin.** They can change its
  settings and use `pull` to overwrite notes. Local versions go to `_trash/` first, but
  treat the WebDAV credentials as carefully as the vault itself. Serve the folder over
  HTTPS only.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Troubleshooting

- **Lost passphrase.** Close Obsidian. Delete
  `<vault>/.obsidian/plugins/vault-lock-backup/data.json`, which also removes the WebDAV
  settings, and rename `.Private` back to `Private`.
- **"Both Private and .Private exist".** This only happens if folders are created by hand.
  The plugin refuses to rename either one. Merge them manually.
- **Don't keep the vault in OneDrive, iCloud Drive or Dropbox.** A second sync engine
  fighting over the `Private` ↔ `.Private` rename is the one thing that can corrupt this
  setup.
- **`Backup: ⚠ retrying`.** The notice shows the error, and the plugin retries every minute.
  Run *Test* in settings to check the URL and credentials.
- **Test fails right after you create a new DNS name.** Your computer may have cached the
  old "not found" answer. Flush it (`ipconfig /flushdns` on Windows) or wait a few minutes.

## Building and releasing

```sh
npm ci
npm run check   # type-check
npm run build   # -> main.js
```

To release: bump `version` in `manifest.json` (and `package.json`) and add a section to
[CHANGELOG.md](CHANGELOG.md). Then commit, tag with the same version and push:

```sh
git tag 1.0.1 && git push origin main 1.0.1
```

GitHub Actions builds `main.js` and publishes the release with notes from the changelog.
BRAT installs it on the next Obsidian start.

## License

[MIT](LICENSE)
