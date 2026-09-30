import * as vscode from 'vscode';
import { Monitor, ServerConfig, Status } from './monitor';
import { Stats } from './stats';

type Snapshot = { status: Status; stats?: Stats };

export class ServersView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private monitors = new Map<string, Monitor>();
  private latest = new Map<string, Snapshot>();

  constructor(private ctx: vscode.ExtensionContext) {}

  private servers(): ServerConfig[] {
    return vscode.workspace.getConfiguration('yomo').get<ServerConfig[]>('servers', []);
  }

  private get active() {
    return !!this.view?.visible;
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = Math.random().toString(36).slice(2);
    const uri = (f: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('main.css')}"></head>
<body><div id="root"></div><script nonce="${nonce}" src="${uri('main.js')}"></script></body></html>`;

    view.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') this.pushAll();
      else if (m.type === 'add') vscode.commands.executeCommand('yomo.addServer');
      else if (m.type === 'terminal') this.openTerminal(m.id);
      else if (m.type === 'remove') this.remove(m.id);
    });
    view.onDidChangeVisibility(() => this.syncMonitors());
    view.onDidDispose(() => { this.view = undefined; this.syncMonitors(); });
  }

  /** Reconcile monitors with settings and current visibility. */
  syncMonitors() {
    const cfgs = this.servers();
    const ids = new Set(cfgs.map((c) => c.id));
    for (const [id, m] of this.monitors) {
      if (!ids.has(id)) { m.stop(); this.monitors.delete(id); this.latest.delete(id); }
    }
    for (const cfg of cfgs) {
      let m = this.monitors.get(cfg.id);
      if (m && JSON.stringify(m.cfg) !== JSON.stringify(cfg)) { m.stop(); m = undefined; }
      if (!m) {
        m = new Monitor(cfg, {
          getPassword: async (id) => this.ctx.secrets.get(`yomo.pw.${id}`),
          getHostKey: (k) => this.ctx.globalState.get<Record<string, string>>('yomo.hostKeys', {})[k],
          setHostKey: (k, fp) => {
            const all = this.ctx.globalState.get<Record<string, string>>('yomo.hostKeys', {});
            void this.ctx.globalState.update('yomo.hostKeys', { ...all, [k]: fp });
          },
          intervalMs: () => Math.max(1, vscode.workspace.getConfiguration('yomo').get<number>('refreshInterval', 3)) * 1000,
          onUpdate: (id, status, stats) => {
            const snap = { status, stats: stats ?? this.latest.get(id)?.stats };
            this.latest.set(id, snap);
            this.view?.webview.postMessage({ type: 'update', id, ...snap });
          },
        });
        this.monitors.set(cfg.id, m);
      }
      if (this.active) m.start(); else m.stop();
    }
    this.pushAll();
  }

  reconnectAll() {
    for (const m of this.monitors.values()) m.restart();
  }

  dispose() {
    for (const m of this.monitors.values()) m.stop();
  }

  private pushAll() {
    this.view?.webview.postMessage({ type: 'servers', servers: this.servers().map(({ id, name }) => ({ id, name })) });
    for (const [id, snap] of this.latest) this.view?.webview.postMessage({ type: 'update', id, ...snap });
  }

  private openTerminal(id: string) {
    const c = this.servers().find((s) => s.id === id);
    if (!c) return;
    const args = ['-p', String(c.port ?? 22)];
    if (c.auth === 'key' && c.keyPath) args.push('-i', c.keyPath);
    args.push(`${c.username}@${c.host}`);
    const t = vscode.window.createTerminal({ name: c.name, shellPath: 'ssh', shellArgs: args });
    t.show();
  }

  private async remove(id: string) {
    const c = this.servers().find((s) => s.id === id);
    if (!c) return;
    const ok = await vscode.window.showWarningMessage(`Remove "${c.name}"?`, { modal: true }, 'Remove');
    if (ok !== 'Remove') return;
    const cfg = vscode.workspace.getConfiguration('yomo');
    await cfg.update('servers', this.servers().filter((s) => s.id !== id), vscode.ConfigurationTarget.Global);
    await this.ctx.secrets.delete(`yomo.pw.${id}`);
  }
}
