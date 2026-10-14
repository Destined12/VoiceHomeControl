import { canonicalize } from './vocabulary';

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

function canonicalDeviceAliases(device: ResolveDevice): string[] {
  return deviceAliases(device).map(alias => canonicalize(alias)).filter(Boolean);
}

function matchDevices(
  text: string,
  devices: ResolveDevice[],
  aliasesOf: (device: ResolveDevice) => string[]
): ResolveDevice[] {
  return devices.filter(device => aliasesOf(device).some(alias => text.includes(alias)));
}

const ON_PATTERN = /\b(on|turn on|switch on|activate|enable|start|illuminate|energise)\b/;
const OFF_PATTERN = /\b(off|turn off|switch off|deactivate|disable|stop|extinguish|disconnect)\b/;
const SOCKET_PATTERN = /\b(socket|plug|outlet)\b/;

export function resolveCommand(text: string, devices: ResolveDevice[]): ResolvedCommand {
  const normalized = text.toLowerCase();
  // Canonical terms drive action and device-type detection so synonyms such as
  // "lounge light" or "power point" behave like their canonical counterparts.
  const canonical = canonicalize(text);

  const action: 'ON' | 'OFF' | 'UNKNOWN' = ON_PATTERN.test(canonical)
    ? 'ON'
    : OFF_PATTERN.test(canonical)
      ? 'OFF'
      : 'UNKNOWN';

  // Prefer matching the user's literal room/device wording first, then fall
  // back to canonical terms so user-defined spaces always win.
  let matches = matchDevices(normalized, devices, deviceAliases);
  if (!matches.length && canonical !== normalized) {
    matches = matchDevices(canonical, devices, canonicalDeviceAliases);
  }

  if (!matches.length || action === 'UNKNOWN') {
    return { action, device_id: null, device: null, pin: null };
  }

  const space = matches[0].location;
  const candidates = matches.filter(device => device.location === space);
  const wantsSocket = SOCKET_PATTERN.test(canonical);
  const preferred = candidates.filter(device => isSocketName(device.name) === wantsSocket);
  const picked = preferred[0] || candidates[0];

  return { action, device_id: picked.id, device: picked.name, pin: picked.pin };
}
