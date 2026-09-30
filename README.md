# Heimdall-SSH

Live stats for your SSH servers, right in the VS Code sidebar. Minimal, handy, no agent to install on the server.

Each server gets a card with:

- **CPU, Memory, Load, Disk** gauges (green → yellow → red)
- **Network** down/up speed and packets per second
- **Disk I/O** throughput and IOPS
- OS, uptime and latency, plus a status dot (connecting / online / error)
- A button to open an SSH terminal to that server

The machine VS Code is running on is shown too, as the first card.

## Install

Download `heimdall-ssh-x.y.z.vsix` from the [latest release](https://github.com/t7spotter/HEIMDALL-SSH/releases/latest) and run:

```sh
code --install-extension heimdall-ssh-x.y.z.vsix
```

Or use **Extensions → ⋯ → Install from VSIX…**. To update later, click the download icon in the panel title (or run **Heimdall-SSH: Check for Updates**). If a newer release exists it is downloaded and installed, and a **Reload Window** button appears.

## Getting started

1. Install the extension and click the **Heimdall-SSH** icon in the activity bar.
2. Hosts from `~/.ssh/config` appear automatically. Edits to that file are picked up within a couple of seconds.
3. To add a server that isn't in your config, click **+** in the panel title and answer the prompts.

### Authentication

| Source | Method |
| --- | --- |
| `~/.ssh/config` host with `IdentityFile` | That key file |
| `~/.ssh/config` host without one | ssh-agent, then `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` |
| Added with **+** | ssh-agent / default keys, a key file, or a password |

Passwords are stored in VS Code's secret storage, never in settings. Passphrase-protected key files aren't supported directly; load them into ssh-agent.

### Host keys

The first time Heimdall connects to a server it remembers the host key. If the key later changes, the connection is refused. Run **Heimdall-SSH: Forget Saved Host Keys** if the change is expected.

## How it works

Heimdall keeps one SSH connection per server and, every few seconds, runs a single read-only command that reads `/proc` and `df`. Rates (CPU, network, disk) come from the difference between two readings. Polling pauses while the panel is hidden, and dropped connections reconnect automatically.

Nothing is installed or left running on the server.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `heimdall.refreshInterval` | `3` | Seconds between updates |
| `heimdall.servers` | `[]` | Extra servers (id, name, host, port, username, auth, keyPath) |

## Commands

- **Heimdall-SSH: Open ~/.ssh/config** (also the file icon in the panel title; creates a commented template if the file doesn't exist)
- **Heimdall-SSH: Check for Updates** (download icon in the panel title)
- **Heimdall-SSH: Add Server**
- **Heimdall-SSH: Reconnect All**
- **Heimdall-SSH: Forget Saved Host Keys**

## Limitations

- Servers must be Linux (stats come from `/proc`). The local card is shown on Linux only.
- `ProxyJump` and `Include` in `~/.ssh/config` aren't supported. Hosts behind a jump host will show a connection error, though the terminal button still works.
- In a Remote-SSH window, `~/.ssh/config` and "this machine" refer to the remote machine.

## Development

```sh
npm install
npm run build        # bundle with esbuild
npm run typecheck
```

Press **F5** to launch an Extension Development Host. To package and install locally:

```sh
npx vsce package --no-dependencies -o heimdall-ssh-0.1.0.vsix
code --install-extension heimdall-ssh-0.1.0.vsix --force
```

## License

MIT
