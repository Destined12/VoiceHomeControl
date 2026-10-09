export type ResolveDevice = {
  id: string;
  name: string;
  location: string;
  aliases: string | null;
  pin: string | null;
};

export type ResolvedCommand = {
  action: 'ON' | 'OFF' | 'UNKNOWN';
  device_id: string | null;
  device: string | null;
  pin: string | null;
};

function isSocketName(name: string) {
  return /socket|plug|outlet/i.test(name);
}

function deviceAliases(device: ResolveDevice): string[] {
  return [device.name, device.location, ...(device.aliases ?? '').split(',')]
    .map(alias => alias.trim().toLowerCase())
    .filter(Boolean);
}

export function resolveCommand(text: string, devices: ResolveDevice[]): ResolvedCommand {
  const normalized = text.toLowerCase();
  const action: 'ON' | 'OFF' | 'UNKNOWN' = /\b(on|turn on|switch on|activate)\b/.test(normalized)
    ? 'ON'
    : /\b(off|turn off|switch off|deactivate)\b/.test(normalized)
      ? 'OFF'
      : 'UNKNOWN';

  const matches = devices.filter(device => {
    const aliases = deviceAliases(device);
    return aliases.some(alias => normalized.includes(alias));
  });

  if (!matches.length || action === 'UNKNOWN') {
    return { action, device_id: null, device: null, pin: null };
  }

  const space = matches[0].location;
  const candidates = matches.filter(device => device.location === space);
  const wantsSocket = /\b(socket|plug|outlet)\b/.test(normalized);
  const preferred = candidates.filter(device => isSocketName(device.name) === wantsSocket);
  const picked = preferred[0] || candidates[0];

  return { action, device_id: picked.id, device: picked.name, pin: picked.pin };
}
