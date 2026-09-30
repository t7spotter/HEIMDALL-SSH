export interface Stats {
  os: string;
  uptime: number;
  cores: number;
  cpu: number;
  memPct: number;
  memTotal: number;
  load: [number, number, number];
  diskPct: number;
  diskTotal: number;
  /** Rates; null until a second sample exists. */
  rates: null | { rx: number; tx: number; rxPk: number; txPk: number; ioBps: number; iops: number };
}

/** Cumulative counters from one poll; rates are derived from two of these. */
export interface Sample {
  t: number;
  cpuTotal: number;
  cpuIdle: number;
  rx: number;
  tx: number;
  rxPk: number;
  txPk: number;
  ioOps: number;
  ioSectors: number;
}

export const SCRIPT = [
  'echo "##os"; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr',
  'echo "##up"; cut -d" " -f1 /proc/uptime',
  'echo "##load"; cut -d" " -f1-3 /proc/loadavg',
  'echo "##cores"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
  'echo "##stat"; head -1 /proc/stat',
  'echo "##mem"; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo',
  'echo "##df"; df -kP / | tail -1',
  'echo "##net"; cat /proc/net/dev',
  'echo "##io"; cat /proc/diskstats',
].join('; ');

const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function parse(out: string, prev: Sample | undefined, now: number): { stats: Stats; sample: Sample } {
  const sections: Record<string, string[]> = {};
  let cur = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('##')) {
      cur = line.slice(2).trim();
      sections[cur] = [];
    } else if (cur && line.trim()) {
      sections[cur].push(line);
    }
  }
  const one = (k: string) => (sections[k]?.[0] ?? '').trim();

  const cpuFields = one('stat').split(/\s+/).slice(1, 9).map(Number);
  const cpuTotal = cpuFields.reduce((a, b) => a + b, 0);
  const cpuIdle = (cpuFields[3] || 0) + (cpuFields[4] || 0);

  const mem: Record<string, number> = {};
  for (const l of sections.mem ?? []) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  const memTotal = mem.MemTotal || 0;
  const memPct = memTotal ? ((memTotal - (mem.MemAvailable ?? 0)) / memTotal) * 100 : 0;

  const df = one('df').split(/\s+/);
  const dfUsed = Number(df[2]) || 0;
  const dfAvail = Number(df[3]) || 0;
  const diskPct = dfUsed + dfAvail ? (dfUsed / (dfUsed + dfAvail)) * 100 : 0;
  const diskTotal = (Number(df[1]) || 0) * 1024;

  let rx = 0, tx = 0, rxPk = 0, txPk = 0;
  for (const l of sections.net ?? []) {
    const m = l.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m || m[1] === 'lo') continue;
    const f = m[2].split(/\s+/).map(Number);
    rx += f[0]; rxPk += f[1]; tx += f[8]; txPk += f[9];
  }

  let ioOps = 0, ioSectors = 0;
  for (const l of sections.io ?? []) {
    const f = l.trim().split(/\s+/);
    if (!WHOLE_DISK.test(f[2])) continue;
    ioOps += Number(f[3]) + Number(f[7]);
    ioSectors += Number(f[5]) + Number(f[9]);
  }

  const sample: Sample = { t: now, cpuTotal, cpuIdle, rx, tx, rxPk, txPk, ioOps, ioSectors };

  let cpu = 0;
  let rates: Stats['rates'] = null;
  if (prev && now > prev.t) {
    const dt = (now - prev.t) / 1000;
    const dTotal = cpuTotal - prev.cpuTotal;
    cpu = dTotal > 0 ? (1 - (cpuIdle - prev.cpuIdle) / dTotal) * 100 : 0;
    const r = (a: number, b: number) => Math.max(0, (a - b) / dt);
    rates = {
      rx: r(rx, prev.rx), tx: r(tx, prev.tx),
      rxPk: r(rxPk, prev.rxPk), txPk: r(txPk, prev.txPk),
      ioBps: r(ioSectors, prev.ioSectors) * 512,
      iops: r(ioOps, prev.ioOps),
    };
  }

  const load = one('load').split(/\s+/).map(Number);
  return {
    sample,
    stats: {
      os: one('os'),
      uptime: Number(one('up')) || 0,
      cores: Number(one('cores')) || 1,
      cpu: Math.min(100, Math.max(0, cpu)),
      memPct, memTotal,
      load: [load[0] || 0, load[1] || 0, load[2] || 0],
      diskPct, diskTotal,
      rates,
    },
  };
}
