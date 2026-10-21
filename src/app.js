// -----------------------------------------------------------------------------
// The integration: the StreamMagic devices it knows (typed addresses,
// optional mDNS search through Gladys), one persistent websocket per address
// (src/streammagic/link.js: pushed updates, reconnection spaced out), the
// Gladys devices built from them, the commands (validated before anything is
// sent, the volume capped by the configuration, serialized per device, each
// within the 5 s Gladys waits for its ack) and the configuration buttons.
// index.js only wires the SDK handlers to it (src/handlers.js).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import { DEFAULT_PORT, DEVICE_TYPE, FEATURES, LIMITS, TIMINGS } from './constants.js';
import { DeviceError, ERROR_KINDS } from './streammagic/connection.js';
import { COMMANDS, PATHS } from './streammagic/endpoints.js';
import { DeviceLink, identify as defaultIdentify } from './streammagic/link.js';
import { isSafeId, parsePlayState, parseSources, parseZoneState } from './streammagic/parse.js';
import { T } from './i18n.js';
import { buildDevice, deviceName, featureKey, sourceOptions, stateList } from './model.js';
import { FileStore, emptyData } from './store.js';

const BUTTONS = new Set([
  FEATURES.POWER_ON,
  FEATURES.STANDBY,
  FEATURES.MUTE,
  FEATURES.PLAY,
  FEATURES.PAUSE,
  FEATURES.NEXT,
  FEATURES.PREVIOUS,
]);

/**
 * Whether an address announced by mDNS may be connected to: an IPv4 address
 * of a local network (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 but
 * the cloud metadata address 169.254.169.254). Public, loopback, "this
 * network" (0/8), broadcast and multicast addresses are never asked. The
 * addresses typed by the user are not filtered: they are the user's choice.
 */
export function isLanAddress(host) {
  if (typeof host !== 'string' || isIP(host) !== 4) {
    return false;
  }
  const [a, b, c, d] = host.split('.').map(Number);
  // The metadata address, and the broadcast of a /24 or larger (x.x.x.255).
  if (host === '169.254.169.254' || d === 255 || (a === 255 && b === 255 && c === 255)) {
    return false;
  }
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/**
 * Commands that go before the ones waiting: quieting down never waits behind
 * the rest. Standby is not queued at all (see setValue).
 */
const URGENT = new Set([FEATURES.MUTE]);

/** Commands that can take a device out of standby: a Standby asked after them wins. */
const WAKES = new Set([
  FEATURES.POWER_ON,
  FEATURES.SOURCE,
  FEATURES.PLAY,
  FEATURES.NEXT,
  FEATURES.PREVIOUS,
]);

/** The volume the device gives back, at or under `cap`. */
const atOrUnder = (cap) => (zone) => Number.isInteger(zone.volume) && zone.volume <= cap;

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  let volume;
  if (typeof value === 'number') {
    volume = value;
  } else if (typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value)) {
    volume = Number(value);
  } else {
    return undefined;
  }
  return Number.isInteger(volume) && volume >= 0 && volume <= 100 ? volume : undefined;
}

/** Runs `task` over `items`, `limit` at a time, results in order. */
async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const short = (value) => String(value).slice(0, 32);

export class CambridgeAudioApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'cambridge-audio' }),
    store = new FileStore(),
    now = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    createSocket,
    identify = defaultIdentify,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.timings = timings;
    this.createSocket = createSocket;
    this.identifyAt = identify;
    this.config = normalizeConfig();
    this.data = undefined;
    /** addressKey -> DeviceLink */
    this.links = new Map();
    /** unitId -> tail of the command queue */
    this.queues = new Map();
    /** unitIds of the devices created in Gladys */
    this.created = new Set();
    /** The last `getDevices` failed: asked again at every round until it works. */
    this.createdStale = false;
    /** unitId -> timer of the grouped publication of its states */
    this.publishTimers = new Map();
    /** unitId -> { timer }: the one wake-up check chain of a device (after Power on) */
    this.wakeChecks = new Map();
    /** unitId -> until when a volume pushed above the cap is lowered (after Power on) */
    this.wakeWatch = new Map();
    /** unitIds whose volume is being lowered by watchWakeVolume */
    this.lowering = new Set();
    /** unitIds sent a Power on and not seen on since (within the wake-up window) */
    this.awaitingWake = new Set();
    /** unitId -> number of Standby asked (a waking command older than the last one is not sent) */
    this.standbySeq = new Map();
    this.scanning = undefined;
    this.lastAutoScan = -Infinity;
    this.generation = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration: on every connection to Gladys and on
   * every configuration save. The links to the devices are kept (a
   * reconnection to Gladys never drops them); what this app remembered as
   * "already published" is forgotten, since the core forgot it too.
   */
  async start(raw = {}, { connected = false } = {}) {
    this.config = normalizeConfig(raw);
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      try {
        this.data = await this.store.load();
      } catch {
        this.data = emptyData();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/cambridge-audio.json moved to cambridge-audio.json.bad');
      }
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    // A configuration save asks the silent links again (never sooner than the
    // base interval); a reconnection to Gladys does not: Gladys flapping must
    // never make the devices asked faster.
    await this.step('open the links', () => this.syncLinks({ retry: !connected }));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const link of this.links.values()) {
      link.stop();
    }
    this.links.clear();
    for (const handle of this.publishTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.publishTimers.clear();
    for (const unitId of [...this.wakeChecks.keys()]) {
      this.cancelWakeCheck(unitId);
    }
    this.wakeWatch.clear();
    this.awaitingWake.clear();
    if (this.persistTimer) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      return this.store.save(this.data).catch(() => {});
    }
    return Promise.resolve();
  }

  /** The background round: the created devices if unread, the automatic search, the status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(() => (this.createdStale ? this.refreshCreated() : undefined))
      .then(() => this.autoScan())
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  persist() {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /**
   * The command queue of one device: one command at a time. An `urgent`
   * command (mute) goes before the commands still waiting (after the other
   * urgent ones), never before the one already running.
   */
  enqueue(unitId, task, { urgent = false, wakes = false } = {}) {
    let queue = this.queues.get(unitId);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(unitId, queue);
    }
    return new Promise((resolve, reject) => {
      const item = { task, resolve, reject, urgent, wakes };
      if (urgent) {
        const index = queue.items.findIndex((i) => !i.urgent);
        queue.items.splice(index === -1 ? queue.items.length : index, 0, item);
      } else {
        queue.items.push(item);
      }
      this.drain(queue);
    });
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  /** The waking commands still waiting in the queue of a device: answered `err`, never run. */
  dropWaking(unitId, err) {
    const queue = this.queues.get(unitId);
    if (!queue) {
      return;
    }
    const dropped = queue.items.filter((item) => item.wakes);
    queue.items = queue.items.filter((item) => !item.wakes);
    dropped.forEach((item) => item.reject(err));
  }

  // --- Known devices -----------------------------------------------------------

  get devices() {
    return Object.values(this.data?.devices ?? {});
  }

  deviceOf(gladysDevice) {
    return this.devices.find(
      (d) => this.gladys.externalIds(DEVICE_TYPE, d.unitId).device === gladysDevice?.external_id,
    );
  }

  linkOf(device) {
    return device.host ? this.links.get(addressKey(device)) : undefined;
  }

  /** The link of `device` when it is connected to that very device, else undefined. */
  connectedLink(device) {
    const link = this.linkOf(device);
    return link?.connected && link.unitId === device.unitId ? link : undefined;
  }

  /**
   * What is known of a device: the link state when connected, null when it
   * does not answer (or its address is unknown), undefined when nothing is
   * known yet (first connection in progress).
   */
  deviceState(device) {
    if (!device.host) {
      return null;
    }
    const link = this.connectedLink(device);
    if (link) {
      return link.state;
    }
    // A connection just lost is not "off" yet: only a failed attempt says so.
    const current = this.linkOf(device);
    return current && current.lastError && !current.connected ? null : undefined;
  }

  /** One link per typed address and per known device address. */
  syncLinks({ retry = false } = {}) {
    if (!this.started) {
      return;
    }
    const wanted = new Map();
    for (const address of this.config.addresses) {
      wanted.set(addressKey(address), address);
    }
    for (const device of this.devices) {
      if (device.host) {
        wanted.set(addressKey(device), { host: device.host, port: device.port ?? DEFAULT_PORT });
      }
    }
    for (const [key, link] of this.links) {
      if (!wanted.has(key)) {
        link.stop();
        this.links.delete(key);
      }
    }
    for (const [key, address] of wanted) {
      const existing = this.links.get(key);
      if (existing) {
        if (retry) {
          existing.retrySoon();
        }
        continue;
      }
      const link = new DeviceLink({
        address,
        logger: this.logger,
        timings: this.timings,
        timers: this.timers,
        now: this.now,
        createSocket: this.createSocket,
        onEvent: (event, source, extra) => this.linkEvent(event, source, extra),
      });
      this.links.set(key, link);
      link.start();
    }
  }

  linkEvent(event, link, extra) {
    if (this.links.get(link.key) !== link) {
      return;
    }
    const address = { host: link.host, port: link.port };
    if (event === 'up') {
      const device = this.remember(link.state.info, link.state.sources, address);
      if (device) {
        this.logger.info(`${deviceName(device)} connected at ${link.key}`);
        this.syncLinks();
        this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
        this.schedulePublish(device.unitId, 0);
      }
    } else if (event === 'update') {
      const device = this.data.devices[link.unitId];
      if (!device || device.host !== link.host) {
        return;
      }
      if (extra === 'sources' && this.mergeSources(device, link.state.sources)) {
        this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
      }
      if (extra === 'info' && this.updateIdentity(device, link.state.info)) {
        this.publishDevices().catch(() => {});
      }
      if (extra === 'zone') {
        if (link.state.zone?.power === true) {
          this.awaitingWake.delete(device.unitId);
        }
        this.watchWakeVolume(device, link);
      }
      this.schedulePublish(device.unitId);
    } else if (event === 'failed') {
      // The device known at this address does not answer: power 0.
      for (const device of this.devices.filter(
        (d) => d.host === link.host && (d.port ?? DEFAULT_PORT) === link.port,
      )) {
        this.schedulePublish(device.unitId, 0);
      }
    }
    this.updateStatus().catch(() => {});
  }

  updateIdentity(device, info) {
    if (!info) {
      return false;
    }
    const before = deviceName(device);
    device.name = info.name ?? device.name;
    device.model = info.model ?? device.model;
    if (deviceName(device) !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  /**
   * Remembers the device answering at `address` by its unit id. Another
   * device that had this address lost it (DHCP): it is found again at its new
   * address, never commanded at one that is no longer its own.
   */
  remember(info, sources, address) {
    if (!info || !isSafeId(info.unitId)) {
      return undefined;
    }
    const table = this.data.devices;
    let device = Object.hasOwn(table, info.unitId) ? table[info.unitId] : undefined;
    if (!device) {
      if (Object.keys(table).length >= LIMITS.devices) {
        this.warnOnce('devices', `More than ${LIMITS.devices} devices: the next ones are ignored`);
        return undefined;
      }
      device = { unitId: info.unitId, host: '', port: DEFAULT_PORT, sourceOptions: [] };
      table[info.unitId] = device;
      this.persist();
    }
    for (const other of this.devices) {
      if (
        other.unitId !== device.unitId &&
        other.host === address.host &&
        (other.port ?? DEFAULT_PORT) === address.port
      ) {
        this.logger.warn(`${deviceName(other)} no longer answers at ${addressKey(address)}`);
        other.host = '';
        this.persist();
        this.schedulePublish(other.unitId, 0);
      }
    }
    if (device.host !== address.host || device.port !== address.port) {
      device.host = address.host;
      device.port = address.port;
      this.persist();
    }
    this.updateIdentity(device, info);
    this.mergeSources(device, sources);
    return device;
  }

  /** The dropdown only grows: a source no longer listed keeps its option. True when it grew. */
  mergeSources(device, sources) {
    if (!Array.isArray(sources)) {
      return false;
    }
    const options = sourceOptions(device);
    let changed = false;
    for (const source of sources) {
      const option = options.find((o) => o.value === source.id);
      if (option) {
        if (option.label !== source.name) {
          option.label = source.name;
          changed = true;
        }
      } else if (options.length < LIMITS.sources) {
        options.push({ value: source.id, label: source.name });
        changed = true;
      } else {
        this.warnOnce(`sources:${device.unitId}`, `${deviceName(device)}: too many sources`);
      }
    }
    if (changed) {
      device.sourceOptions = options;
      this.persist();
    }
    return changed;
  }

  /**
   * The source options of the device created in Gladys (`gladys.devices`,
   * kept up to date by the SDK), merged into the known device: options seen
   * before a reset of /data are never dropped from the created device.
   */
  mergeCreatedOptions(device) {
    const externalId = this.gladys.externalIds(DEVICE_TYPE, device.unitId).device;
    const created = (Array.isArray(this.gladys.devices) ? this.gladys.devices : []).find(
      (d) => d?.external_id === externalId,
    );
    const feature = (Array.isArray(created?.features) ? created.features : []).find(
      (f) => f?.external_id === `${externalId}:${FEATURES.SOURCE}`,
    );
    const options = Array.isArray(feature?.supported_options) ? feature.supported_options : [];
    const options_ = sourceOptions(device);
    let changed = false;
    for (const option of options) {
      if (
        isSafeId(option?.value) &&
        !options_.some((o) => o.value === option.value) &&
        options_.length < LIMITS.sources
      ) {
        options_.push({
          value: option.value,
          label:
            typeof option.label === 'string' ? option.label.slice(0, LIMITS.name) : option.value,
        });
        changed = true;
      }
    }
    if (changed) {
      device.sourceOptions = options_;
      this.persist();
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const devices = this.devices;
    devices.forEach((device) => this.mergeCreatedOptions(device));
    await this.gladys.publishDiscoveredDevices(devices.map((d) => buildDevice(this.gladys, d)));
  }

  /**
   * The devices created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works.
   */
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    const byExternalId = new Map(
      this.devices.map((d) => [this.gladys.externalIds(DEVICE_TYPE, d.unitId).device, d.unitId]),
    );
    this.created = new Set(
      (Array.isArray(list) ? list : [])
        .map((d) => byExternalId.get(d?.external_id))
        .filter(Boolean),
    );
  }

  // --- States --------------------------------------------------------------------

  /** The states of a device, grouped: at most one publication per `publishDelay`. */
  schedulePublish(unitId, delay = this.timings.publishDelay) {
    if (this.publishTimers.has(unitId)) {
      if (delay > 0) {
        return;
      }
      this.timers.clearTimeout(this.publishTimers.get(unitId));
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.publishTimers.delete(unitId);
      if (generation !== this.generation) {
        return;
      }
      const device = this.data?.devices?.[unitId];
      if (device) {
        this.publishStates(device).catch(() => {});
      }
    }, delay);
    this.publishTimers.set(unitId, handle);
  }

  async publishStates(device) {
    if (!this.created.has(device.unitId)) {
      return;
    }
    const states = stateList(this.gladys, device, this.deviceState(device));
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(`Could not publish the states of ${deviceName(device)}: ${err.message}`);
    }
  }

  async publishAllStates() {
    for (const device of this.devices) {
      await this.publishStates(device);
    }
  }

  // --- Search ----------------------------------------------------------------------

  /**
   * The optional mDNS search through Gladys, then the typed addresses. One
   * search at a time (a second request joins the running one); the answers
   * are asked `scanConcurrency` at a time, none started after `scanBudget`.
   */
  scan() {
    if (!this.scanning) {
      this.scanning = this.runScan().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  async runScan() {
    const deadline = this.now() + this.timings.scanBudget;
    const generation = this.generation;
    const stopped = () => generation !== this.generation || !this.data;
    let results = [];
    try {
      results = await this.gladys.scanNetwork('mdns', { timeoutSeconds: this.timings.scanSeconds });
    } catch (err) {
      // Optional: the typed addresses work without it.
      this.logger.warn(`mDNS search failed: ${err.message}`);
    }
    const seen = new Set([...this.links.values()].filter((l) => l.connected).map((l) => l.host));
    const candidates = [];
    for (const result of (Array.isArray(results) ? results : []).slice(0, 50)) {
      // The websocket is on port 80, whatever port the announced service has.
      const hosts = (Array.isArray(result?.addresses) ? result.addresses : [])
        .filter((h) => isLanAddress(h) && !seen.has(h))
        .slice(0, 4);
      hosts.forEach((h) => seen.add(h));
      if (hosts.length > 0) {
        candidates.push(hosts);
      }
    }
    let changed = false;
    await mapLimit(candidates, this.timings.scanConcurrency, async (hosts) => {
      for (const host of hosts) {
        if (this.now() >= deadline || stopped()) {
          return;
        }
        const address = { host, port: DEFAULT_PORT };
        try {
          const { info, sources } = await this.identifyAt({
            address,
            timings: this.timings,
            createSocket: this.createSocket,
          });
          if (!stopped() && this.remember(info, sources, address)) {
            changed = true;
          }
          return;
        } catch (err) {
          this.logger.debug?.(`${host} is not a StreamMagic device: ${err.message}`);
        }
      }
    });
    if (stopped()) {
      return this.devices;
    }
    this.syncLinks({ retry: true });
    if (changed || candidates.length > 0) {
      await this.publishDevices();
    }
    return this.devices;
  }

  /** The created devices whose address is unknown (lost to another device). */
  lostDevices() {
    return this.devices.filter((d) => this.created.has(d.unitId) && !d.host);
  }

  /** While a created device has no address: a search every `autoScanInterval`. */
  autoScan() {
    if (!this.started || this.lostDevices().length === 0) {
      return;
    }
    if (this.now() - this.lastAutoScan < this.timings.autoScanInterval) {
      return;
    }
    this.lastAutoScan = this.now();
    const generation = this.generation;
    this.scan()
      .then(() => (generation === this.generation ? this.updateStatus() : undefined))
      .catch((err) => this.logger.warn(`Automatic search failed: ${err.message}`));
  }

  // --- Commands --------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(device, key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error(`Invalid volume "${short(value)}": an integer from 0 to 100`);
      }
      return volume;
    }
    if (key === FEATURES.SOURCE) {
      if (typeof value !== 'string' || !sourceOptions(device).some((o) => o.value === value)) {
        throw new Error(`Unknown source "${short(value)}"`);
      }
      return value;
    }
    if (BUTTONS.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  async setValue(gladysDevice, feature, value) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      throw new Error(`Unknown device ${short(gladysDevice?.external_id)}`);
    }
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const checked = this.validate(device, key, value);
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    let late = false;
    // A Standby asked after this command arrived wins: a command that can
    // wake the device is then not sent (checked when its turn comes, and
    // again right before each of its messages leaves).
    const seq = this.standbySeq.get(device.unitId) ?? 0;
    const context = {
      // Set just before a command message leaves: from then on, it may have
      // reached the device, whatever happens next.
      mayHaveSent: false,
      shouldSend: () => !WAKES.has(key) || (this.standbySeq.get(device.unitId) ?? 0) === seq,
    };
    let run;
    if (key === FEATURES.STANDBY) {
      // Standby never waits: not behind the command running (a read, a
      // confirmation), nor behind the waking commands still queued, which it
      // cancels. The volume checks after a wake-up go on: they only lower
      // the volume of a device that says it is on (one that ignored the
      // Standby while waking up stays capped).
      this.standbySeq.set(device.unitId, seq + 1);
      this.dropWaking(device.unitId, this.cancelled(device));
      run = this.command(device, key, checked, started, context);
    } else {
      run = this.enqueue(
        device.unitId,
        async () => {
          if (!context.shouldSend()) {
            throw this.cancelled(device);
          }
          if (late || this.remaining(started) < 50) {
            // Gladys stopped waiting while this command was queued: dropped, never sent late.
            late = true;
            throw new DeviceError(
              ERROR_KINDS.BUDGET,
              'No time left for this command, nothing sent',
            );
          }
          return this.command(device, key, checked, started, context);
        },
        { urgent: URGENT.has(key), wakes: WAKES.has(key) },
      );
    }
    // Wall-clock deadline (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          reject(
            context.mayHaveSent
              ? new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
                  sent: true,
                })
              : new DeviceError(
                  ERROR_KINDS.BUDGET,
                  'No time left for this command (device busy), nothing sent',
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /** A Power on was sent within the wake-up window, and the device has not said it is on since. */
  wakingUp(unitId) {
    if (!this.awaitingWake.has(unitId)) {
      return false;
    }
    if (!((this.wakeWatch.get(unitId) ?? -Infinity) >= this.now())) {
      this.awaitingWake.delete(unitId);
      return false;
    }
    return true;
  }

  cancelled(device) {
    return new DeviceError(
      ERROR_KINDS.CANCELLED,
      `${deviceName(device)}: cancelled by Standby, nothing sent`,
    );
  }

  /**
   * Whether the zone state the device gives confirms `check`: the state
   * known now, else the one read again, else one it pushes within `budget()`.
   * With `fresh`, only a zone state received from now on counts (never the
   * one known before the command). An answer `result: 200` alone never
   * confirms anything: a device may accept a message and ignore it.
   */
  async confirmZone(link, check, budget, { fresh = false } = {}) {
    const mark = link.zoneUpdates;
    const holds = (state) => (!fresh || link.zoneUpdates > mark) && check(state.zone ?? {});
    if (holds(link.state)) {
      return true;
    }
    if (budget() > 0) {
      await link.request(PATHS.ZONE_STATE, {}, budget()).catch(() => {});
      if (holds(link.state)) {
        return true;
      }
    }
    return link.waitState(holds, budget());
  }

  /**
   * Sends one command message and waits for its answer, then, with
   * `confirm`, for a zone state carrying the value asked. A message that may
   * have reached the device is never reported as "not sent": "sent, without
   * confirmation" (the pushed state shows what the device did).
   */
  async send(
    device,
    link,
    [path, params],
    started,
    context,
    { confirm, fresh = false, budget = () => this.remaining(started) - 100 } = {},
  ) {
    if (!context.shouldSend()) {
      throw this.cancelled(device);
    }
    context.mayHaveSent = true;
    let answer;
    try {
      answer = await link.request(path, params, this.remaining(started));
    } catch (err) {
      if (err.kind === ERROR_KINDS.TIMEOUT || err.kind === ERROR_KINDS.CLOSED) {
        throw new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
          sent: true,
        });
      }
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.BUDGET) {
        context.mayHaveSent = false;
        throw new DeviceError(
          err.kind,
          err.kind === ERROR_KINDS.BUDGET
            ? 'No time left for this command, nothing sent'
            : `${deviceName(device)} is not connected: nothing sent`,
        );
      }
      throw err;
    }
    if (confirm && !(await this.confirmZone(link, confirm, budget, { fresh }))) {
      throw new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
        sent: true,
      });
    }
    return answer;
  }

  /** A read made before a command message: whatever goes wrong, nothing was sent. */
  async readBefore(device, link, what, path, started) {
    const budget = Math.min(this.timings.preRead, this.remaining(started));
    try {
      return await link.request(path, {}, budget);
    } catch (err) {
      if (err.kind === ERROR_KINDS.UNREACHABLE) {
        throw new DeviceError(err.kind, `${deviceName(device)} is not connected: nothing sent`);
      }
      if (err.kind === ERROR_KINDS.REFUSED) {
        throw new DeviceError(err.kind, `${what} not readable (${err.message}): nothing sent`);
      }
      throw new DeviceError(ERROR_KINDS.BUDGET, `${what} not read in time: nothing sent`);
    }
  }

  async command(device, key, value, started, context) {
    const link = this.connectedLink(device);
    if (!link) {
      // Standby included: a device just disconnected may still be on, so
      // "already in standby" would be a guess. Nothing sent, said so.
      throw new DeviceError(
        ERROR_KINDS.UNREACHABLE,
        device.host
          ? `${deviceName(device)} is not connected (eco standby, off or unreachable): nothing sent`
          : `${deviceName(device)}: address unknown, run "Find the devices"`,
      );
    }
    const send = (message, options) => this.send(device, link, message, started, context, options);
    switch (key) {
      case FEATURES.POWER_ON: {
        // The checks of a previous press go on until this one may have left
        // (capAfterWake then starts them over): a press refused by a device
        // busy waking up never drops them.
        if (!context.shouldSend()) {
          throw this.cancelled(device);
        }
        // A volume pushed above the cap while the device wakes up is lowered
        // too (watchWakeVolume), until the end of the checks. Opened as the
        // message leaves (the pushes may come before its answer); when
        // nothing left or the device refused it, put back as it was.
        const unitId = device.unitId;
        const watchBefore = this.wakeWatch.get(unitId);
        const awaitingBefore = this.awaitingWake.has(unitId);
        this.wakeWatch.set(
          unitId,
          this.now() + this.timings.wakeChecks * this.timings.wakeCheckDelay,
        );
        this.awaitingWake.add(unitId);
        try {
          await send(COMMANDS.powerOn());
        } catch (err) {
          if (err.sent) {
            // Sent, not answered: it may be waking up, the checks run anyway.
            this.capAfterWake(device, 1);
          } else {
            if (watchBefore === undefined) {
              this.wakeWatch.delete(unitId);
            } else {
              this.wakeWatch.set(unitId, watchBefore);
            }
            if (!awaitingBefore) {
              this.awaitingWake.delete(unitId);
            }
          }
          throw err;
        }
        // Confirmed by `power: true` only, within the whole budget: a slow
        // wake-up is not an error. Not confirmed in time: the checks go on.
        const on = await this.confirmZone(
          link,
          (zone) => zone.power === true,
          () => this.remaining(started) - 100,
        );
        if (on) {
          this.awaitingWake.delete(unitId);
        } else {
          this.capAfterWake(device, 1);
          throw new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
            sent: true,
          });
        }
        // A device wakes up at the volume it had: brought back to the cap.
        // Within what is left of this command first, then in the background
        // while the device is still waking up. The ack never depends on it.
        // A Standby asked meanwhile never stops it: it only lowers.
        const done = await this.capVolume(device, link, () =>
          Math.min(this.timings.preRead, this.remaining(started) - 100),
        ).catch(() => false);
        if (!done) {
          this.capAfterWake(device, 1);
        }
        return undefined;
      }
      case FEATURES.STANDBY: {
        // Confirmed only by a zone state received after the command: never
        // by the one known before it.
        await send(COMMANDS.standby(), { confirm: (zone) => zone.power === false, fresh: true });
        // A device still waking up from a Power on (no `power: true` seen
        // since) says `power: false` too: not a confirmation of the Standby.
        if (this.wakingUp(device.unitId)) {
          throw new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
            sent: true,
          });
        }
        return undefined;
      }
      case FEATURES.VOLUME: {
        if (link.state.zone?.preAmp !== true) {
          throw new Error(
            `${deviceName(device)}: the volume is not controlled by this device (pre-amplifier off), nothing sent`,
          );
        }
        // The cap is read here, just before the message leaves: a
        // configuration saved while the command waited in the queue applies.
        const cap = this.config.maxVolume;
        const target = Math.min(value, cap);
        if (target < value) {
          this.logger.info(`${deviceName(device)}: volume ${value} capped to ${cap}`);
        }
        await send(COMMANDS.setVolume(target), { confirm: (zone) => zone.volume === target });
        return undefined;
      }
      case FEATURES.MUTE: {
        // Gladys sends a press, not a target: the mute is read from the
        // device just before, and the opposite is set explicitly (no toggle).
        const zone = parseZoneState(
          await this.readBefore(device, link, 'Mute state', PATHS.ZONE_STATE, started),
        );
        if (typeof zone?.mute !== 'boolean') {
          throw new Error(`${deviceName(device)}: mute state unknown, nothing sent`);
        }
        if (zone.mute && zone.preAmp === true) {
          // Unmuting never makes the device play above the cap: the volume
          // read with the mute decides, and is lowered first when above it.
          if (!Number.isInteger(zone.volume)) {
            throw new Error(`${deviceName(device)}: volume unknown, nothing sent`);
          }
          const cap = this.config.maxVolume;
          if (zone.volume > cap) {
            this.logger.info(
              `${deviceName(device)}: volume ${zone.volume} lowered to ${cap} before unmuting`,
            );
            // Unmuted only once the device gives back a volume at or under
            // the cap: a lowering it ignored keeps the mute.
            try {
              await send(COMMANDS.setVolume(cap), {
                confirm: atOrUnder(cap),
                budget: () => Math.min(this.timings.preRead, this.remaining(started) - 100),
              });
            } catch (err) {
              if (err.sent) {
                throw new DeviceError(
                  ERROR_KINDS.TIMEOUT,
                  `${deviceName(device)}: volume not lowered to the cap (sent, without confirmation), mute kept`,
                  { sent: true },
                );
              }
              throw err;
            }
          }
        }
        const mute = !zone.mute;
        await send(COMMANDS.setMute(mute), { confirm: (state) => state.mute === mute });
        return undefined;
      }
      case FEATURES.PLAY:
      case FEATURES.PAUSE:
        return this.playPause(device, link, key, send, started);
      case FEATURES.NEXT:
        await send(COMMANDS.next());
        return undefined;
      case FEATURES.PREVIOUS:
        await send(COMMANDS.previous());
        return undefined;
      case FEATURES.SOURCE: {
        // The source ids are read again: they belong to the device, not to Gladys.
        const sources = parseSources(
          await this.readBefore(device, link, 'Source list', PATHS.SOURCES, started),
        );
        if (!sources?.some((s) => s.id === value)) {
          throw new Error(
            `${deviceName(device)}: source "${value}" not available now, nothing sent`,
          );
        }
        await send(COMMANDS.setSource(value), { confirm: (zone) => zone.source === value });
        return undefined;
      }
      default:
        throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
  }

  /**
   * Play and pause, as Home Assistant does: the explicit action when the
   * source offers it, else the toggle, sent only after the play state read
   * again says it is needed (a toggle on a stale state would do the opposite).
   */
  async playPause(device, link, key, send, started) {
    const action = key === FEATURES.PLAY ? 'play' : 'pause';
    const controls = link.state.nowPlaying?.controls ?? [];
    if (controls.includes(action) || !controls.includes('play_pause')) {
      await send(COMMANDS[action]());
      return undefined;
    }
    const play = parsePlayState(
      await this.readBefore(device, link, 'Play state', PATHS.PLAY_STATE, started),
    );
    const state = play?.state;
    // The toggle only from a state where it surely does what was asked:
    // Play from pause or stop, Pause from play. Already as asked: nothing to
    // send. Anything else (connecting, buffering, ready, NETWORK, unknown):
    // refused, the toggle could do anything.
    const toggleFrom = action === 'play' ? ['pause', 'stop'] : ['play'];
    const nothingFrom = action === 'play' ? ['play'] : ['pause', 'stop'];
    if (nothingFrom.includes(state)) {
      return undefined;
    }
    if (!toggleFrom.includes(state)) {
      throw new Error(`${deviceName(device)}: play state ${state ?? 'unknown'}, nothing sent`);
    }
    await send(COMMANDS.toggle());
    return undefined;
  }

  /**
   * Reads `/zone/state` and lowers the volume to the cap when the device is
   * on, controls its volume and is above the cap. True when settled (lowered,
   * or nothing to lower), false when the device cannot tell yet (waking up)
   * or did not confirm the lowering (the checks go on). `alive` false stops it.
   */
  async capVolume(device, link, budget, alive = () => true) {
    if (budget() <= 0 || !link.connected || !alive()) {
      return false;
    }
    const zone = parseZoneState(await link.request(PATHS.ZONE_STATE, {}, budget()));
    if (zone?.power !== true) {
      return false;
    }
    if (zone.preAmp !== true) {
      return true;
    }
    if (!Number.isInteger(zone.volume)) {
      return false;
    }
    const cap = this.config.maxVolume;
    if (zone.volume <= cap) {
      return true;
    }
    if (budget() <= 0 || !alive()) {
      return false;
    }
    this.logger.info(`${deviceName(device)}: woke up at volume ${zone.volume}, lowered to ${cap}`);
    await link.request(...COMMANDS.setVolume(cap), budget());
    // Settled only on the volume the device gives back, never on the answer alone.
    return this.confirmZone(link, atOrUnder(this.config.maxVolume), budget);
  }

  /**
   * A volume pushed above the cap while a device wakes up (within the window
   * of the checks after a Power on sent by Gladys; a Standby does not close
   * it, a device that ignored it while waking up stays capped):
   * lowered through the device queue, one at a time per device.
   */
  watchWakeVolume(device, link) {
    const unitId = device.unitId;
    const until = this.wakeWatch.get(unitId);
    if (until === undefined || this.lowering.has(unitId)) {
      return;
    }
    if (this.now() > until) {
      this.wakeWatch.delete(unitId);
      return;
    }
    const zone = link.state.zone;
    if (zone?.power !== true || zone.preAmp !== true || !(zone.volume > this.config.maxVolume)) {
      return;
    }
    const watching = () => (this.wakeWatch.get(unitId) ?? -Infinity) >= this.now();
    this.lowering.add(unitId);
    this.enqueue(unitId, () => {
      const current = this.connectedLink(device);
      return current && watching()
        ? this.capVolume(device, current, () => this.timings.preRead, watching)
        : false;
    })
      .catch(() => false)
      .finally(() => this.lowering.delete(unitId));
  }

  /** Cancels the wake-up check chain of a device, if any. */
  cancelWakeCheck(unitId) {
    const chain = this.wakeChecks.get(unitId);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      this.wakeChecks.delete(unitId);
    }
  }

  /**
   * After a Power on: the cap checked again every `wakeCheckDelay`,
   * `wakeChecks` times at most. One chain per device: a new chain (another
   * Power on) replaces the running one, which stops at its next step. The
   * delay is longer than `staleAnswer`: a check that timed out never makes
   * the next one drop its answer.
   */
  capAfterWake(device, attempt, chain = { timer: undefined }) {
    if (attempt === 1) {
      this.cancelWakeCheck(device.unitId);
      this.wakeChecks.set(device.unitId, chain);
    }
    const current = () => this.wakeChecks.get(device.unitId) === chain;
    if (attempt > this.timings.wakeChecks) {
      this.wakeChecks.delete(device.unitId);
      this.logger.info(`${deviceName(device)}: volume not confirmed after waking up`);
      return;
    }
    const generation = this.generation;
    chain.timer = this.timers.setTimeout(() => {
      if (generation !== this.generation || !current()) {
        return;
      }
      this.enqueue(device.unitId, async () => {
        const link = this.connectedLink(device);
        if (!link || !current()) {
          return !current();
        }
        return this.capVolume(device, link, () => this.timings.preRead, current);
      })
        .catch(() => false)
        .then((done) => {
          if (!current()) {
            return;
          }
          if (done) {
            this.wakeChecks.delete(device.unitId);
          } else {
            this.capAfterWake(device, attempt + 1, chain);
          }
        });
    }, this.timings.wakeCheckDelay);
  }

  // --- Device lifecycle --------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (!device) {
      return;
    }
    this.created.add(device.unitId);
    // The SDK forgot what was published for this device: everything again.
    await this.publishStates(device);
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    const device = this.deviceOf(gladysDevice);
    if (device) {
      this.created.delete(device.unitId);
      await this.updateStatus();
    }
  }

  // --- Configuration screen buttons -------------------------------------------------

  async findDevices() {
    const devices = await this.scan();
    await this.updateStatus();
    return T.found(devices.map((d) => `${deviceName(d)} (${d.host || '?'})`));
  }

  async checkDevices() {
    if (this.devices.length === 0) {
      return T.noDevice;
    }
    const lines = this.devices.map((device) =>
      T.checkLine(
        `${deviceName(device)} (${device.host || '?'})`,
        this.connectedLink(device)?.state,
      ),
    );
    return T.check(lines, this.config.maxVolume);
  }

  // --- Status ---------------------------------------------------------------------

  /** The typed addresses where no device answers yet. */
  silentAddresses() {
    return this.config.addresses
      .filter(
        (a) => !this.devices.some((d) => d.host === a.host && (d.port ?? DEFAULT_PORT) === a.port),
      )
      .filter((a) => {
        const link = this.links.get(addressKey(a));
        return link && !link.connected && link.lastError;
      })
      .map(addressKey);
  }

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const notes = [];
    if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = this.silentAddresses();
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const lost = this.lostDevices();
    if (lost.length > 0) {
      notes.push(T.addressUnknown(lost.map(deviceName)));
    }
    const off = this.devices
      .filter((d) => this.created.has(d.unitId) && d.host && this.deviceState(d) === null)
      .map(deviceName);
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
