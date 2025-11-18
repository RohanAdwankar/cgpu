/**
 * Simplified copy of the headers used by the VS Code extension.
 */

export interface Header {
  readonly key: string;
}

export interface StaticHeader extends Header {
  readonly value: string;
}

export const ACCEPT_JSON_HEADER: StaticHeader = {
  key: "Accept",
  value: "application/json",
};

export const AUTHORIZATION_HEADER: Header = {
  key: "Authorization",
};

export const COLAB_CLIENT_AGENT_HEADER: StaticHeader = {
  key: "X-Colab-Client-Agent",
  value: "vscode", // mimic existing client agent until a public token is available
};

export const COLAB_TUNNEL_HEADER: StaticHeader = {
  key: "X-Colab-Tunnel",
  value: "Google",
};

export const COLAB_RUNTIME_PROXY_TOKEN_HEADER: Header = {
  key: "X-Colab-Runtime-Proxy-Token",
};

export const COLAB_XSRF_TOKEN_HEADER: Header = {
  key: "X-Goog-Colab-Token",
};
