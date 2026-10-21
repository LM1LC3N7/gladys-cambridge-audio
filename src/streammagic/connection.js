// -----------------------------------------------------------------------------
// One websocket session with a StreamMagic device (`ws://<ip>/smoip`), the
// protocol of aiostreammagic (MIT, see THIRD_PARTY_NOTICES.md): every message
// is a JSON object `{ path, params }`; the device answers a request with
// `{ path, type: "response", result, message, params: { data } }` and pushes
// `{ path, params: { data } }` for every path subscribed with
// `{ update: 100, zone }`.
//
// Bounded: one message is 256 KB at most (the `ws` library closes the socket
// above), parsed once with JSON.parse, binary frames ignored, 32 requests at
// most waiting for an answer, each with its own timeout. No redirect is
// followed, no compression is negotiated.
// -----------------------------------------------------------------------------

import WebSocket from 'ws';
import { LIMITS, WS_PATH } from '../constants.js';
import { cleanText } from './parse.js';

export const ERROR_KINDS = Object.freeze({
  /** No socket: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Sent, no answer in time: the device may have done it. */
  TIMEOUT: 'timeout',
  /** The socket closed while the answer was awaited: the device may have done it. */
  CLOSED: 'closed',
  /** The device answered with an error result. */
  REFUSED: 'refused',
  /** Something answered, but not as a StreamMagic device. */
  PROTOCOL: 'protocol',
  /** No time left for the command: nothing was sent. */
  BUDGET: 'budget',
  /** Dropped before it left (a Standby asked after it): nothing was sent. */
  CANCELLED: 'cancelled',
});

export class DeviceError extends Error {
  constructor(kind, message, { sent = false } = {}) {
    super(message);
    this.name = 'DeviceError';
    this.kind = kind;
    this.sent = sent;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The default socket factory: the `ws` library (already a dependency of the SDK). */
export const createWebSocket = (url, options) => new WebSocket(url, options);

/**
 * Opens a session. Rejects with UNREACHABLE when nothing accepts the
 * connection in `timeoutMs`, PROTOCOL when something answers the HTTP
 * upgrade with anything but a websocket.
 */
export function openSession({
  host,
  port,
  timeoutMs,
  onMessage,
  onClose,
  onFrame,
  staleMs,
  createSocket = createWebSocket,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
      socket?.terminate?.();
    };
    try {
      socket = createSocket(`ws://${host}:${port}${WS_PATH}`, {
        handshakeTimeout: timeoutMs,
        maxPayload: LIMITS.messageBytes,
        perMessageDeflate: false,
        followRedirects: false,
        // As aiostreammagic: the device checks the origin of the upgrade.
        headers: { Origin: `ws://${host}`, Host: `${host}:${port}` },
      });
    } catch (err) {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `Cannot connect: ${err.message}`));
      return;
    }
    socket.once('unexpected-response', (_req, res) => {
      res?.resume?.();
      fail(
        new DeviceError(ERROR_KINDS.PROTOCOL, `Not a StreamMagic device (HTTP ${res?.statusCode})`),
      );
    });
    socket.once('error', (err) => {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `No connection (${err.code ?? err.message})`));
    });
    socket.once('open', () => {
      if (settled) {
        socket.terminate();
        return;
      }
      settled = true;
      resolve(new Session(socket, { onMessage, onClose, onFrame, staleMs }));
    });
  });
}

export class Session {
  constructor(socket, { onMessage, onClose, onFrame, staleMs = 2_000 } = {}) {
    this.socket = socket;
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.onFrame = onFrame;
    this.staleMs = staleMs;
    /** path -> until when the first answer on it is a late one (dropped) */
    this.stale = new Map();
    /** path -> [{ resolve, reject, timer }] */
    this.pending = new Map();
    this.pendingCount = 0;
    this.closed = false;
    this.lastPong = Date.now();
    socket.on('error', () => {
      // 'close' follows: handled there.
    });
    socket.on('message', (data, isBinary) => this.receive(data, isBinary));
    socket.on('pong', () => {
      this.lastPong = Date.now();
    });
    socket.on('close', () => this.closedByPeer());
  }

  get open() {
    return !this.closed && this.socket.readyState === WebSocket.OPEN;
  }

  receive(data, isBinary) {
    // Every frame is counted, before any parsing: a flood of junk, binary
    // frames or unknown paths is seen as a flood too.
    this.onFrame?.(this);
    if (this.closed || isBinary) {
      return;
    }
    let message;
    try {
      message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      return;
    }
    if (!isObject(message) || typeof message.path !== 'string' || message.path.length > 128) {
      return;
    }
    const { path } = message;
    if (message.type === 'response') {
      // The late answer of a request that timed out would settle the next
      // request on the same path with an old state: the first answer within
      // `staleMs` after a timeout is dropped, data included.
      const staleUntil = this.stale.get(path);
      if (staleUntil !== undefined) {
        this.stale.delete(path);
        if (Date.now() < staleUntil) {
          return;
        }
      }
      // As aiostreammagic: an answer settles every request waiting on its path.
      const waiting = this.pending.get(path) ?? [];
      this.pending.delete(path);
      for (const entry of waiting) {
        this.settle(entry, message);
      }
    }
    const data_ = isObject(message.params) ? message.params.data : undefined;
    if (isObject(data_)) {
      this.onMessage?.(path, data_);
    }
  }

  settle(entry, message) {
    clearTimeout(entry.timer);
    this.pendingCount -= 1;
    if (message.result !== 200) {
      const reason =
        cleanText(message.message, 120) ?? `result ${String(message.result).slice(0, 8)}`;
      entry.reject(new DeviceError(ERROR_KINDS.REFUSED, `Refused by the device: ${reason}`));
      return;
    }
    entry.resolve(
      isObject(message.params) && isObject(message.params.data) ? message.params.data : {},
    );
  }

  /** Sends a message without waiting for an answer (subscriptions). */
  send(path, params = {}) {
    if (!this.open) {
      throw new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent');
    }
    this.socket.send(JSON.stringify({ path, params }));
  }

  /**
   * Sends a request and resolves with the `params.data` of its answer.
   * Throws UNREACHABLE when nothing could be sent; after the send, TIMEOUT or
   * CLOSED mark a request that may have reached the device (`sent: true`).
   */
  request(path, params = {}, timeoutMs = 4_000) {
    if (!this.open) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    if (this.pendingCount >= LIMITS.pending) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.BUDGET, 'Too many requests waiting: nothing sent'),
      );
    }
    if (timeoutMs <= 0) {
      return Promise.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined };
      entry.timer = setTimeout(() => {
        const list = this.pending.get(path) ?? [];
        const index = list.indexOf(entry);
        if (index !== -1) {
          list.splice(index, 1);
          this.pendingCount -= 1;
          if (list.length === 0) {
            this.pending.delete(path);
          }
        }
        this.stale.set(path, Date.now() + this.staleMs);
        reject(
          new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without answer from the device', {
            sent: true,
          }),
        );
      }, timeoutMs);
      const list = this.pending.get(path) ?? [];
      list.push(entry);
      this.pending.set(path, list);
      this.pendingCount += 1;
      try {
        this.socket.send(JSON.stringify({ path, params }));
      } catch (err) {
        list.splice(list.indexOf(entry), 1);
        this.pendingCount -= 1;
        clearTimeout(entry.timer);
        reject(new DeviceError(ERROR_KINDS.UNREACHABLE, `Not sent: ${err.message}`));
      }
    });
  }

  ping() {
    if (this.open) {
      this.socket.ping();
    }
  }

  closedByPeer() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const list of this.pending.values()) {
      for (const entry of list) {
        clearTimeout(entry.timer);
        entry.reject(
          new DeviceError(ERROR_KINDS.CLOSED, 'Connection closed before the answer', {
            sent: true,
          }),
        );
      }
    }
    this.pending.clear();
    this.pendingCount = 0;
    this.onClose?.();
  }

  close() {
    try {
      this.socket.terminate();
    } catch {
      // Already closed.
    }
    this.closedByPeer();
  }
}
