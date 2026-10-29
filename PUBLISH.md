# Publishing this repo (one-time) — for Claude Code on the VPS

Goal: this folder becomes the public GitHub repo `obsidian-lock/vault-lock-backup`
with a `1.0.0` release that BRAT can install from.

```
# 1. Authenticate gh as the obsidian-lock account (browser or token flow)
gh auth login
gh auth status        # must show: Logged in to github.com account obsidian-lock

# 2. Create the public repo from this folder and push main
cd /path/to/vault-lock-backup
gh repo create obsidian-lock/vault-lock-backup --public --source . --push \
  --description "Obsidian plugin: passphrase lock, hidden private folder, one-way WebDAV backup with server-side control"

# 3. Tag 1.0.0 -> GitHub Actions builds main.js and publishes the release
git tag 1.0.0
git push origin 1.0.0

# 4. Wait for the workflow, then verify the three assets exist
gh run watch --repo obsidian-lock/vault-lock-backup --exit-status
gh release view 1.0.0 --repo obsidian-lock/vault-lock-backup
# expected assets: main.js, manifest.json, styles.css
```

If Actions is unavailable, build and release locally instead:
```
npm ci && npm run build
gh release create 1.0.0 --title 1.0.0 --notes "Vault Lock & Backup 1.0.0" main.js manifest.json styles.css
```

Future updates: bump `version` in manifest.json, commit, `git tag <version> && git push origin main <version>`.
BRAT on the laptop installs the new release at the next Obsidian start.
