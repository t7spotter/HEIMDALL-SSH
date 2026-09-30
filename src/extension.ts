import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ServerConfig } from './monitor';
import { unwatchFile, watchFile } from 'fs';
import { SSH_CONFIG_PATH } from './sshConfig';
import { ServersView } from './view';

export function activate(ctx: vscode.ExtensionContext) {
  const view = new ServersView(ctx);
  watchFile(SSH_CONFIG_PATH, { interval: 2000 }, () => view.syncMonitors());
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('heimdall.servers', view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('heimdall') && view.syncMonitors()),
    vscode.commands.registerCommand('heimdall.refresh', () => view.reconnectAll()),
    vscode.commands.registerCommand('heimdall.forgetHostKeys', async () => {
      await ctx.globalState.update('heimdall.hostKeys', {});
      vscode.window.showInformationMessage('Heimdall: saved host keys cleared.');
      view.reconnectAll();
    }),
    vscode.commands.registerCommand('heimdall.addServer', () => addServer(ctx)),
    { dispose: () => { view.dispose(); unwatchFile(SSH_CONFIG_PATH); } },
  );
}

async function addServer(ctx: vscode.ExtensionContext) {
  const host = await vscode.window.showInputBox({ title: 'Host or IP', ignoreFocusOut: true });
  if (!host) return;
  const username = await vscode.window.showInputBox({ title: 'Username', value: 'root', ignoreFocusOut: true });
  if (!username) return;
  const port = await vscode.window.showInputBox({
    title: 'Port', value: '22', ignoreFocusOut: true,
    validateInput: (v) => (/^\d+$/.test(v) && +v > 0 && +v < 65536 ? undefined : 'Invalid port'),
  });
  if (!port) return;
  const name = await vscode.window.showInputBox({ title: 'Name (optional)', value: host, ignoreFocusOut: true });
  if (name === undefined) return;
  const auth = await vscode.window.showQuickPick(
    [
      { label: 'SSH agent / default keys', value: 'auto' as const },
      { label: 'Private key file', value: 'key' as const },
      { label: 'Password', value: 'password' as const },
    ],
    { title: 'Authentication' },
  );
  if (!auth) return;
  const cfg: Omit<ServerConfig, 'id'> = { name: name || host, host, port: +port, username, auth: auth.value };
  if (auth.value === 'key') {
    const keyPath = await vscode.window.showInputBox({ title: 'Private key path', value: '~/.ssh/id_ed25519', ignoreFocusOut: true });
    if (!keyPath) return;
    cfg.keyPath = keyPath;
  }

  const id = randomUUID();
  if (cfg.auth === 'password') {
    const pw = await vscode.window.showInputBox({ title: 'Password', password: true, ignoreFocusOut: true });
    if (!pw) return;
    await ctx.secrets.store(`heimdall.pw.${id}`, pw);
  }
  const conf = vscode.workspace.getConfiguration('heimdall');
  await conf.update('servers', [...conf.get<ServerConfig[]>('servers', []), { id, ...cfg }], vscode.ConfigurationTarget.Global);
}

export function deactivate() {}
