import http from "node:http";
import { randomUUID } from "crypto";
import {
  OAuth2Client,
  Credentials as OAuth2Credentials,
  CodeChallengeMethod,
} from "google-auth-library";
import fetch from "node-fetch";
import open from "open";
import chalk from "chalk";
import { z } from "zod";
import { FileAuthStorage } from "./session-storage.js";
import { REQUIRED_SCOPES } from "./constants.js";

interface AuthenticatedSession {
  accessToken: string;
  refreshToken: string;
  expiryDate: number;
  account: {
    id: string;
    label: string;
  };
}

const UserInfoSchema = z.object({
  name: z.string(),
  email: z.string().email(),
});

type UserInfo = z.infer<typeof UserInfoSchema>;

export class GoogleOAuthManager {
  constructor(
    private readonly client: OAuth2Client,
    private readonly storage: FileAuthStorage,
  ) {}

  async getAccessToken(forceLogin = false): Promise<AuthenticatedSession> {
    if (!forceLogin) {
      const session = await this.tryRefreshFromStorage();
      if (session) {
        return session;
      }
    }
    return this.performLogin();
  }

  async signOut(): Promise<void> {
    await this.storage.removeSession();
  }

  private async tryRefreshFromStorage(): Promise<AuthenticatedSession | undefined> {
    const stored = await this.storage.getSession();
    if (!stored) {
      return undefined;
    }
    this.client.setCredentials({
      refresh_token: stored.refreshToken,
    });
    try {
      const { credentials } = await this.client.refreshAccessToken();
      if (!credentials.access_token || !credentials.expiry_date) {
        throw new Error("Missing refreshed credentials");
      }
      return {
        accessToken: credentials.access_token,
        refreshToken: stored.refreshToken,
        expiryDate: credentials.expiry_date,
        account: stored.account,
      };
    } catch (err) {
      await this.storage.removeSession();
      if (isRecoverableGaxiosError(err)) {
        console.warn("Stored session invalid, forcing login.");
        return undefined;
      }
      throw err;
    }
  }

  private async performLogin(): Promise<AuthenticatedSession> {
    console.log(chalk.cyan("No cached session found. Starting OAuth login..."));
    const verifier = await this.client.generateCodeVerifierAsync();
    const state = randomUUID();
    const server = createLoopbackServer();
    const port = await server.start();
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authUrl = this.client.generateAuthUrl({
      access_type: "offline",
      scope: [...REQUIRED_SCOPES],
      prompt: "consent",
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: verifier.codeChallenge,
      redirect_uri: redirectUri,
    });
    await open(authUrl);
    console.log(chalk.green(`Opened browser for Google login. If it did not open, visit:\n${authUrl}`));
    const code = await server.waitForCode(state);
    server.dispose();
    const tokenResponse = await this.client.getToken({
      code,
      codeVerifier: verifier.codeVerifier,
      redirect_uri: redirectUri,
    });
    const tokens = tokenResponse.tokens;
    if (!hasRequiredCredentials(tokens)) {
      throw new Error("Google did not return full credential set");
    }
    const user = await this.fetchUserInfo(tokens.access_token);
    const session = {
      id: randomUUID(),
      refreshToken: tokens.refresh_token,
      scopes: REQUIRED_SCOPES.slice(),
      account: { id: user.email, label: user.name },
    };
    await this.storage.storeSession(session);
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      account: session.account,
    };
  }

  private async fetchUserInfo(token: string): Promise<UserInfo> {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch user profile: ${res.status} ${body}`);
    }
    return UserInfoSchema.parse(await res.json());
  }
}

function hasRequiredCredentials(
  credentials: OAuth2Credentials,
): credentials is OAuth2Credentials & {
  refresh_token: string;
  access_token: string;
  expiry_date: number;
} {
  return (
    typeof credentials.refresh_token === "string" &&
    typeof credentials.access_token === "string" &&
    typeof credentials.expiry_date === "number"
  );
}

function isRecoverableGaxiosError(err: unknown): boolean {
  if (
    err &&
    typeof err === "object" &&
    "response" in err &&
    err.response &&
    typeof err.response === "object" &&
    "status" in err.response
  ) {
    const status = (err.response as { status?: number }).status;
    return status === 400 || status === 401;
  }
  return false;
}

function createLoopbackServer() {
  let server: http.Server | undefined;
  let resolver: ((value: string) => void) | undefined;
  let rejecter: ((reason?: unknown) => void) | undefined;

  return {
    async start(): Promise<number> {
      return await new Promise<number>((resolve, reject) => {
        server = http.createServer((req, res) => {
          if (!req.url) {
            res.writeHead(400);
            res.end("Invalid request");
            return;
          }
          const url = new URL(req.url, "http://127.0.0.1");
          if (url.pathname !== "/callback") {
            res.writeHead(404);
            res.end();
            return;
          }
          const state = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          if (!state || !code) {
            res.writeHead(400);
            res.end("Missing params");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<html><body><h2>Authentication complete. You can return to the CLI.</h2></body></html>");
          resolver?.(JSON.stringify({ state, code }));
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server?.address();
          if (typeof address === "object" && address) {
            resolve(address.port);
          } else {
            reject(new Error("Failed to bind loopback server"));
          }
        });
      });
    },
    async waitForCode(expectedState: string): Promise<string> {
      return await new Promise<string>((resolve, reject) => {
        resolver = (payload: string) => {
          try {
            const parsed = JSON.parse(payload) as { state: string; code: string };
            if (parsed.state !== expectedState) {
              reject(new Error("State mismatch during OAuth callback"));
              return;
            }
            resolve(parsed.code);
          } catch (err) {
            reject(err);
          }
        };
        rejecter = reject;
      });
    },
    dispose() {
      resolver = undefined;
      if (server) {
        server.close();
      }
    },
  };
}
