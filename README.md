# Remote Codex Browser Mirror

Remote Codex Browser Mirror runs the real Codex desktop webview in a normal browser and bridges it back to a Codex app server. The goal is simple: keep Codex running on the machine that has the state, credentials, plugins, skills, automations, filesystem, and desktop access, while controlling it from another browser tab, laptop, phone, or SSH-tunneled machine.

This is a fork of Pocodex focused on remote app-server switching. The inherited CLI binary is still named `pocodex`, but this repository is aimed at the remote Codex mirror workflow.

## What It Does

- Serves the real Codex desktop UI from the installed Codex app bundle.
- Starts and bridges to Codex's bundled `codex app-server`.
- Mirrors the app-server-backed data the UI expects, including plugins, skills, automations, account state, projects, and workspace roots where available.
- Adds an **App server** switcher to connect the browser to a different Codex host.
- Discovers SSH aliases from `~/.ssh/config`, starts the remote mirror in `tmux`, creates a loopback SSH tunnel, and switches the browser to the remote app server.
- Offers a macOS Desktop quick-launch app for saved SSH targets.
- Improves the add-project folder picker with bridge-backed directory browsing and lightweight fuzzy folder search.

## Good Use Cases

- Run Codex on a desktop that stays awake while you close your laptop.
- Control a remote Codex install through a browser without exposing the remote service publicly.
- Keep plugins, skills, automations, and Computer Use tied to the machine that actually has them installed.
- Switch between local and remote Codex app servers from inside the mirrored UI.
- Open a phone or tablet browser to a trusted LAN or tunneled Codex session.

## Requirements

- macOS with Codex installed, usually at `/Applications/Codex.app`
- Node.js 24 or newer
- pnpm 9.x
- SSH access to any remote host you want to control
- `tmux` on remote hosts for the one-click SSH alias flow

WSL support from upstream Pocodex is still present, but the remote SSH workflow here is primarily designed around Mac hosts running Codex Desktop.

## Install From Source

```bash
git clone https://github.com/KeystoneScience/remote-codex-browser-mirror.git
cd remote-codex-browser-mirror
pnpm install --frozen-lockfile
pnpm run build
```

Run it:

```bash
node dist/cli.js --listen 127.0.0.1:8788 --token "$(openssl rand -hex 16)"
```

Open the printed URL in your browser. If you bind beyond loopback, always use a long random token.

## Local Browser Mirror

For local-only use:

```bash
node dist/cli.js
```

For a trusted LAN session:

```bash
node dist/cli.js --listen 0.0.0.0:8788 --token "$(openssl rand -hex 16)"
```

When listening on `0.0.0.0`, the CLI prints a preferred LAN URL if it can find one.

## Remote Over SSH

The safest remote pattern is:

1. Run the mirror on the remote machine bound to `127.0.0.1`.
2. Forward that remote loopback port to your local machine with SSH.
3. Open the forwarded local URL in your browser.

Set up the remote checkout at the path expected by the one-click SSH flow:

```bash
ssh your-ssh-alias
git clone https://github.com/KeystoneScience/remote-codex-browser-mirror.git ~/Downloads/pocodex
cd ~/Downloads/pocodex
pnpm install --frozen-lockfile
pnpm run build
```

Manual remote start:

```bash
ssh your-ssh-alias
cd ~/Downloads/pocodex
node dist/cli.js --listen 127.0.0.1:8788 --token "$(openssl rand -hex 16)"
```

Manual local tunnel:

```bash
ssh -fN \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L 127.0.0.1:8789:127.0.0.1:8788 \
  your-ssh-alias
```

Then open:

```text
http://127.0.0.1:8789/?token=<remote-token>
```

## One-Click SSH App Server Switching

Start the mirror locally, open it in your browser, and click **App server** in the top-right corner.

The **SSH aliases** section reads aliases from the local mirror host's `~/.ssh/config`. Clicking an alias will:

- verify the alias exists in SSH config
- check that the remote has Codex installed at `/Applications/Codex.app`
- start the remote mirror in a `tmux` session named `pocodex-remote`
- create or reuse a local loopback tunnel
- switch the browser to the tunneled remote URL
- ask whether to create a macOS Desktop quick-launch app

The remote checkout currently defaults to:

```text
~/Downloads/pocodex
```

To use another remote path, change `REMOTE_POCODEX_DIR` in `src/lib/ssh-app-server.ts` and rebuild.

## Desktop Quick Launchers

After an SSH alias connection succeeds on macOS, the app can create a Desktop `.app` for that alias. The launcher:

- starts the remote `tmux` mirror session if needed
- recreates the SSH tunnel if needed
- opens the tunneled browser URL
- reuses the saved local port and remote token

Saved launcher state lives in the user's local Application Support directory, not in this repository.

## CLI

```text
pocodex [--token <secret>] [--app <path>] [--listen 127.0.0.1:8787] [--dev]
```

Flags:

- `--token` optional browser-session secret
- `--app` path to the Codex desktop install root
- `--listen` host and port to bind, such as `127.0.0.1:8788` or `0.0.0.0:8788`
- `--dev` watches `src/pocodex.css` and pushes live CSS reload events to connected browsers

When `--app` is omitted, the mirror auto-detects `/Applications/Codex.app` on macOS.

## How It Works

1. The server reads Codex's shipped `app.asar` and serves the real desktop webview.
2. It patches `index.html` with local CSS, PWA metadata, and a browser bootstrap bridge.
3. It starts Codex's bundled app server with `codex app-server --listen stdio://`.
4. It translates browser requests and Codex webview IPC calls into host-side behavior.
5. It uses bridge calls where possible for plugins, skills, automations, workspace roots, projects, and account state.
6. The SSH switcher can start another copy of this mirror on a remote host and move the browser to that app server through a local tunnel.

## Security Model

Treat this as a trusted-local or trusted-SSH tool.

- Prefer `127.0.0.1` on remote hosts plus SSH tunnels.
- Use a long random token whenever the browser session is reachable beyond loopback.
- Do not expose this directly to the public internet.
- Any connected browser can drive the Codex session and whatever filesystem, plugins, skills, automations, and desktop capabilities the host allows.
- Remote Computer Use depends on the remote machine's GUI session and permissions.

## Current Limitations

- This depends on internal Codex Desktop bundle structure and app-server protocols, so Codex updates can break assumptions.
- Some native desktop behaviors are blocked or stubbed, including badge updates, some window controls, context menus, notifications, and power-save controls.
- Generic IPC coverage is incomplete; unsupported IPC methods return an explicit error.
- Streaming fetch is not implemented.
- The one-click SSH flow assumes the remote host is already authenticated, has Codex installed, can run `tmux`, and has this repo built at the configured path.
- This is not an official OpenAI product.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run lint
pnpm run typecheck
pnpm exec vitest run test/bootstrap-script.test.ts test/server.test.ts
```

Useful dev command:

```bash
pnpm run dev -- --listen 127.0.0.1:8788 --token "$(openssl rand -hex 16)"
```

## Credits

This is built on top of Pocodex by Dave Jeffery. Thanks to Ben Allfree for the original `pocodex` package-name handoff.
