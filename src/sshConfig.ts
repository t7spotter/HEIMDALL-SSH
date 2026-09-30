import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface SshHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

/** Minimal ~/.ssh/config reader: concrete Host aliases and a few common keys. */
export function readSshConfig(): SshHost[] {
  let text: string;
  try {
    text = readFileSync(join(homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return [];
  }
  const hosts: SshHost[] = [];
  let group: SshHost[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\w+)\s*[=\s]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"|"$/g, '');
    if (key === 'host') {
      group = val.split(/\s+/).filter((a) => !/[*?!]/.test(a)).map((alias) => ({ alias }));
      hosts.push(...group);
    } else if (key === 'match') {
      group = [];
    } else {
      for (const h of group) {
        if (key === 'hostname') h.hostName ??= val;
        else if (key === 'user') h.user ??= val;
        else if (key === 'port') h.port ??= Number(val) || undefined;
        else if (key === 'identityfile') h.identityFile ??= val;
      }
    }
  }
  return hosts;
}
