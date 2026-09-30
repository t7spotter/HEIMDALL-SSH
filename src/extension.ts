import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { ServerConfig } from './monitor';
import { readSshConfig } from './sshConfig';
import { ServersView } from './view';

export function activate(ctx: vscode.ExtensionContext) {
  const view = new ServersView(ctx);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('yomo.servers', view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('yomo') && view.syncMonitors()),
    vscode.commands.registerCommand('yomo.refresh', () => view.reconnectAll()),
    vscode.commands.registerCommand('yomo.forgetHostKeys', async () => {
      await ctx.globalState.update('yomo.hostKeys', {});
      vscode.window.showInformationMessage('Yomo: saved host keys cleared.');
      view.reconnectAll();
    }),
    vscode.commands.registerCommand('yomo.addServer', () => addServer(ctx)),
    { dispose: () => view.dispose() },
  );
}

async function addServer(ctx: vscode.ExtensionContext) {
  const MANUAL = '$(edit) Enter manually…';
  const hosts = readSshConfig();
  let cfg: Omit<ServerConfig, 'id'> | undefined;

  const pick = hosts.length
    ? await vscode.window.showQuickPick(
        [
          ...hosts.map((h) => ({ label: h.alias, description: [h.user, h.hostName].filter(Boolean).join('@'), host: h })),
          { label: MANUAL, description: '', host: undefined },
        ],
        { title: 'Add server', placeHolder: 'Pick a host from ~/.ssh/config' },
      )
    : { label: MANUAL, host: undefined };
  if (!pick) return;

  if (pick.host) {
    const h = pick.host;
    cfg = {
      name: h.alias,
      host: h.hostName ?? h.alias,
      port: h.port,
      username: h.user ?? process.env.USER ?? 'root',
      auth: h.identityFile ? 'key' : 'agent',
      keyPath: h.identityFile,
    };
  } else {
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
        { label: 'SSH agent', value: 'agent' as const },
        { label: 'Private key file', value: 'key' as const },
        { label: 'Password', value: 'password' as const },
      ],
      { title: 'Authentication' },
    );
    if (!auth) return;
    cfg = { name: name || host, host, port: +port, username, auth: auth.value };
    if (auth.value === 'key') {
      const keyPath = await vscode.window.showInputBox({ title: 'Private key path', value: '~/.ssh/id_ed25519', ignoreFocusOut: true });
      if (!keyPath) return;
      cfg.keyPath = keyPath;
    }
  }

  const id = randomUUID();
  if (cfg.auth === 'password') {
    const pw = await vscode.window.showInputBox({ title: 'Password', password: true, ignoreFocusOut: true });
    if (!pw) return;
    await ctx.secrets.store(`yomo.pw.${id}`, pw);
  }
  const conf = vscode.workspace.getConfiguration('yomo');
  await conf.update('servers', [...conf.get<ServerConfig[]>('servers', []), { id, ...cfg }], vscode.ConfigurationTarget.Global);
}

export function deactivate() {}
