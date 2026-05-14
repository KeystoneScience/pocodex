import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export interface SshAppServerAlias {
  alias: string;
  display: string;
  hostName: string | null;
  port: string | null;
  user: string | null;
}

export interface SshAppServerConnection {
  alias: string;
  appUrl: string;
  displayUrl: string;
  launcherAvailable: boolean;
  localPort: number;
  remotePort: number;
  token: string;
}

export interface SshAppServerLauncher {
  appPath: string;
  scriptPath: string;
}

interface SavedSshAppServerTarget {
  alias: string;
  localPort: number;
  remotePort: number;
  token: string;
  updatedAt: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_REMOTE_PORT = 8788;
const LOCAL_PORT_START = 8789;
const LOCAL_PORT_END = 8899;
const REMOTE_POCODEX_DIR = "$HOME/Downloads/pocodex";
const REMOTE_TMUX_SESSION = "pocodex-remote";
const SSH_TIMEOUT_MS = 20_000;
const SHORT_SSH_TIMEOUT_MS = 4_000;

export class SshAppServerManager {
  private readonly statePath = join(
    homedir(),
    "Library",
    "Application Support",
    "Pocodex",
    "ssh-app-servers.json",
  );

  async listAliases(): Promise<SshAppServerAlias[]> {
    const aliases = await this.readConfiguredAliases();
    const resolvedAliases: SshAppServerAlias[] = [];

    for (const alias of aliases) {
      resolvedAliases.push(await this.resolveAlias(alias));
    }

    return resolvedAliases.sort((left, right) => left.alias.localeCompare(right.alias));
  }

  async connect(alias: string): Promise<SshAppServerConnection> {
    await this.assertKnownAlias(alias);

    const target = await this.readOrCreateTarget(alias);
    await this.ensureRemotePocodex(target);
    const localPort = await this.ensureTunnel(target);
    const nextTarget = { ...target, localPort, updatedAt: new Date().toISOString() };
    await this.writeTarget(nextTarget);
    await this.waitForLocalSession(nextTarget);

    const appUrl = this.buildAppUrl(nextTarget);
    return {
      alias,
      appUrl,
      displayUrl: this.formatDisplayUrl(appUrl),
      launcherAvailable: platform() === "darwin",
      localPort,
      remotePort: nextTarget.remotePort,
      token: nextTarget.token,
    };
  }

  async createLauncher(alias: string): Promise<SshAppServerLauncher> {
    await this.assertKnownAlias(alias);
    const target = await this.readOrCreateTarget(alias);
    if (platform() !== "darwin") {
      throw new Error("Quick launch apps are only supported on macOS.");
    }

    const supportDir = join(homedir(), "Library", "Application Support", "Pocodex", "launchers");
    await mkdir(supportDir, { recursive: true });

    const safeName = sanitizeLauncherName(alias);
    const scriptPath = join(supportDir, `${safeName}.sh`);
    const applescriptPath = join(supportDir, `${safeName}.applescript`);
    const appPath = join(homedir(), "Desktop", `${alias} Pocodex.app`);

    await writeFile(scriptPath, renderLauncherShellScript(alias, target), { mode: 0o755 });
    await writeFile(applescriptPath, renderLauncherAppleScript(scriptPath));
    await runCommand("osacompile", ["-o", appPath, applescriptPath], {
      timeoutMs: SSH_TIMEOUT_MS,
    });

    return { appPath, scriptPath };
  }

  private async readOrCreateTarget(alias: string): Promise<SavedSshAppServerTarget> {
    const targets = await this.readTargets();
    const existing = targets[alias];
    if (existing) {
      return existing;
    }

    const target: SavedSshAppServerTarget = {
      alias,
      localPort: await findAvailablePort(LOCAL_PORT_START, LOCAL_PORT_END),
      remotePort: DEFAULT_REMOTE_PORT,
      token: randomBytes(16).toString("hex"),
      updatedAt: new Date().toISOString(),
    };
    await this.writeTarget(target);
    return target;
  }

  private async readTargets(): Promise<Record<string, SavedSshAppServerTarget>> {
    try {
      const raw = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) {
        return {};
      }

      const targets: Record<string, SavedSshAppServerTarget> = {};
      for (const [alias, target] of Object.entries(parsed)) {
        if (!isRecord(target)) {
          continue;
        }
        if (
          typeof target.alias !== "string" ||
          typeof target.localPort !== "number" ||
          typeof target.remotePort !== "number" ||
          typeof target.token !== "string" ||
          typeof target.updatedAt !== "string"
        ) {
          continue;
        }
        targets[alias] = target as unknown as SavedSshAppServerTarget;
      }
      return targets;
    } catch {
      return {};
    }
  }

  private async writeTarget(target: SavedSshAppServerTarget): Promise<void> {
    const targets = await this.readTargets();
    targets[target.alias] = target;
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, `${JSON.stringify(targets, null, 2)}\n`);
  }

  private async readConfiguredAliases(): Promise<string[]> {
    const configPath = join(homedir(), ".ssh", "config");
    const contents = await readSshConfig(configPath, new Set());
    const aliases = new Set<string>();

    for (const line of contents.split(/\r?\n/)) {
      const cleaned = stripSshConfigComment(line).trim();
      const match = /^Host\s+(.+)$/i.exec(cleaned);
      if (!match) {
        continue;
      }

      for (const rawAlias of match[1].split(/\s+/)) {
        const alias = rawAlias.trim();
        if (!alias || alias.startsWith("!") || /[*?]/.test(alias)) {
          continue;
        }
        aliases.add(alias);
      }
    }

    return [...aliases];
  }

  private async resolveAlias(alias: string): Promise<SshAppServerAlias> {
    try {
      const result = await runCommand("ssh", ["-G", alias], {
        timeoutMs: SHORT_SSH_TIMEOUT_MS,
      });
      const config = parseSshGOutput(result.stdout);
      return {
        alias,
        display: formatAliasDisplay(alias, config),
        hostName: config.hostname ?? null,
        port: config.port ?? null,
        user: config.user ?? null,
      };
    } catch {
      return {
        alias,
        display: alias,
        hostName: null,
        port: null,
        user: null,
      };
    }
  }

  private async assertKnownAlias(alias: string): Promise<void> {
    if (!isSafeSshAlias(alias)) {
      throw new Error("Choose a valid SSH alias.");
    }

    const aliases = await this.readConfiguredAliases();
    if (!aliases.includes(alias)) {
      throw new Error(`No SSH alias named "${alias}" was found.`);
    }
  }

  private async ensureRemotePocodex(target: SavedSshAppServerTarget): Promise<void> {
    const script = renderRemoteStartupScript();
    try {
      await runCommand(
        "ssh",
        [
          target.alias,
          `POCODEX_TOKEN=${shellQuote(target.token)} REMOTE_PORT=${target.remotePort} TMUX_SESSION=${shellQuote(
            REMOTE_TMUX_SESSION,
          )} REMOTE_POCODEX_DIR=${shellQuote(REMOTE_POCODEX_DIR)} zsh -s`,
        ],
        {
          input: script,
          timeoutMs: SSH_TIMEOUT_MS,
        },
      );
    } catch (error) {
      throw new Error(
        `Could not start Pocodex on ${target.alias}: ${normalizeCommandError(error)}`,
      );
    }
  }

  private async ensureTunnel(target: SavedSshAppServerTarget): Promise<number> {
    if (await checkLocalSession(target.localPort, target.token)) {
      return target.localPort;
    }

    let localPort = target.localPort;
    if (!(await isPortAvailable(localPort))) {
      localPort = await findAvailablePort(LOCAL_PORT_START, LOCAL_PORT_END);
    }

    await runCommand(
      "ssh",
      [
        "-fN",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `127.0.0.1:${localPort}:127.0.0.1:${target.remotePort}`,
        target.alias,
      ],
      {
        timeoutMs: SSH_TIMEOUT_MS,
      },
    );

    return localPort;
  }

  private async waitForLocalSession(target: SavedSshAppServerTarget): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await checkLocalSession(target.localPort, target.token)) {
        return;
      }
      await delay(500);
    }
    throw new Error(`The SSH tunnel to ${target.alias} did not become ready.`);
  }

  private buildAppUrl(target: SavedSshAppServerTarget): string {
    const url = new URL(`http://127.0.0.1:${target.localPort}/`);
    url.searchParams.set("token", target.token);
    return url.toString();
  }

  private formatDisplayUrl(url: string): string {
    const parsed = new URL(url);
    parsed.searchParams.delete("token");
    const displayUrl = parsed.toString();
    return displayUrl.endsWith("/") ? displayUrl.slice(0, -1) : displayUrl;
  }
}

async function readSshConfig(path: string, seen: Set<string>): Promise<string> {
  if (seen.has(path)) {
    return "";
  }
  seen.add(path);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return "";
  }

  const lines = [raw];
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = stripSshConfigComment(line).trim();
    const match = /^Include\s+(.+)$/i.exec(cleaned);
    if (!match) {
      continue;
    }
    for (const includePath of match[1].split(/\s+/)) {
      if (includePath.includes("*") || includePath.includes("?")) {
        continue;
      }
      lines.push(await readSshConfig(expandHome(includePath), seen));
    }
  }

  return lines.join("\n");
}

function stripSshConfigComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return hashIndex >= 0 ? line.slice(0, hashIndex) : line;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function parseSshGOutput(output: string): Record<string, string> {
  const config: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const [key, ...valueParts] = line.trim().split(/\s+/);
    if (!key || valueParts.length === 0) {
      continue;
    }
    config[key.toLowerCase()] = valueParts.join(" ");
  }
  return config;
}

function formatAliasDisplay(alias: string, config: Record<string, string>): string {
  const host = config.hostname;
  const user = config.user;
  const port = config.port;
  if (!host) {
    return alias;
  }

  const target = `${user ? `${user}@` : ""}${host}${port && port !== "22" ? `:${port}` : ""}`;
  return `${alias} (${target})`;
}

function isSafeSshAlias(alias: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(alias);
}

async function checkLocalSession(port: number, token: string): Promise<boolean> {
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/session-check?token=${encodeURIComponent(token)}`,
      {
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as unknown;
    return isRecord(payload) && payload.ok === true;
  } catch {
    return false;
  }
}

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No local port from ${start} to ${end} is available.`);
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    input?: string;
    timeoutMs: number;
  },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Timed out running ${command}.`));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited with ${code}`));
    });

    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

function renderRemoteStartupScript(): string {
  return [
    "set -euo pipefail",
    'PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
    'REMOTE_DIR="${REMOTE_POCODEX_DIR/#\\$HOME/$HOME}"',
    "",
    'if [[ ! -d "/Applications/Codex.app" ]]; then',
    '  echo "Codex.app was not found in /Applications on the remote machine." >&2',
    "  exit 1",
    "fi",
    "",
    "if ! command -v tmux >/dev/null 2>&1; then",
    '  echo "tmux is required on the remote machine." >&2',
    "  exit 1",
    "fi",
    "",
    'cd "$REMOTE_DIR"',
    'if [[ ! -f "dist/cli.js" ]]; then',
    '  echo "Pocodex is not built at $REMOTE_DIR." >&2',
    "  exit 1",
    "fi",
    "",
    'if curl -fsS "http://127.0.0.1:${REMOTE_PORT}/session-check?token=${POCODEX_TOKEN}" >/dev/null 2>&1; then',
    "  exit 0",
    "fi",
    "",
    'if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then',
    '  tmux kill-session -t "$TMUX_SESSION"',
    "fi",
    "",
    'tmux new-session -d -s "$TMUX_SESSION" "node dist/cli.js --listen 127.0.0.1:${REMOTE_PORT} --token ${POCODEX_TOKEN}"',
    "",
    "for attempt in {1..20}; do",
    '  if curl -fsS "http://127.0.0.1:${REMOTE_PORT}/session-check?token=${POCODEX_TOKEN}" >/dev/null 2>&1; then',
    "    exit 0",
    "  fi",
    "  sleep 0.5",
    "done",
    "",
    'echo "Remote Pocodex did not become ready." >&2',
    "exit 1",
    "",
  ].join("\n");
}

function renderLauncherShellScript(alias: string, target: SavedSshAppServerTarget): string {
  return `#!/bin/zsh
set -euo pipefail

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SSH_ALIAS=${shellQuote(alias)}
REMOTE_PORT=${target.remotePort}
LOCAL_PORT=${target.localPort}
TOKEN=${shellQuote(target.token)}
URL="http://127.0.0.1:\${LOCAL_PORT}/?token=\${TOKEN}"
CHECK_URL="http://127.0.0.1:\${LOCAL_PORT}/session-check?token=\${TOKEN}"

session_ok() {
  curl -fsS --max-time 2 "\${CHECK_URL}" 2>/dev/null | grep -q '"ok":true'
}

start_remote_pocodex() {
  ssh "\${SSH_ALIAS}" "POCODEX_TOKEN=${shellQuote(
    target.token,
  )} REMOTE_PORT=${target.remotePort} TMUX_SESSION=${shellQuote(
    REMOTE_TMUX_SESSION,
  )} REMOTE_POCODEX_DIR=${shellQuote(REMOTE_POCODEX_DIR)} zsh -s" <<'REMOTE'
${renderRemoteStartupScript()}
REMOTE
}

start_tunnel() {
  if session_ok; then
    return
  fi

  ssh -fN \\
    -o ExitOnForwardFailure=yes \\
    -o ServerAliveInterval=30 \\
    -o ServerAliveCountMax=3 \\
    -L "127.0.0.1:\${LOCAL_PORT}:127.0.0.1:\${REMOTE_PORT}" \\
    "\${SSH_ALIAS}"
}

wait_for_tunnel() {
  local attempt
  for attempt in {1..20}; do
    if session_ok; then
      return
    fi
    sleep 0.5
  done

  echo "The \${SSH_ALIAS} Pocodex tunnel did not become ready at \${CHECK_URL}." >&2
  exit 1
}

start_remote_pocodex
start_tunnel
wait_for_tunnel
open "\${URL}"
osascript -e "display notification \\"Connected through 127.0.0.1:\${LOCAL_PORT}\\" with title \\"Pocodex SSH\\""
`;
}

function renderLauncherAppleScript(scriptPath: string): string {
  return `on run
  set launcherPath to ${JSON.stringify(scriptPath)}
  try
    do shell script quoted form of launcherPath
  on error errorMessage number errorNumber
    display alert "Pocodex SSH failed" message errorMessage as critical
  end try
end run
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeLauncherName(value: string): string {
  return basename(value).replace(/[^A-Za-z0-9._-]+/g, "-") || "ssh";
}

function normalizeCommandError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}
