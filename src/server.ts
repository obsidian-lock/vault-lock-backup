/**
 * The backup server this plugin pairs with. A fork changes these lines.
 *
 * PAIR_LOGIN is public on purpose: on the server it can only create small files in the
 * pairing inbox, and only while pairing is open. It must match PAIR_PASSWORD in server/vlb.
 */
export const SERVER_URL = "https://vault.815431624.xyz/";
export const PAIR_LOGIN = { user: "pair", pass: "vault-lock-backup-pairing" };
/** Where pairing requests go, relative to SERVER_URL. Never used for vault files. */
export const PAIR_DIR = "_pair";
