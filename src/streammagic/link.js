// -----------------------------------------------------------------------------
// The persistent link with the device at one address: the websocket opened,
// the snapshot read (info, sources, zone state, play state, controls), the
// paths subscribed to, the pushed updates merged, a ping every 30 s, and the
// reconnection spaced out (10 s, then doubled each time up to 5 minutes; the
// count is only reset by a connection that stayed up a minute).
//
// The link knows nothing of Gladys: it reports to the app through `onEvent`
// ('up', 'update', 'down', 'failed').
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, TIMINGS } from '../constants.js';
import { DeviceError, ERROR_KINDS, openSession } from './connection.js';
import { PATHS, WATCHED, subscription } from './endpoints.js';
import {
  parseInfo,
  parseNowPlaying,
  parsePlayState,
  parseSources,
  parseZoneState,
} from './parse.js';

const PARSERS = {
  [PATHS.INFO]: ['info', parseInfo],
  [PATHS.SOURCES]: ['sources', parseSources],
  [PATHS.ZONE_STATE]: ['zone', parseZoneState],
  [PATHS.PLAY_STATE]: ['play', parsePlayState],
  [PATHS.NOW_PLAYING]: ['nowPlaying', parseNowPlaying],
};

export class DeviceLink {
  constructor({
    address,
    onEvent = () => {},
    logger,
    timings = TIMINGS,
    timers = globalThis,
    now = Date.now,
    createSocket,
  }) {
    this.host = address.host;
    this.port = address.port ?? DEFAULT_PORT;
    this.onEvent = onEvent;
    this.logger = logger;
    this.timings = timings;
    this.timers = timers;
    this.now = now;
    this.createSocket = createSocket;
    this.session = undefined;
    this.connecting = false;
    this.stopped = false;
    this.failures = 0;
    this.connectedAt = undefined;
    this.lastAttempt = -Infinity;
    this.retryTimer = undefined;
    this.heartbeatTimer = undefined;
    this.messages = [];
    /** The last error of a connection attempt (shown by "Check"). */
    this.lastError = undefined;
    this.state = {};
    /** The `waitState` calls waiting for a pushed state. */
    this.waiters = new Set();
    /** Zone states received (read or pushed): tells a fresh state from an older one. */
    this.zoneUpdates = 0;
  }

  get key() {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  get connected() {
    return Boolean(this.session?.open) && this.connectedAt !== undefined;
  }

  get unitId() {
    return this.state.info?.unitId;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopHeartbeat();
    const session = this.session;
    this.session = undefined;
    session?.close();
    this.releaseWaiters();
  }

  /**
   * Resolves true as soon as `check(state)` holds (now, or on a state the
   * device sends), false after `timeoutMs` or when the connection closes.
   */
  waitState(check, timeoutMs) {
    if (check(this.state)) {
      return Promise.resolve(true);
    }
    if (!this.connected || !(timeoutMs > 0)) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const waiter = { check, resolve, timer: undefined };
      waiter.timer = this.timers.setTimeout(() => this.release(waiter, false), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  release(waiter, value) {
    if (this.waiters.delete(waiter)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  }

  releaseWaiters() {
    for (const waiter of [...this.waiters]) {
      this.release(waiter, false);
    }
  }

  /**
   * A reconnection asked now (configuration saved, "Find" button): skips the
   * backoff, never the base interval since the last attempt.
   */
  retrySoon() {
    if (this.stopped || this.connected || this.connecting) {
      return;
    }
    const wait = Math.max(0, this.lastAttempt + this.timings.reconnectBase - this.now());
    this.schedule(wait);
  }

  schedule(ms) {
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.connect();
    }, ms);
  }

  backoff() {
    if (
      this.connectedAt !== undefined &&
      this.now() - this.connectedAt >= this.timings.stableAfter
    ) {
      this.failures = 0;
    }
    this.connectedAt = undefined;
    this.failures += 1;
    return Math.min(
      this.timings.reconnectMax,
      this.timings.reconnectBase * 2 ** Math.min(this.failures - 1, 16),
    );
  }

  async connect() {
    if (this.stopped || this.connecting || this.session) {
      return;
    }
    this.connecting = true;
    this.lastAttempt = this.now();
    let session;
    try {
      session = await openSession({
        host: this.host,
        port: this.port,
        timeoutMs: this.timings.connectTimeout,
        createSocket: this.createSocket,
        onMessage: (path, data) => this.receive(session, path, data),
        onClose: () => this.closed(session),
        onFrame: (source) => this.frame(source),
        staleMs: this.timings.staleAnswer,
      });
      if (this.stopped) {
        session.close();
        return;
      }
      this.session = session;
      await this.readSnapshot(session);
      for (const path of WATCHED) {
        session.send(path, subscription());
      }
      this.connectedAt = this.now();
      this.lastError = undefined;
      this.startHeartbeat(session);
      this.onEvent('up', this);
    } catch (err) {
      this.lastError = err;
      if (session) {
        // Opened, then not a usable StreamMagic device: closed, spaced out.
        this.session = undefined;
        session.onClose = undefined;
        session.close();
      }
      if (!this.stopped) {
        const delay = this.backoff();
        this.logger?.debug?.(`${this.key}: ${err.message}, next attempt in ${delay / 1000} s`);
        this.schedule(delay);
        this.onEvent('failed', this, err);
      }
    } finally {
      this.connecting = false;
    }
  }

  async readSnapshot(session) {
    const results = await Promise.all(
      WATCHED.map((path) =>
        session.request(path, {}, this.timings.requestTimeout).then(
          (data) => [path, data],
          (err) => {
            if (path === PATHS.INFO) {
              throw err;
            }
            // Another path a device does not know: its state stays unknown.
            return [path, undefined];
          },
        ),
      ),
    );
    const state = {};
    for (const [path, data] of results) {
      const [field, parse] = PARSERS[path];
      state[field] = data === undefined ? undefined : parse(data);
    }
    if (!state.info) {
      throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not a StreamMagic device (no unit id)');
    }
    this.state = state;
  }

  receive(session, path, data) {
    if (session !== this.session || !Object.hasOwn(PARSERS, path)) {
      return;
    }
    if (this.connectedAt === undefined) {
      // The snapshot is being read: its answers carry the same data.
      return;
    }
    const [field, parse] = PARSERS[path];
    const parsed = parse(data);
    if (parsed === undefined) {
      return;
    }
    if (field === 'info' && parsed.unitId !== this.state.info?.unitId) {
      // Another device at this address: a new connection reads it from scratch.
      session.close();
      return;
    }
    this.state = { ...this.state, [field]: parsed };
    if (field === 'zone') {
      this.zoneUpdates += 1;
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.check(this.state)) {
        this.release(waiter, true);
      }
    }
    this.onEvent('update', this, field);
  }

  /**
   * Every frame of the socket, counted before it is parsed: a device flooding
   * the socket (junk, unknown paths, binary frames included) is closed, then
   * asked again spaced out.
   */
  frame(session) {
    const now = this.now();
    this.messages.push(now);
    while (this.messages.length > 0 && now - this.messages[0] > this.timings.floodWindow) {
      this.messages.shift();
    }
    if (this.messages.length > this.timings.floodMessages) {
      this.logger?.warn?.(`${this.key}: too many messages, connection closed`);
      this.messages = [];
      session.close();
    }
  }

  closed(session) {
    if (session !== this.session) {
      return;
    }
    this.session = undefined;
    this.stopHeartbeat();
    this.releaseWaiters();
    if (this.stopped || this.connectedAt === undefined) {
      // Closed while connecting: connect() fails and spaces the next attempt.
      return;
    }
    const delay = this.backoff();
    this.schedule(delay);
    this.logger?.info?.(`${this.key}: connection lost, next attempt in ${delay / 1000} s`);
    this.onEvent('down', this);
  }

  startHeartbeat(session) {
    this.stopHeartbeat();
    session.lastPong = Date.now();
    this.heartbeatTimer = this.timers.setInterval(() => {
      if (session !== this.session) {
        return;
      }
      if (Date.now() - session.lastPong > this.timings.heartbeat + this.timings.pongTimeout) {
        this.logger?.info?.(`${this.key}: no answer to the ping, connection closed`);
        session.close();
        return;
      }
      session.ping();
    }, this.timings.heartbeat);
  }

  stopHeartbeat() {
    this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /** A request on the open session; UNREACHABLE (nothing sent) without one. */
  request(path, params, timeoutMs) {
    if (!this.connected) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    return this.session.request(path, params, timeoutMs);
  }
}

/**
 * Asks the device at `address` who it is, on a connection of its own closed
 * right after. Throws a DeviceError when nothing answers or it is not a
 * StreamMagic device.
 */
export async function identify({ address, timings = TIMINGS, createSocket }) {
  const session = await openSession({
    host: address.host,
    port: address.port ?? DEFAULT_PORT,
    timeoutMs: timings.connectTimeout,
    createSocket,
  });
  try {
    const [info, sources] = await Promise.all([
      session.request(PATHS.INFO, {}, timings.requestTimeout),
      session.request(PATHS.SOURCES, {}, timings.requestTimeout).catch(() => undefined),
    ]);
    const parsed = parseInfo(info);
    if (!parsed) {
      throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not a StreamMagic device (no unit id)');
    }
    return { info: parsed, sources: sources === undefined ? undefined : parseSources(sources) };
  } finally {
    session.close();
  }
}
