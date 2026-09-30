import { Client, ConnectConfig, utils } from 'ssh2';
import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { hostname } from 'os';
import { homedir } from 'os';
import { NoShellError, Sample, SCRIPT, Stats, parse } from './stats';

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  auth?: 'auto' | 'agent' | 'key' | 'password';
  keyPath?: string;
  /** Set for hosts discovered in ~/.ssh/config (not stored in settings). */
  sshAlias?: string;
  /** Monitor this machine directly instead of connecting over SSH. */
  local?: boolean;
}

export type Status = {
  state: 'connecting' | 'online' | 'error';
  error?: string;
  latency?: number;
  /** Host accepted the login but gave no shell (e.g. a git host); polling has stopped. */
  noShell?: boolean;
};

export interface MonitorDeps {
  getPassword(id: string): Promise<string | undefined>;
  getHostKey(hostPort: string): string | undefined;
  setHostKey(hostPort: string, fp: string): void;
  intervalMs(): number;
  onUpdate(id: string, status: Status, stats?: Stats): void;
}

export const localConfig = (): ServerConfig => ({
  id: 'local',
  name: `${hostname()} (this machine)`,
  host: 'localhost',
  username: '',
  local: true,
});

/** Single-quote for POSIX sh, so the script runs in sh even if the login shell is fish/csh. */
const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const expand = (p: string) => (p.startsWith('~') ? homedir() + p.slice(1) : p);

export class Monitor {
  private client?: Client;
  private timer?: NodeJS.Timeout;
  private running = false;
  private busy = false;
  private prev?: Sample;
  private failures = 0;
  private gen = 0;
  private blocked = false;

  constructor(readonly cfg: ServerConfig, private deps: MonitorDeps) {}

  start() {
    if (this.running || this.blocked) return;
    this.running = true;
    void this.connect();
  }

  stop() {
    this.running = false;
    this.gen++;
    clearTimeout(this.timer);
    this.client?.end();
    this.client = undefined;
    this.prev = undefined;
  }

  restart() {
    this.stop();
    this.blocked = false;
    this.failures = 0;
    this.start();
  }

  private noShell() {
    this.blocked = true;
    this.stop();
    this.deps.onUpdate(this.cfg.id, { state: 'error', error: 'Accepts SSH but provides no shell (git host?)', noShell: true });
  }

  private fail(gen: number, err: string) {
    if (gen !== this.gen) return;
    this.gen++; // ignore late events (e.g. 'close' after 'error') from this connection
    this.client?.destroy();
    this.client = undefined;
    this.prev = undefined;
    this.busy = false;
    clearTimeout(this.timer);
    this.failures++;
    this.deps.onUpdate(this.cfg.id, { state: 'error', error: err });
    const delay = Math.min(30_000, 3_000 * this.failures);
    this.timer = setTimeout(() => this.running && void this.connect(), delay);
  }

  private async connect() {
    const gen = ++this.gen;
    const { cfg } = this;
    if (cfg.local) {
      this.failures = 0;
      return void this.poll(gen);
    }
    this.deps.onUpdate(cfg.id, { state: 'connecting' });

    const port = cfg.port ?? 22;
    const hostPort = `${cfg.host}:${port}`;
    const conn: ConnectConfig = {
      host: cfg.host,
      port,
      username: cfg.username,
      readyTimeout: 15_000,
      keepaliveInterval: 10_000,
      hostHash: 'sha256',
      hostVerifier: (fp: string) => {
        const known = this.deps.getHostKey(hostPort);
        if (!known) { this.deps.setHostKey(hostPort, fp); return true; }
        return known === fp;
      },
    };

    try {
      const auth = cfg.auth ?? 'agent';
      if (auth === 'password') {
        conn.password = await this.deps.getPassword(cfg.id);
        if (!conn.password) throw new Error('No saved password');
      } else if (auth === 'auto') {
        // Mirror what `ssh` does without a config entry: agent plus default key files.
        conn.agent = process.env.SSH_AUTH_SOCK;
        for (const f of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
          const p = expand(`~/.ssh/${f}`);
          if (!existsSync(p)) continue;
          const buf = readFileSync(p);
          if (!(utils.parseKey(buf) instanceof Error)) { conn.privateKey = buf; break; } // skips passphrase-protected keys
        }
        if (!conn.agent && !conn.privateKey) throw new Error('No ssh-agent or unencrypted default key found');
      } else if (auth === 'key') {
        conn.privateKey = readFileSync(expand(cfg.keyPath ?? '~/.ssh/id_ed25519'));
      } else {
        conn.agent = process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
        if (!conn.agent) throw new Error('SSH_AUTH_SOCK is not set');
      }
    } catch (e) {
      return this.fail(gen, (e as Error).message);
    }
    if (gen !== this.gen) return;

    const client = new Client();
    this.client = client;
    client
      .on('ready', () => {
        if (gen !== this.gen) return;
        this.failures = 0;
        void this.poll(gen);
      })
      .on('error', (e) => {
        const hostKeyRejected = /host denied|handshake failed/i.test(e.message);
        this.fail(gen, hostKeyRejected
          ? 'Host key rejected or changed (run "Heimdall-SSH: Forget Saved Host Keys" if expected)'
          : e.message);
      })
      .on('close', () => this.fail(gen, 'Connection closed'))
      .connect(conn);
  }

  private pollLocal(gen: number) {
    this.busy = true;
    execFile('sh', ['-c', SCRIPT], { timeout: 10_000 }, (err, out) => {
      if (gen !== this.gen) return;
      this.busy = false;
      if (err) return this.fail(gen, err.message);
      try {
        const { stats, sample } = parse(out, this.prev, Date.now());
        this.prev = sample;
        this.deps.onUpdate(this.cfg.id, { state: 'online' }, stats);
      } catch {
        return this.fail(gen, 'Could not parse local stats');
      }
      this.timer = setTimeout(() => this.poll(gen), this.deps.intervalMs());
    });
  }

  private poll(gen: number) {
    if (gen !== this.gen || this.busy) return;
    if (this.cfg.local) return this.pollLocal(gen);
    if (!this.client) return;
    this.busy = true;
    const started = Date.now();
    this.client.exec(`sh -c ${shQuote(SCRIPT)}`, (err, stream) => {
      // The server refused to run a command at all: a git host or restricted account, not a general server.
      if (err) return /unable to exec/i.test(err.message) ? this.noShell() : this.fail(gen, err.message);
      let out = '';
      stream.on('data', (d: Buffer) => (out += d.toString()));
      stream.stderr.on('data', () => {});
      stream.on('close', () => {
        if (gen !== this.gen) return;
        this.busy = false;
        const now = Date.now();
        try {
          const { stats, sample } = parse(out, this.prev, now);
          this.prev = sample;
          this.deps.onUpdate(this.cfg.id, { state: 'online', latency: now - started }, stats);
        } catch (e) {
          if (e instanceof NoShellError) return this.noShell();
          return this.fail(gen, 'Could not parse server output');
        }
        this.timer = setTimeout(() => this.poll(gen), this.deps.intervalMs());
      });
    });
  }
}

