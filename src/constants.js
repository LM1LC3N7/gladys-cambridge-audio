// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <unit_id of the device>)`. */
export const DEVICE_TYPE = 'streammagic';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 in standby (or unreachable). */
  POWER: 'power',
  /** Push button: wakes the device up. */
  POWER_ON: 'power_on',
  /** Push button: puts the device in network standby. */
  STANDBY: 'standby',
  /** 0..100, capped by the `max_volume` option. */
  VOLUME: 'volume',
  /** Push button: each press sets the opposite of the mute read from the device. */
  MUTE: 'mute',
  PLAY: 'play',
  PAUSE: 'pause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  /** Read only: 1 playing, 0 otherwise. */
  PLAYBACK: 'playback',
  SOURCE: 'source',
  /** Read only: "Artist - Title" of what plays. */
  TITLE: 'title',
});

export const ACTIONS = Object.freeze({
  FIND: 'find_devices',
  CHECK: 'check_devices',
});

/** The mDNS services StreamMagic devices announce (the ones Home Assistant browses). */
export const MDNS_SERVICES = Object.freeze(['_stream-magic._tcp', '_smoip._tcp']);

/** The StreamMagic websocket listens on plain HTTP, path /smoip. */
export const DEFAULT_PORT = 80;
export const WS_PATH = '/smoip';

/** The zone every command addresses (the StreamMagic app does the same). */
export const ZONE = 'ZONE1';

/** The volume cap of the configuration, in percent. */
export const MAX_VOLUME = Object.freeze({ min: 1, max: 100, default: 50 });

export const TIMINGS = Object.freeze({
  /** Opening the websocket (TCP + HTTP upgrade). */
  connectTimeout: 5_000,
  /** One request while connecting (the snapshot of the device). */
  requestTimeout: 4_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * per-device queue and every request included) gets `commandBudget`, the
   * state read just before a mute press or a source change `preRead` of it.
   */
  commandBudget: 3_500,
  preRead: 1_500,
  /**
   * Reconnection: first after `reconnectBase`, then doubled each time up to
   * `reconnectMax`. The count is only reset by a connection that stayed up
   * `stableAfter`: a device that drops right after connecting is not asked
   * again every few seconds.
   */
  reconnectBase: 10_000,
  reconnectMax: 5 * 60_000,
  stableAfter: 60_000,
  /** A ping every `heartbeat`; no pong within `pongTimeout` closes the socket. */
  heartbeat: 30_000,
  pongTimeout: 10_000,
  /** The states of one device are published at most this often (a knob turned fast). */
  publishDelay: 1_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** The background round: status, automatic search, created devices read again. */
  tick: 30_000,
  /** mDNS listening time of a search. */
  scanSeconds: 5,
  /** No answer of a search is tried after this (counted from its start). */
  scanBudget: 35_000,
  scanConcurrency: 4,
  /** While a created device has lost its address, an automatic search this often. */
  autoScanInterval: 10 * 60_000,
  /** More messages than this within `floodWindow`: the socket is closed. */
  floodMessages: 300,
  floodWindow: 10_000,
});

export const LIMITS = Object.freeze({
  devices: 20,
  addresses: 20,
  /** Size of one websocket message. */
  messageBytes: 256 * 1024,
  /** Sources kept from one answer. */
  sources: 40,
  /** Requests waiting for an answer on one socket. */
  pending: 32,
  /** Length of a published title, and of a name. */
  title: 200,
  name: 64,
});

/** What a text feature shows when nothing plays. */
export const NOTHING = '—';
