import { Notice, Scope } from "obsidian";
import type VLBPlugin from "./main";
import { hashPass, safeEqual } from "./crypto";

const IDLE_CHECK_MS = 15_000;

export class LockScreen {
	locked = false;
	private overlay: HTMLElement | null = null;
	private scope: Scope | null = null;
	private lastActivity = Date.now();
	private busy = false;
	private failedAttempts = 0;
	private savedTitle = "";

	constructor(private plugin: VLBPlugin) {}

	get hasPass(): boolean {
		return !!this.plugin.settings.passHash && !!this.plugin.settings.passSalt;
	}

	install(): void {
		const touch = () => { this.lastActivity = Date.now(); };
		for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const) {
			this.plugin.registerDomEvent(document, ev, touch, { passive: true, capture: true });
		}
		this.plugin.registerInterval(window.setInterval(() => this.checkIdle(), IDLE_CHECK_MS));
		this.plugin.registerDomEvent(window, "blur", () => {
			if (this.plugin.settings.lockOnBlur) void this.lock();
		});
		// Belt and braces: while locked, swallow every key that isn't typed into the unlock box.
		this.plugin.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
			if (!this.locked) return;
			if (this.overlay && this.overlay.contains(e.target as Node)) return;
			e.stopImmediatePropagation();
			e.preventDefault();
		}, { capture: true });
	}

	private checkIdle(): void {
		const m = this.plugin.settings.idleMinutes;
		if (!this.hasPass || this.locked || m <= 0) return;
		if (Date.now() - this.lastActivity >= m * 60_000) void this.lock();
	}

	async lock(): Promise<void> {
		if (!this.hasPass) { new Notice("Vault Lock: set a passphrase in settings first."); return; }
		if (this.locked || this.busy) return;
		this.busy = true;
		try {
			this.locked = true;
			this.showOverlay();
			await this.plugin.privateFolder.hide();
		} catch (e) {
			console.error("[VLB] lock failed", e);
		} finally {
			this.busy = false;
		}
	}

	private async tryUnlock(pass: string): Promise<boolean> {
		const s = this.plugin.settings;
		const h = await hashPass(pass, s.passSalt);
		if (!safeEqual(h, s.passHash)) {
			this.failedAttempts++;
			await new Promise((r) => setTimeout(r, Math.min(5000, 500 * this.failedAttempts)));
			return false;
		}
		this.failedAttempts = 0;
		this.locked = false;
		this.lastActivity = Date.now();
		this.removeOverlay();
		try { await this.plugin.privateFolder.show(); } catch (e) { console.error("[VLB] unhide failed", e); }
		return true;
	}

	private showOverlay(): void {
		if (this.overlay) return;
		this.scope = new Scope();
		this.plugin.app.keymap.pushScope(this.scope);
		this.savedTitle = document.title;
		document.title = "Obsidian";
		document.body.addClass("vlb-locked");

		const o = document.body.createDiv({ cls: "vlb-overlay" });
		const box = o.createDiv({ cls: "vlb-box" });
		box.createDiv({ cls: "vlb-title", text: "Vault locked" });
		const input = box.createEl("input", {
			type: "password",
			cls: "vlb-input",
			attr: { placeholder: "Passphrase", autocomplete: "off", spellcheck: "false" },
		});
		const err = box.createDiv({ cls: "vlb-error" });
		const btn = box.createEl("button", { text: "Unlock", cls: "mod-cta" });

		let pending = false;
		const submit = async () => {
			if (pending) return;
			pending = true;
			btn.disabled = true;
			err.setText("");
			const ok = await this.tryUnlock(input.value);
			if (!ok) {
				input.value = "";
				err.setText("Wrong passphrase");
				btn.disabled = false;
				input.focus();
			}
			pending = false;
		};
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
		btn.addEventListener("click", () => void submit());
		// Keep focus inside the box.
		o.addEventListener("mousedown", (e) => { if (e.target === o) { e.preventDefault(); input.focus(); } });

		this.overlay = o;
		window.setTimeout(() => input.focus(), 30);
	}

	private removeOverlay(): void {
		if (this.scope) { this.plugin.app.keymap.popScope(this.scope); this.scope = null; }
		document.body.removeClass("vlb-locked");
		if (this.savedTitle) document.title = this.savedTitle;
		this.overlay?.remove();
		this.overlay = null;
	}

	destroy(): void {
		this.removeOverlay();
		this.locked = false;
	}
}
