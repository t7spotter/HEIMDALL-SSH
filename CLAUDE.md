# Heimdall-SSH

VS Code extension showing live stats (CPU, memory, load, disk, network) for SSH servers from `~/.ssh/config` and the local machine.

## Commands
- `npm run build` bundle with esbuild, `npm run typecheck`, F5 to launch the extension host.
- Install locally: `npx vsce package --no-dependencies -o heimdall-ssh-0.1.2.vsix && code --install-extension heimdall-ssh-0.1.2.vsix --force`

## Git
- Do NOT add a `Co-Authored-By: Claude` trailer (or any other Claude/AI attribution line) to commit messages or PR descriptions. Commits are authored solely by the repo's configured git user.
