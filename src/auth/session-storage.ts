import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const SessionSchema = z.object({
  id: z.string(),
  refreshToken: z.string(),
  scopes: z.array(z.string()),
  account: z.object({
    id: z.string(),
    label: z.string(),
  }),
});

export type StoredSession = z.infer<typeof SessionSchema>;

export class FileAuthStorage {
  private readonly sessionFile: string;

  constructor(stateDir: string) {
    this.sessionFile = path.join(stateDir, "session.json");
  }

  async getSession(): Promise<StoredSession | undefined> {
    try {
      const raw = await fs.readFile(this.sessionFile, "utf-8");
      return SessionSchema.parse(JSON.parse(raw));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw err;
    }
  }

  async storeSession(session: StoredSession): Promise<void> {
    await fs.writeFile(this.sessionFile, JSON.stringify(session, null, 2), "utf-8");
  }

  async removeSession(): Promise<void> {
    try {
      await fs.unlink(this.sessionFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}
