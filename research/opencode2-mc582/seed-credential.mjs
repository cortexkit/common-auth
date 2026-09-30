// Stores a ChatGPT login for the "openai" integration in the throwaway host's
// SQLite database, in the row shape the host's own Credential.create writes
// (same approach as ../opencode2-loopback/seed-credential.mjs).
//
// Only the live ACCESS token is copied. The refresh token stored here is a
// deliberately invalid string: the access token is still valid for about two
// days, so the host has no reason to refresh, and if it ever tries, the refresh
// fails instead of rotating the operator's real login. The real refresh token
// is never read into this process's output or written anywhere.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Credential } from "@opencode/schema/credential";

export const INVALID_REFRESH = "not-a-refresh-token";

// Reads the live ChatGPT access token, its expiry, and the account id (from
// the token's own claims) out of the operator's OpenCode 1 auth file.
export function readLiveAccess(authPath) {
    const entry = JSON.parse(readFileSync(authPath, "utf8")).openai;
    if (entry?.type !== "oauth" || typeof entry.access !== "string") throw new Error("no ChatGPT oauth entry under key openai");
    const payload = JSON.parse(Buffer.from(entry.access.split(".")[1], "base64url").toString("utf8"));
    const accountID = entry.accountId ?? payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (typeof accountID !== "string") throw new Error("no account id in the stored entry or the token claims");
    return { access: entry.access, expires: entry.expires, accountID };
}

export function seedCredential(dbPath, live) {
    const value = Credential.OAuth.make({
        type: "oauth",
        // The browser-login method of the built-in opencode.provider.openai
        // plugin; it only treats a credential as a ChatGPT login when the
        // method matches.
        methodID: "chatgpt-browser",
        refresh: INVALID_REFRESH,
        access: live.access,
        expires: live.expires,
        metadata: { accountID: live.accountID },
    });
    const db = new DatabaseSync(dbPath);
    try {
        const now = Date.now();
        db.prepare("UPDATE credential SET active = 0 WHERE integration_id = ?").run("openai");
        db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)").run(
            Credential.ID.create(),
            "openai",
            "mc582 spike ChatGPT login (access token only)",
            JSON.stringify(value),
            now,
            now,
        );
        return db.prepare("SELECT integration_id, label, active FROM credential").all();
    } finally {
        db.close();
    }
}
