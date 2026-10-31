# Changelog

Each release's section below becomes its GitHub release notes. Versions follow
[semantic versioning](https://semver.org).

## 1.2.0 — 2026-10-31

- **Settings are only about the passphrase and the lock:** passphrase, idle minutes, lock
  on focus loss, and the private folder. The backup status, server fields, backup buttons,
  full-check interval and exclude list are gone from the settings. The backup is configured
  by the setup command and runs by itself; the server can still change its options through
  `_control/config.json`.
- The *Back up now*, *Reset backup index* and *Restore vault from server* commands are
  still in the command palette.

## 1.1.1 — 2026-10-29

- **Lock screen:** window titles stay "Obsidian" while locked, in the main window and in
  pop-out windows. Before, Obsidian could put the open note's name back in the title.
- **Lock screen:** the Settings window closes when the vault locks. Obsidian 1.14 opens
  Settings in its own window, which the lock overlay doesn't cover.
- The plugin's author is now listed as obsidian-lock.

## 1.1.0 — 2026-10-29

Zero-setup install: the only thing a user does is choose a passphrase.

- **Setup command for Windows:** [`install.ps1`](install.ps1) installs the plugin and BRAT
  into the vault, writes the server details, and turns both on. Safe to run again.
- **Passphrase prompt:** asked for on first start (and at every start until set). New
  *Set or change passphrase* command.
- **Backup is always on** once a server is set; the *Enable backup* switch is gone.
- **Simpler settings:** the passphrase and a live backup status. Everything else is under
  *Advanced*, and server fields apply together with *Save and test*.
- CI tests the setup command on Windows PowerShell 5.1.

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
