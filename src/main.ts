import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, VLBSettings } from "./settings";
import { LockScreen } from "./lock";
import { PrivateFolder } from "./privateFolder";
import { Backup } from "./backup";
import { PassphraseModal } from "./passphrase";

export default class VLBPlugin extends Plugin {
	settings!: VLBSettings;
	lock!: LockScreen;
	privateFolder!: PrivateFolder;
	backup!: Backup;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.privateFolder = new PrivateFolder(this);
		this.lock = new LockScreen(this);
		this.backup = new Backup(this);

		// If Obsidian crashed while unlocked, Private/ is still visible on disk: hide it
		// again, then lock before the UI renders.
		if (this.lock.hasPass) {
			try { await this.privateFolder.hide(); } catch (e) { console.error("[VLB] startup hide failed", e); }
			await this.lock.lock();
		}
		this.lock.install();

		this.addCommand({ id: "lock", name: "Lock vault now", callback: () => void this.lock.lock() });
		this.addCommand({ id: "change-passphrase", name: "Set or change passphrase", callback: () => new PassphraseModal(this.app, this).open() });
		this.addCommand({ id: "backup-now", name: "Back up now", callback: () => {
			if (!this.backup.enabled) { new Notice("Vault backup is not set up."); return; }
			this.backup.requestReconcile("manual");
			new Notice("Backup started");
		} });
		this.addCommand({ id: "backup-reset", name: "Reset backup index (re-upload everything)", callback: () => this.backup.resetIndex() });
		this.addCommand({ id: "backup-restore", name: "Restore vault from server (download missing/changed files)", callback: () => {
			if (!this.backup.enabled) { new Notice("Vault backup is not set up."); return; }
			this.backup.restoreFromServer();
			new Notice("Restore started");
		} });

		this.addSettingTab(new VLBSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			this.backup.start();
			// First run: the passphrase is the one thing to set up. Asked again at every start until set.
			if (!this.lock.hasPass) new PassphraseModal(this.app, this).open();
		});
	}

	onunload(): void {
		this.backup.stop();
		this.lock.destroy();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) ?? {};
		delete saved.backupEnabled; // 1.0.0 had an on/off switch; backup now runs whenever a server is set
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.settings.doneCommands = Array.isArray(saved.doneCommands) ? saved.doneCommands : [];
		this.settings.commandLog = saved.commandLog && typeof saved.commandLog === "object" ? saved.commandLog : {};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class VLBSettingTab extends PluginSettingTab {
	private advancedOpen = false;
	private statusTimer: number | null = null;

	constructor(app: App, private plugin: VLBPlugin) {
		super(app, plugin);
	}

	hide(): void {
		this.stopStatusTimer();
	}

	private stopStatusTimer(): void {
		if (this.statusTimer) window.clearInterval(this.statusTimer);
		this.statusTimer = null;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.stopStatusTimer();
		const s = this.plugin.settings;
		const backup = this.plugin.backup;

		// ---- What a user sees: the passphrase and whether the backup works --------
		new Setting(containerEl)
			.setName("Passphrase")
			.setDesc(s.passHash
				? "Needed to unlock the vault."
				: "Not set yet. Until you set one, the vault never locks and the private folder stays visible.")
			.addButton((b) => b.setButtonText(s.passHash ? "Change passphrase" : "Set passphrase").setCta()
				.onClick(() => new PassphraseModal(this.app, this.plugin, () => this.display()).open()));

		const status = new Setting(containerEl).setName("Backup").setDesc(backup.describe());
		this.statusTimer = window.setInterval(() => status.setDesc(backup.describe()), 2000);

		// ---- Everything else is folded away ------------------------------------
		const adv = containerEl.createEl("details", { cls: "vlb-advanced" });
		adv.open = this.advancedOpen;
		adv.addEventListener("toggle", () => (this.advancedOpen = adv.open));
		adv.createEl("summary", { text: "Advanced" });

		new Setting(adv).setName("Lock").setHeading();

		new Setting(adv)
			.setName("Lock after idle (minutes)")
			.setDesc("0 disables the idle lock.")
			.addText((t) => t.setValue(String(s.idleMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= 0) { s.idleMinutes = n; await this.plugin.saveSettings(); }
			}));

		new Setting(adv)
			.setName("Lock when the window loses focus")
			.addToggle((t) => t.setValue(s.lockOnBlur).onChange(async (v) => { s.lockOnBlur = v; await this.plugin.saveSettings(); }));

		new Setting(adv)
			.setName("Private folder")
			.setDesc("Top-level folder that is renamed to a dot-folder (invisible to Obsidian) while locked. Change it only while unlocked.")
			.addText((t) => t.setValue(s.privateFolder).onChange(async (v) => {
				const name = v.trim();
				if (name.includes("/") || name.startsWith(".")) return;
				if (await this.app.vault.adapter.exists("." + s.privateFolder)) { new Notice("Unlock first — the current private folder is hidden."); return; }
				s.privateFolder = name;
				await this.plugin.saveSettings();
			}));

		new Setting(adv).setName("Server").setHeading();

		// Edited here, applied together on Save, so a half-typed URL never starts a backup.
		let url = s.webdavUrl, user = s.webdavUser, pass = s.webdavPass;
		new Setting(adv)
			.setName("WebDAV URL")
			.setDesc("Folder URL on your server, e.g. https://vault.example.com/. The setup script fills in these three fields.")
			.addText((t) => t.setPlaceholder("https://…/").setValue(url).onChange((v) => (url = v)));
		new Setting(adv)
			.setName("Username")
			.addText((t) => t.setValue(user).onChange((v) => (user = v)));
		new Setting(adv)
			.setName("Password")
			.setDesc("Stored in this plugin's data.json, which is never uploaded.")
			.addText((t) => { t.inputEl.type = "password"; t.setValue(pass).onChange((v) => (pass = v)); });
		new Setting(adv)
			.addButton((b) => b.setButtonText("Save and test").setCta().onClick(async () => {
				s.webdavUrl = url.trim();
				s.webdavUser = user.trim();
				s.webdavPass = pass;
				await this.plugin.saveSettings();
				backup.onSettingsChanged();
				status.setDesc(backup.describe());
				if (!backup.enabled) { new Notice("Saved. Backup is off because the URL is empty."); return; }
				try { new Notice(await backup.testConnection()); }
				catch (e) { new Notice("Saved, but the test failed: " + (e instanceof Error ? e.message : String(e)), 8000); }
			}));

		new Setting(adv)
			.setName("Backup actions")
			.addButton((b) => b.setButtonText("Back up now").onClick(() => {
				if (!backup.enabled) { new Notice("Set the server first."); return; }
				backup.requestReconcile("manual");
				new Notice("Backup started");
			}))
			.addButton((b) => b.setButtonText("Restore from server").setWarning().onClick(() => {
				if (!backup.enabled) { new Notice("Set the server first."); return; }
				backup.restoreFromServer();
				new Notice("Restore started — local versions of overwritten files go to _trash on the server.");
			}));

		new Setting(adv)
			.setName("Full check every (minutes)")
			.setDesc("Besides live uploads, the whole vault is compared against the server index on this interval and at startup.")
			.addText((t) => t.setValue(String(s.reconcileMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= 1) { s.reconcileMinutes = n; await this.plugin.saveSettings(); backup.scheduleInterval(); }
			}));

		new Setting(adv)
			.setName("Exclude")
			.setDesc("One path prefix per line. Everything else in the vault, including .obsidian, is backed up.")
			.addTextArea((t) => {
				t.setValue(s.excludes).onChange(async (v) => { s.excludes = v; await this.plugin.saveSettings(); });
				t.inputEl.rows = 4;
				t.inputEl.cols = 40;
			});
	}
}
