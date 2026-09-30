import { Client, ConnectConfig } from 'ssh2';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { Sample, SCRIPT, Stats, parse } from './stats';

export interface ServerConfig {
  id: string;
  name: string;
  host: string;
  port?: number;
  username: string;
  auth?: 'agent' | 'key' | 'password';
  keyPath?: string;
}

export type Status = { state: 'connecting' | 'online' | 'error'; error?: string; latency?: number };

export interface MonitorDeps {
  getPassword(id: string): Promise<string | undefined>;
  getHostKey(hostPort: string): string | undefined;
  setHostKey(hostPort: string, fp: string): void;
  intervalMs(): number;
  onUpdate(id: string, status: Status, stats?: Stats): void;
}

const expand = (p: string) => (p.startsWith('~') ? homedir() + p.slice(1) : p);

export class Monitor {
  private client?: Client;
  private timer?: NodeJS.Timeout;
  private running = false;
  private busy = false;
  private prev?: Sample;
  private failures = 0;
  private gen = 0;

  constructor(readonly cfg: ServerConfig, private deps: MonitorDeps) {}

  start() {
    if (this.running) return;
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
    this.failures = 0;
    this.start();
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
          ? 'Host key rejected or changed (run "Yomo: Forget Saved Host Keys" if expected)'
          : e.message);
      })
      .on('close', () => this.fail(gen, 'Connection closed'))
      .connect(conn);
  }

  private poll(gen: number) {
    if (gen !== this.gen || !this.client || this.busy) return;
    this.busy = true;
    const started = Date.now();
    this.client.exec(SCRIPT, (err, stream) => {
      if (err) return this.fail(gen, err.message);
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
          return this.fail(gen, 'Could not parse server output');
        }
        this.timer = setTimeout(() => this.poll(gen), this.deps.intervalMs());
      });
    });
  }
}

