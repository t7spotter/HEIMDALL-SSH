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

/** The host answered, but not with stats: no shell (git host, forced-command account, ...). */
export class NoShellError extends Error {}

const LINUX = [
  'echo "##os"; (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -sr',
  'echo "##up"; cut -d" " -f1 /proc/uptime',
  'echo "##load"; cut -d" " -f1-3 /proc/loadavg',
  'echo "##cores"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo',
  'echo "##stat"; head -1 /proc/stat',
  'echo "##mem"; grep -E "^(MemTotal|MemAvailable):" /proc/meminfo',
  'echo "##df"; df -kP / | tail -1',
  'echo "##net"; cat /proc/net/dev',
  'echo "##io"; cat /proc/diskstats',
];

// macOS has no /proc, so the same sections are produced from sysctl, vm_stat, netstat and iostat.
// Load, memory, disk, network and I/O match Activity Monitor closely; CPU is the summed %cpu of all
// processes divided by core count, an approximation that avoids a one-second sampling delay.
const DARWIN = [
  'echo "##os"; echo "$(sw_vers -productName) $(sw_vers -productVersion)"',
  'echo "##up"; b=$(sysctl -n kern.boottime | sed "s/^[^0-9]*\\([0-9]*\\).*/\\1/"); echo $(( $(date +%s) - b ))',
  'echo "##load"; sysctl -n vm.loadavg | tr -d "{}" | awk \'{print $1, $2, $3}\'',
  'echo "##cores"; sysctl -n hw.ncpu',
  'echo "##cpu"; ps -A -o %cpu | awk -v n="$(sysctl -n hw.ncpu)" \'NR>1{s+=$1} END{printf "%.1f\\n", s/n}\'',
  'echo "##memb"; echo "$(sysctl -n hw.memsize) $(vm_stat | awk \'/page size of/{ps=$8} /^Pages free/{f=$3} /^Pages inactive/{i=$3} /^Pages speculative/{s=$3} END{printf "%d", (f+i+s)*ps}\')"',
  'echo "##df"; (df -kP /System/Volumes/Data 2>/dev/null || df -kP /) | tail -1',
  'echo "##netsum"; netstat -ib | awk \'$3 ~ /^<Link#/ && $1 ~ /^en/ { if (NF>=11) {rx+=$7; rp+=$5; tx+=$10; tp+=$8} else {rx+=$6; rp+=$4; tx+=$9; tp+=$7} } END{print rx+0, rp+0, tx+0, tp+0}\'',
  'echo "##iosum"; iostat -d -I 2>/dev/null | awk \'NR>2{for(i=1;i<=NF;i+=3){o+=$(i+1); m+=$(i+2)}} END{printf "%d %d\\n", o, m*1048576}\'',
];

/** POSIX sh script printing one "##section" per metric; run with `sh -c`, never in the login shell. */
export const SCRIPT = `if [ "$(uname -s)" = Darwin ]; then ${DARWIN.join('; ')}; else ${LINUX.join('; ')}; fi`;

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
  if (!sections.up && !sections.os) throw new NoShellError('no stats in output');
  const one = (k: string) => (sections[k]?.[0] ?? '').trim();

  const cpuFields = one('stat').split(/\s+/).slice(1, 9).map(Number);
  const cpuTotal = cpuFields.reduce((a, b) => a + b, 0);
  const cpuIdle = (cpuFields[3] || 0) + (cpuFields[4] || 0);
  const directCpu = sections.cpu ? Number(one('cpu')) : undefined; // macOS reports a percentage directly

  const mem: Record<string, number> = {};
  for (const l of sections.mem ?? []) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]) * 1024;
  }
  if (sections.memb) {
    const [total, avail] = one('memb').split(/\s+/).map(Number);
    mem.MemTotal = total || 0;
    mem.MemAvailable = avail || 0;
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

  if (sections.netsum) {
    const [r, rp, t, tp] = one('netsum').split(/\s+/).map(Number);
    rx = r || 0; rxPk = rp || 0; tx = t || 0; txPk = tp || 0;
  }

  let ioOps = 0, ioSectors = 0;
  for (const l of sections.io ?? []) {
    const f = l.trim().split(/\s+/);
    if (!WHOLE_DISK.test(f[2])) continue;
    ioOps += Number(f[3]) + Number(f[7]);
    ioSectors += Number(f[5]) + Number(f[9]);
  }

  if (sections.iosum) {
    const [ops, bytes] = one('iosum').split(/\s+/).map(Number);
    ioOps = ops || 0;
    ioSectors = (bytes || 0) / 512;
  }

  const sample: Sample = { t: now, cpuTotal, cpuIdle, rx, tx, rxPk, txPk, ioOps, ioSectors };

  let cpu = 0;
  let rates: Stats['rates'] = null;
  if (directCpu !== undefined) cpu = directCpu;
  if (prev && now > prev.t) {
    const dt = (now - prev.t) / 1000;
    const dTotal = cpuTotal - prev.cpuTotal;
    if (directCpu === undefined) cpu = dTotal > 0 ? (1 - (cpuIdle - prev.cpuIdle) / dTotal) * 100 : 0;
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
