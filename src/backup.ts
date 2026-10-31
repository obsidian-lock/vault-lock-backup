import { Notice, requestUrl, RequestUrlResponse, TAbstractFile, TFolder } from "obsidian";
import type VLBPlugin from "./main";
import { b64 } from "./crypto";
import { Control, CONTROL } from "./control";

/**
 * One-way push of the vault to a WebDAV folder.
 *
 * Design: there is exactly one recovery mechanism — a reconcile that compares the
 * local file list (mtime+size) with an index (`_manifest.json`) stored on the server
 * and uploads whatever differs. Vault events only make the same thing happen sooner.
 * The reconcile runs at startup, on a timer, when the machine comes back online, and
 * one minute after any failure. Nothing is ever deleted on the server: removed or
 * renamed-away files are moved into `_trash/<timestamp>/`.
 */

export type Entry = { m: number; s: number };
type Manifest = Record<string, Entry>;
type Status = "off" | "idle" | "syncing" | "error";

const MANIFEST = "_manifest.json";
const TRASH = "_trash";
const MAX_BYTES = 100 * 1024 * 1024;
const DEBOUNCE_MS = 2_000;
const MANIFEST_FLUSH_MS = 5_000;
const RETRY_MS = 60_000;
const STARTUP_DELAY_MS = 8_000;

export class Backup {
	manifest: Manifest = {};
	control: Control;
	lastError = "";
	private manifestLoaded = false;
	private manifestDirty = false;
	private manifestTimer: number | null = null;
	private pending = new Map<string, number>();
	private queue: Promise<void> = Promise.resolve();
	private knownDirs = new Set<string>();
	private retryTimer: number | null = null;
	private intervalTimer: number | null = null;
	private startupTimer: number | null = null;
	private failed = false;
	private reconcileQueued = false;
	private warnedLarge = new Set<string>();
	private lastOk: Date | null = null;
	private statusEl: HTMLElement;
	private stopped = false;

	constructor(private plugin: VLBPlugin) {
		this.statusEl = plugin.addStatusBarItem();
		this.control = new Control(plugin, this);
		this.setStatus("off");
	}

	/** On whenever a server URL is set. */
	get enabled(): boolean {
		return !!this.plugin.settings.webdavUrl.trim() && !this.stopped;
	}

	// ---- lifecycle -----------------------------------------------------------

	start(): void {
		const v = this.plugin.app.vault;
		this.plugin.registerEvent(v.on("create", (f) => this.onChange(f.path)));
		this.plugin.registerEvent(v.on("modify", (f) => this.onChange(f.path)));
		this.plugin.registerEvent(v.on("delete", (f) => this.onDelete(f)));
		this.plugin.registerEvent(v.on("rename", (f, old) => this.onRename(f, old)));
		this.plugin.registerDomEvent(window, "online", () => this.requestReconcile("online"));
		this.scheduleInterval();
		this.startupTimer = window.setTimeout(() => this.requestReconcile("startup"), STARTUP_DELAY_MS);
		this.setStatus(this.enabled ? "idle" : "off");
	}

	stop(): void {
		this.stopped = true;
		for (const t of this.pending.values()) window.clearTimeout(t);
		this.pending.clear();
		for (const t of [this.manifestTimer, this.retryTimer, this.intervalTimer, this.startupTimer]) {
			if (t) window.clearTimeout(t);
		}
	}

	/** Forget the server index; the next reconcile re-uploads every file. */
	clearIndex(): void {
		this.manifest = {};
		this.manifestLoaded = true;
		this.manifestDirty = true;
		this.knownDirs.clear();
	}

	resetIndex(): void {
		this.clearIndex();
		this.failed = false;
		new Notice("Vault backup: index reset, re-uploading everything.");
		this.requestReconcile("reset");
	}

	/** Download every indexed file that is missing or differs locally (new laptop, or repair). */
	restoreFromServer(): void {
		this.run(async () => {
			this.setStatus("syncing");
			const n = await this.control.restoreAll();
			await this.flushManifest();
			this.setStatus("idle");
			new Notice(`Vault backup: restored ${n} files from the server.`, 8000);
		}, true);
	}

	/** Local path for a server path: inside the private folder, that is the hidden name while locked. */
	async toLocal(sp: string): Promise<string> {
		const pf = this.plugin.privateFolder;
		if (!pf.enabled) return sp;
		if (sp === pf.name || sp.startsWith(pf.name + "/")) {
			if (await this.plugin.app.vault.adapter.exists(pf.hiddenName)) return pf.hiddenName + sp.slice(pf.name.length);
		}
		return sp;
	}

	scheduleInterval(): void {
		if (this.intervalTimer) window.clearTimeout(this.intervalTimer);
		const min = Math.max(1, this.plugin.settings.reconcileMinutes || 10);
		this.intervalTimer = window.setTimeout(() => {
			this.requestReconcile("interval");
			this.scheduleInterval();
		}, min * 60_000);
	}

	// ---- vault events --------------------------------------------------------

	private onChange(path: string): void {
		if (!this.enabled || this.excluded(path)) return;
		const t = this.pending.get(path);
		if (t) window.clearTimeout(t);
		this.pending.set(path, window.setTimeout(() => {
			this.pending.delete(path);
			this.run(() => this.syncPath(path));
		}, DEBOUNCE_MS));
	}

	private onDelete(f: TAbstractFile): void {
		if (!this.enabled || this.excluded(f.path)) return;
		const isFolder = f instanceof TFolder;
		const path = f.path;
		this.run(async () => {
			const adapter = this.plugin.app.vault.adapter;
			// Lock/unlock renames Private <-> .Private; Obsidian reports that as a delete.
			const alt = this.plugin.privateFolder.altPath(path);
			if (alt && (await adapter.exists(alt))) return;
			if (await adapter.exists(path)) return;
			await this.trash(this.serverPath(path), isFolder);
		});
	}

	private onRename(f: TAbstractFile, oldPath: string): void {
		if (!this.enabled) return;
		const isFolder = f instanceof TFolder;
		const newPath = f.path;
		this.run(async () => {
			const from = this.serverPath(oldPath);
			const to = this.serverPath(newPath);
			if (from === to) return;
			const oldEx = this.excluded(oldPath);
			const newEx = this.excluded(newPath);
			if (newEx) { if (!oldEx) await this.trash(from, isFolder); return; }
			if (oldEx) { await this.syncNew(newPath, isFolder); return; }

			await this.loadManifest();
			const keys = this.keysUnder(from, isFolder);
			if (keys.length === 0) { await this.syncNew(newPath, isFolder); return; }

			await this.ensureDir(parentOf(to));
			const r = await this.dav("MOVE", from, undefined, { Destination: this.url(to), Overwrite: "T" });
			for (const k of keys) {
				this.manifest[to + k.slice(from.length)] = this.manifest[k];
				delete this.manifest[k];
			}
			this.forgetDirs(from);
			this.touchManifest();
			if (r.status === 404) await this.syncNew(newPath, isFolder); // wasn't on the server after all
		});
	}

	private async syncNew(path: string, isFolder: boolean): Promise<void> {
		if (isFolder) this.requestReconcile("rename");
		else await this.syncPath(path);
	}

	// ---- queue / failure handling -------------------------------------------

	private run(fn: () => Promise<void>, force = false): void {
		this.queue = this.queue.then(async () => {
			if (!this.enabled) return;
			if (this.failed && !force) return; // the retry reconcile will cover it
			try {
				await fn();
			} catch (e) {
				this.onFailure(e);
			}
		});
	}

	private onFailure(e: unknown): void {
		console.error("[VLB backup]", e);
		this.lastError = errMsg(e);
		if (!this.failed) new Notice("Vault backup: " + errMsg(e) + " — retrying in a minute", 8000);
		this.failed = true;
		this.setStatus("error");
		if (!this.retryTimer) {
			this.retryTimer = window.setTimeout(() => {
				this.retryTimer = null;
				this.requestReconcile("retry");
			}, RETRY_MS);
		}
	}

	requestReconcile(reason: string): void {
		if (!this.enabled || this.reconcileQueued) return;
		this.reconcileQueued = true;
		this.run(async () => {
			this.reconcileQueued = false;
			await this.reconcile(reason);
		}, true);
	}

	// ---- the core ------------------------------------------------------------

	private async reconcile(reason: string): Promise<void> {
		this.failed = false;
		this.setStatus("syncing");
		await this.loadManifest();
		await this.control.pull();

		const local = new Map<string, { path: string; m: number; s: number }>();
		await this.scan("", local);

		let uploaded = 0;
		for (const [sp, info] of local) {
			const cur = this.manifest[sp];
			if (cur && cur.m === info.m && cur.s === info.s) continue;
			if (await this.upload(info.path, sp, info.m, info.s)) uploaded++;
		}
		let trashed = 0;
		for (const sp of Object.keys(this.manifest)) {
			if (local.has(sp)) continue;
			await this.trash(sp, false);
			trashed++;
		}
		await this.flushManifest();
		await this.control.writeStatus({ reason, files: local.size, uploaded, trashed });
		this.lastError = "";
		this.lastOk = new Date();
		this.setStatus("idle");
		console.log(`[VLB backup] reconcile (${reason}): ${local.size} files, ${uploaded} uploaded, ${trashed} trashed`);
	}

	private async scan(dir: string, out: Map<string, { path: string; m: number; s: number }>): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		let listed;
		try {
			listed = await adapter.list(dir);
		} catch (e) {
			if (dir === "") listed = await adapter.list("/");
			else throw e;
		}
		for (const f of listed.files) {
			const p = clean(f);
			if (this.excluded(p)) continue;
			const st = await adapter.stat(p);
			if (!st || st.type !== "file") continue;
			out.set(this.serverPath(p), { path: p, m: st.mtime, s: st.size });
		}
		for (const d of listed.folders) {
			const p = clean(d);
			if (this.excluded(p + "/")) continue;
			await this.scan(p, out);
		}
	}

	private async syncPath(path: string): Promise<void> {
		if (this.excluded(path)) return;
		const st = await this.plugin.app.vault.adapter.stat(path);
		if (!st || st.type !== "file") return;
		await this.loadManifest();
		const sp = this.serverPath(path);
		const cur = this.manifest[sp];
		if (cur && cur.m === st.mtime && cur.s === st.size) return;
		if (await this.upload(path, sp, st.mtime, st.size)) {
			this.lastOk = new Date();
			this.setStatus("idle");
		}
	}

	private async upload(path: string, sp: string, m: number, s: number): Promise<boolean> {
		if (s > MAX_BYTES) {
			if (!this.warnedLarge.has(path)) {
				this.warnedLarge.add(path);
				new Notice(`Vault backup: skipping ${path} (over 100 MB)`, 8000);
			}
			return false;
		}
		const data = await this.plugin.app.vault.adapter.readBinary(path);
		this.setStatus("syncing");
		await this.ensureDir(parentOf(sp));
		await this.dav("PUT", sp, data, { "Content-Type": "application/octet-stream" });
		this.manifest[sp] = { m, s };
		this.touchManifest();
		return true;
	}

	private async trash(sp: string, isFolder: boolean): Promise<void> {
		await this.loadManifest();
		const keys = this.keysUnder(sp, isFolder);
		if (keys.length === 0 && !isFolder) return; // never uploaded; nothing to move
		const dest = `${TRASH}/${stamp()}/${sp}`;
		await this.ensureDir(parentOf(dest));
		await this.dav("MOVE", sp, undefined, { Destination: this.url(dest), Overwrite: "T" }); // 404 = already gone
		for (const k of keys) delete this.manifest[k];
		this.forgetDirs(sp);
		this.touchManifest();
	}

	// ---- manifest ------------------------------------------------------------

	async loadManifest(): Promise<void> {
		if (this.manifestLoaded) return;
		const r = await this.dav("GET", MANIFEST);
		this.manifest = r.status === 404 ? {} : this.parseManifest(r);
		this.manifestLoaded = true;
		this.manifestDirty = false;
	}

	private parseManifest(r: RequestUrlResponse): Manifest {
		try {
			const j = JSON.parse(r.text);
			return j && typeof j === "object" && !Array.isArray(j) ? (j as Manifest) : {};
		} catch {
			return {};
		}
	}

	touchManifest(): void {
		this.manifestDirty = true;
		if (this.manifestTimer) return;
		this.manifestTimer = window.setTimeout(() => {
			this.manifestTimer = null;
			this.run(() => this.flushManifest());
		}, MANIFEST_FLUSH_MS);
	}

	async flushManifest(): Promise<void> {
		if (!this.manifestDirty) return;
		await this.dav("PUT", MANIFEST, JSON.stringify(this.manifest), { "Content-Type": "application/json" });
		this.manifestDirty = false;
	}

	private keysUnder(sp: string, isFolder: boolean): string[] {
		if (!isFolder) return this.manifest[sp] ? [sp] : [];
		return Object.keys(this.manifest).filter((k) => k === sp || k.startsWith(sp + "/"));
	}

	// ---- WebDAV --------------------------------------------------------------

	private get base(): string {
		let u = this.plugin.settings.webdavUrl.trim();
		if (!u.endsWith("/")) u += "/";
		return u;
	}

	private url(sp: string): string {
		return this.base + sp.split("/").map(encodeURIComponent).join("/");
	}

	async ensureDir(dir: string): Promise<void> {
		if (!dir) return;
		let cur = "";
		for (const part of dir.split("/")) {
			cur = cur ? cur + "/" + part : part;
			if (this.knownDirs.has(cur)) continue;
			await this.dav("MKCOL", cur + "/"); // 405 = already exists
			this.knownDirs.add(cur);
		}
	}

	private forgetDirs(prefix: string): void {
		for (const d of Array.from(this.knownDirs)) {
			if (d === prefix || d.startsWith(prefix + "/")) this.knownDirs.delete(d);
		}
	}

	async dav(method: string, sp: string, body?: ArrayBuffer | string, headers: Record<string, string> = {}): Promise<RequestUrlResponse> {
		const s = this.plugin.settings;
		const h: Record<string, string> = { Authorization: "Basic " + b64(s.webdavUser + ":" + s.webdavPass), ...headers };
		const r = await requestUrl({ url: this.url(sp), method, headers: h, body, throw: false });
		const ok =
			r.status < 300 ||
			(method === "MKCOL" && r.status === 405) ||
			(method === "MOVE" && r.status === 404) ||
			(method === "GET" && r.status === 404);
		if (!ok) throw new Error(`${method} ${sp}: HTTP ${r.status}`);
		return r;
	}

	// ---- helpers -------------------------------------------------------------

	private serverPath(path: string): string {
		return this.plugin.privateFolder.toVisible(path);
	}

	private excluded(path: string): boolean {
		const own = (this.plugin.manifest.dir ?? ".obsidian/plugins/vault-lock-backup") + "/data.json";
		if (path === own || path === MANIFEST || path === TRASH || path.startsWith(TRASH + "/") || path === CONTROL || path.startsWith(CONTROL + "/")) return true;
		for (const line of this.plugin.settings.excludes.split("\n")) {
			const p = line.trim();
			if (p && path.startsWith(p)) return true;
		}
		return false;
	}

	stamp(): string {
		return stamp();
	}

	private setStatus(state: Status): void {
		const t = this.lastOk ? " " + this.lastOk.toTimeString().slice(0, 5) : "";
		const text =
			state === "off" ? "Backup: off" :
			state === "syncing" ? "Backup: syncing…" :
			state === "error" ? "Backup: ⚠ retrying" :
			"Backup: ✓" + t;
		this.statusEl.setText(text);
		this.statusEl.toggleClass("vlb-status-error", state === "error");
	}
}

function clean(p: string): string {
	return p.replace(/^\/+/, "");
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

function stamp(): string {
	const d = new Date();
	const z = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
