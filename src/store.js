// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known devices by unit id, their address, name
// and model, and the sources they have shown (the "Source" dropdown only
// grows). No secret: the StreamMagic websocket has none.
//
// The unit ids come from the network: the device table has no prototype, and
// a unit id that is not a plain identifier (`__proto__`, `constructor`...) is
// never a key.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LIMITS } from './constants.js';
import { cleanText, isSafeId } from './streammagic/parse.js';

export const emptyData = () => ({ devices: Object.create(null) });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function sanitizeOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of Array.isArray(options) ? options.slice(0, LIMITS.sources * 4) : []) {
    if (isObject(option) && isSafeId(option.value) && !seen.has(option.value)) {
      seen.add(option.value);
      result.push({
        value: option.value,
        label: cleanText(option.label, LIMITS.name) ?? option.value,
      });
    }
  }
  return result;
}

function sanitize(data) {
  const base = emptyData();
  if (!isObject(data) || !isObject(data.devices)) {
    return base;
  }
  for (const [unitId, device] of Object.entries(data.devices).slice(0, LIMITS.devices)) {
    if (!isSafeId(unitId) || !isObject(device) || device.unitId !== unitId) {
      continue;
    }
    base.devices[unitId] = {
      unitId,
      host: typeof device.host === 'string' ? device.host.slice(0, 253) : '',
      port:
        Number.isInteger(device.port) && device.port > 0 && device.port < 65536 ? device.port : 80,
      name: cleanText(device.name, LIMITS.name),
      model: cleanText(device.model, LIMITS.name),
      sourceOptions: sanitizeOptions(device.sourceOptions),
    };
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'cambridge-audio.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to
   * `cambridge-audio.json.bad` and `corrupted` is set, so the app says so
   * instead of silently starting over.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}

export { sanitize as sanitizeData };
