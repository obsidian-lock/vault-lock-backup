import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, VLBSettings } from "./settings";
import { LockScreen } from "./lock";
import { PrivateFolder } from "./privateFolder";
import { Backup } from "./backup";
import { hashPass, randomHex, safeEqual } from "./crypto";

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
		this.addCommand({ id: "backup-now", name: "Back up now", callback: () => {
			if (!this.backup.enabled) { new Notice("Vault backup is not enabled."); return; }
			this.backup.requestReconcile("manual");
			new Notice("Backup started");
		} });
		this.addCommand({ id: "backup-reset", name: "Reset backup index (re-upload everything)", callback: () => this.backup.resetIndex() });
		this.addCommand({ id: "backup-restore", name: "Restore vault from server (download missing/changed files)", callback: () => {
			if (!this.backup.enabled) { new Notice("Vault backup is not enabled."); return; }
			this.backup.restoreFromServer();
			new Notice("Restore started");
		} });

		this.addSettingTab(new VLBSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => this.backup.start());
	}

	onunload(): void {
		this.backup.stop();
		this.lock.destroy();
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.settings.doneCommands = Array.isArray(saved.doneCommands) ? saved.doneCommands : [];
		this.settings.commandLog = saved.commandLog && typeof saved.commandLog === "object" ? saved.commandLog : {};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class VLBSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VLBPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		// ---- Lock ---------------------------------------------------------------
		new Setting(containerEl).setName("Lock").setHeading();

		let current = "", next = "", confirm = "";
		const passSetting = new Setting(containerEl)
			.setName(s.passHash ? "Change passphrase" : "Set passphrase")
			.setDesc(s.passHash
				? "Enter the current passphrase and the new one twice."
				: "No passphrase yet — the vault is not locked and the private folder is always visible.");
		if (s.passHash) passSetting.addText((t) => { t.setPlaceholder("Current"); t.inputEl.type = "password"; t.onChange((v) => (current = v)); });
		passSetting.addText((t) => { t.setPlaceholder("New"); t.inputEl.type = "password"; t.onChange((v) => (next = v)); });
		passSetting.addText((t) => { t.setPlaceholder("Confirm"); t.inputEl.type = "password"; t.onChange((v) => (confirm = v)); });
		passSetting.addButton((b) => b.setButtonText("Save").setCta().onClick(async () => {
			if (s.passHash && !safeEqual(await hashPass(current, s.passSalt), s.passHash)) { new Notice("Current passphrase is wrong."); return; }
			if (next.length < 4) { new Notice("Passphrase must be at least 4 characters."); return; }
			if (next !== confirm) { new Notice("Passphrases do not match."); return; }
			s.passSalt = randomHex(16);
			s.passHash = await hashPass(next, s.passSalt);
			await this.plugin.saveSettings();
			new Notice("Passphrase saved.");
			this.display();
		}));

		new Setting(containerEl)
			.setName("Lock after idle (minutes)")
			.setDesc("0 disables the idle lock.")
			.addText((t) => t.setValue(String(s.idleMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= 0) { s.idleMinutes = n; await this.plugin.saveSettings(); }
			}));

		new Setting(containerEl)
			.setName("Lock when the window loses focus")
			.addToggle((t) => t.setValue(s.lockOnBlur).onChange(async (v) => { s.lockOnBlur = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Private folder")
			.setDesc("Top-level folder that is renamed to a dot-folder (invisible to Obsidian) while locked. Change it only while unlocked.")
			.addText((t) => t.setValue(s.privateFolder).onChange(async (v) => {
				const name = v.trim();
				if (name.includes("/") || name.startsWith(".")) return;
				if (await this.app.vault.adapter.exists("." + s.privateFolder)) { new Notice("Unlock first — the current private folder is hidden."); return; }
				s.privateFolder = name;
				await this.plugin.saveSettings();
			}));

		// ---- Backup -------------------------------------------------------------
		new Setting(containerEl).setName("Backup (one-way, to WebDAV)").setHeading();

		new Setting(containerEl)
			.setName("Enable backup")
			.addToggle((t) => t.setValue(s.backupEnabled).onChange(async (v) => {
				s.backupEnabled = v; await this.plugin.saveSettings(); this.plugin.backup.onSettingsChanged();
			}));

		new Setting(containerEl)
			.setName("WebDAV URL")
			.setDesc("Folder URL on your server, e.g. https://vault.example.com/")
			.addText((t) => t.setPlaceholder("https://…/").setValue(s.webdavUrl).onChange(async (v) => {
				s.webdavUrl = v.trim(); await this.plugin.saveSettings(); this.plugin.backup.onSettingsChanged();
			}));
		new Setting(containerEl)
			.setName("Username")
			.addText((t) => t.setValue(s.webdavUser).onChange(async (v) => {
				s.webdavUser = v; await this.plugin.saveSettings(); this.plugin.backup.onSettingsChanged();
			}));
		new Setting(containerEl)
			.setName("Password")
			.setDesc("Stored in this plugin's data.json (which is never uploaded).")
			.addText((t) => { t.inputEl.type = "password"; t.setValue(s.webdavPass).onChange(async (v) => {
				s.webdavPass = v; await this.plugin.saveSettings(); this.plugin.backup.onSettingsChanged();
			}); });

		new Setting(containerEl)
			.setName("Test connection")
			.addButton((b) => b.setButtonText("Test").onClick(async () => {
				try { new Notice(await this.plugin.backup.testConnection()); }
				catch (e) { new Notice("Failed: " + (e instanceof Error ? e.message : String(e)), 8000); }
			}))
			.addButton((b) => b.setButtonText("Back up now").onClick(() => {
				if (!this.plugin.backup.enabled) { new Notice("Enable backup and set the URL first."); return; }
				this.plugin.backup.requestReconcile("manual");
				new Notice("Backup started");
			}))
			.addButton((b) => b.setButtonText("Restore from server").setWarning().onClick(() => {
				if (!this.plugin.backup.enabled) { new Notice("Enable backup and set the URL first."); return; }
				this.plugin.backup.restoreFromServer();
				new Notice("Restore started — local versions of overwritten files go to _trash on the server.");
			}));

		new Setting(containerEl)
			.setName("Full check every (minutes)")
			.setDesc("Besides live uploads, the whole vault is compared against the server index on this interval and at startup.")
			.addText((t) => t.setValue(String(s.reconcileMinutes)).onChange(async (v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n >= 1) { s.reconcileMinutes = n; await this.plugin.saveSettings(); this.plugin.backup.onSettingsChanged(); }
			}));

		new Setting(containerEl)
			.setName("Exclude")
			.setDesc("One path prefix per line. Everything else in the vault, including .obsidian, is backed up.")
			.addTextArea((t) => {
				t.setValue(s.excludes).onChange(async (v) => { s.excludes = v; await this.plugin.saveSettings(); });
				t.inputEl.rows = 4;
				t.inputEl.cols = 40;
			});
	}
}
