import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const REPO = 't7spotter/HEIMDALL-SSH';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const MAX_VSIX_BYTES = 50 * 1024 * 1024;

interface Release {
  tag_name: string;
  html_url: string;
  assets: { name: string; browser_download_url: string; digest?: string }[];
}

/** True when `a` is a newer x.y.z than `b`. */
function isNewer(a: string, b: string) {
  const n = (v: string) => v.replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'heimdall-ssh' } });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  return (await res.json()) as T;
}

async function download(ctx: vscode.ExtensionContext, rel: Release): Promise<string> {
  const asset = rel.assets.find((a) => a.name.endsWith('.vsix'));
  if (!asset) throw new Error('The release has no .vsix file attached');
  // Only ever fetch from this project's own releases.
  if (!asset.browser_download_url.startsWith(`https://github.com/${REPO}/releases/download/`)) {
    throw new Error('Unexpected download location');
  }
  const res = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'heimdall-ssh' } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_VSIX_BYTES) throw new Error('Download is unexpectedly large');
  const expected = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
  if (expected && createHash('sha256').update(buf).digest('hex') !== expected) {
    throw new Error('Checksum mismatch, download discarded');
  }
  const dir = ctx.globalStorageUri.fsPath;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, asset.name);
  writeFileSync(file, buf);
  return file;
}

export async function checkForUpdate(ctx: vscode.ExtensionContext) {
  const current: string = ctx.extension.packageJSON.version;
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Heimdall-SSH: checking for updates…' },
      async (progress) => {
        const rel = await getJson<Release>(`https://api.github.com/repos/${REPO}/releases/latest`);
        if (!isNewer(rel.tag_name, current)) return { latest: rel.tag_name, installed: false };
        progress.report({ message: `downloading ${rel.tag_name}…` });
        const file = await download(ctx, rel);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        return { latest: rel.tag_name, installed: true };
      },
    );
    if (!result.installed) {
      vscode.window.showInformationMessage(`Heimdall-SSH is up to date (v${current}).`);
      return;
    }
    const pick = await vscode.window.showInformationMessage(
      `Heimdall-SSH ${result.latest} is installed. Reload to start using it.`,
      'Reload Window',
    );
    if (pick === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    const pick = await vscode.window.showErrorMessage(`Heimdall-SSH update failed: ${(e as Error).message}`, 'Open Releases');
    if (pick === 'Open Releases') vscode.env.openExternal(vscode.Uri.parse(RELEASES_URL));
  }
}
