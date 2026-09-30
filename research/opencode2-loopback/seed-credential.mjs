// Stores a fake ChatGPT OAuth credential for the "openai" integration directly
// in the host's SQLite database, in the row shape the host's own
// Credential.create writes (copied from ../opencode2-thin/seed-credential.mjs).
// With it present, the host's built-in opencode.provider.openai plugin behaves
// as if the user had logged in with ChatGPT: it moves the openai base URL to
// the Codex endpoint and uses this token as the bearer. Every value here is
// fake, and the run's outbound proxy is dead, so nothing leaves the machine.
import { DatabaseSync } from "node:sqlite";
import { Credential } from "@opencode/schema/credential";

export const FAKE_HOST_CREDENTIAL = {
    type: "oauth",
    // The browser-login method of the built-in openai plugin; that plugin only
    // treats a credential as a ChatGPT login when the method matches.
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
