export type CmdResult = { ok: boolean; at: string; detail?: string };

export interface VLBSettings {
	passHash: string;
	passSalt: string;
	idleMinutes: number;
	lockOnBlur: boolean;
	privateFolder: string;
	/** Backup runs whenever this is set. The setup script fills in the three server fields. */
	webdavUrl: string;
	webdavUser: string;
	webdavPass: string;
	reconcileMinutes: number;
	excludes: string;
	/** ids of remote commands already executed (so none runs twice) */
	doneCommands: string[];
	/** results of the most recent remote commands, reported in _control/status.json */
	commandLog: Record<string, CmdResult>;
}

export const DEFAULT_SETTINGS: VLBSettings = {
	passHash: "",
	passSalt: "",
	idleMinutes: 5,
	lockOnBlur: false,
	privateFolder: "Private",
	webdavUrl: "",
	webdavUser: "",
	webdavPass: "",
	reconcileMinutes: 10,
	excludes: [".trash/", ".obsidian/workspace"].join("\n"),
	doneCommands: [],
	commandLog: {},
};
