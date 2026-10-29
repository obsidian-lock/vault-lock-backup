# Changelog

Each release's section below becomes its GitHub release notes. Versions follow
[semantic versioning](https://semver.org).

## 1.0.0 — 2026-10-29

First release.

- **Lock screen:** passphrase overlay at launch, after N idle minutes, when the window loses
  focus (optional), and on the *Lock vault now* command. Hotkeys and the command palette are
  blocked while locked. The passphrase is stored only as a PBKDF2-SHA256 hash.
- **Private folder:** a top-level folder (default `Private`) is renamed to a dot-folder while
  locked, so Obsidian ignores it, and on Windows it also gets the hidden attribute.
- **One-way WebDAV backup:** the whole vault as plain files, kept correct by a single
  reconcile against a server-side index. Deleted and renamed-away files go to
  `_trash/<timestamp>/`; nothing on the server is ever deleted. Includes *Reset backup
  index* and *Restore vault from server*.
- **Server-side control:** `_control/config.json` (settings overrides),
  `_control/commands.json` (`reconcile`, `reset-index`, `lock`, `pull`, `restore-all`) and
  `_control/status.json` (health report).
