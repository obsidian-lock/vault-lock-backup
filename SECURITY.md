# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/obsidian-lock/vault-lock-backup/security/advisories/new),
not in a public issue.

Only the latest release is supported. Fixes ship as a new release, which BRAT installs
automatically.

## What counts as a vulnerability

The plugin's limits are documented in the README's
[Security model](README.md#security-model). In short, it is a privacy screen and makes no
encryption claims. These are known and by design:

- notes, including the private folder, are readable by anyone with access to the files;
- deleting the plugin's `data.json` removes the lock;
- the WebDAV password is stored in plain text in `data.json`;
- anyone with write access to the WebDAV folder can control the plugin through `_control/`.

Things worth reporting, for example:

- a way to get past the lock screen or reach the vault's notes inside Obsidian while locked,
  without touching files on disk;
- the private folder appearing in Obsidian while locked;
- the passphrase, its hash, or the WebDAV password being uploaded or leaked;
- any way for the plugin to delete or lose data on the server or the computer;
- a `_control/` input that does more than the documented commands (for example, writing
  outside the vault).
