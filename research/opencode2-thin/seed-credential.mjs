// Stores a fake ChatGPT OAuth credential for the "openai" integration directly
// in the host's SQLite database, in the row shape the host's own
// Credential.create writes (@opencode/core chunks/config-rtyr3d5h.js:78-93):
// integration_id, label, JSON value, active = 1. The value is built with the
// host's own schema so it decodes exactly like a credential from `auth login`.
// Every value here is fake; nothing is ever sent anywhere but the loopback mock.
import { DatabaseSync } from "node:sqlite";
import { Credential } from "@opencode/schema/credential";

export const FAKE_HOST_CREDENTIAL = {
    type: "oauth",
    // The browser-login method of the host's opencode.provider.openai plugin;
    // that plugin only treats a credential as ChatGPT when the method matches.
    methodID: "chatgpt-browser",
    refresh: "fake-refresh-HOST",
    access: "tok-HOST",
    metadata: { accountID: "acct-HOST" },
};

export function seedCredential(dbPath) {
    const value = Credential.OAuth.make({ ...FAKE_HOST_CREDENTIAL, expires: Date.now() + 30 * 86_400_000 });
    const db = new DatabaseSync(dbPath);
    try {
        const now = Date.now();
        db.prepare("UPDATE credential SET active = 0 WHERE integration_id = ?").run("openai");
        db.prepare("INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, 1, ?, ?)").run(
            Credential.ID.create(),
            "openai",
            "spike fake ChatGPT login",
            JSON.stringify(value),
            now,
            now,
        );
        return db.prepare("SELECT integration_id, label, active FROM credential").all();
    } finally {
        db.close();
    }
}
