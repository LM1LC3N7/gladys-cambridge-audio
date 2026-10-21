// -----------------------------------------------------------------------------
// A fake StreamMagic device on 127.0.0.1: the websocket `/smoip`, the paths
// used by the integration, the answers and pushed updates of aiostreammagic's
// protocol. `silent` leaves commands unanswered, `refuse` answers them with an
// error result, `noPreAmp` turns the pre-amplifier off, `delay` answers
// commands late, `wakeDelay` reports the power on only after a while,
// `ignore` (parameter names, e.g. 'volume_percent', 'power') accepts those
// commands (`result: 200`) without doing them.
// -----------------------------------------------------------------------------

import { WebSocketServer } from 'ws';

export const UNIT_ID = '0020c2a1b2c3';

export function defaultState(unitId = UNIT_ID) {
  return {
    info: {
      name: 'Living room',
      model: 'CXN100',
      timezone: 'Europe/Paris',
      locale: 'fr_FR',
      udn: `uuid:${unitId}`,
      unit_id: unitId,
      api: '1.8',
    },
    sources: [
      { id: 'AIRPLAY', name: 'AirPlay', default_name: 'AirPlay', ui_selectable: true },
      { id: 'SPOTIFY', name: 'Spotify', default_name: 'Spotify', ui_selectable: true },
      { id: 'TOSLINK1', name: 'TV', default_name: 'Optical 1', ui_selectable: true },
    ],
    zone: {
      source: 'SPOTIFY',
      power: true,
      pre_amp_mode: true,
      pre_amp_state: true,
      volume_percent: 30,
      mute: false,
    },
    play: { state: 'play', metadata: { title: 'Get Lucky', artist: 'Daft Punk' } },
    nowPlaying: { controls: ['play_pause', 'track_next', 'track_previous'] },
  };
}

const READS = {
  '/system/info': 'info',
  '/system/sources': 'sources',
  '/zone/state': 'zone',
  '/zone/play_state': 'play',
  '/zone/now_playing': 'nowPlaying',
};

export async function startFakeDevice({
  unitId = UNIT_ID,
  silent = false,
  refuse = false,
  noPreAmp = false,
  checkOrigin = true,
  port = 0,
  delay = 0,
  wakeDelay = 0,
  ignore = [],
} = {}) {
  const state = defaultState(unitId);
  if (noPreAmp) {
    state.zone.pre_amp_mode = false;
  }
  const commands = [];
  const subscriptions = new Map();
  const options = { silent, refuse, delay, wakeDelay, dropReads: 0, ignore: new Set(ignore) };
  /** Every read (a request without parameters), by path, in order. */
  const reads = [];
  const sockets = new Set();
  const upgrades = [];

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    path: '/smoip',
    verifyClient: ({ req }) => {
      upgrades.push({ origin: req.headers.origin, host: req.headers.host });
      return !checkOrigin || req.headers.origin === 'ws://127.0.0.1';
    },
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const dataOf = (path) => {
    const field = READS[path];
    return field === 'sources' ? { sources: state.sources } : state[field];
  };

  const push = (path) => {
    for (const socket of subscriptions.get(path) ?? []) {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ path, type: 'update', params: { data: dataOf(path) } }));
      }
    }
  };

  const respond = (socket, path, data, result = 200, message = 'OK') => {
    socket.send(
      JSON.stringify({ path, type: 'response', result, message, params: data ? { data } : {} }),
    );
  };

  function apply(path, params) {
    if (path === '/zone/state') {
      if ('volume_percent' in params) state.zone.volume_percent = params.volume_percent;
      if ('mute' in params) state.zone.mute = params.mute;
      if ('source' in params) state.zone.source = params.source;
      return ['/zone/state'];
    }
    if (path === '/system/power') {
      state.zone.power = params.power === 'ON';
      state.play.state = params.power === 'ON' ? 'ready' : 'NETWORK';
      return ['/zone/state', '/zone/play_state'];
    }
    if (path === '/zone/play_control') {
      if (params.action === 'toggle') {
        state.play.state = state.play.state === 'play' ? 'pause' : 'play';
      } else if (params.action === 'play' || params.action === 'pause') {
        state.play.state = params.action;
      } else if (params.skip_track !== undefined) {
        state.play.metadata = { title: `Track ${commands.length}`, artist: 'Someone' };
      }
      return ['/zone/play_state'];
    }
    return [];
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', (raw) => {
      const { path, params = {} } = JSON.parse(String(raw));
      if (params.update !== undefined) {
        const set = subscriptions.get(path) ?? new Set();
        set.add(socket);
        subscriptions.set(path, set);
        return;
      }
      const keys = Object.keys(params).filter((k) => k !== 'zone');
      if (keys.length === 0 && READS[path]) {
        reads.push(path);
        if (path === '/zone/state' && options.dropReads > 0) {
          // A read of the zone left unanswered (a busy device).
          options.dropReads -= 1;
          return;
        }
        respond(socket, path, dataOf(path));
        return;
      }
      commands.push({ path, params });
      if (options.silent) {
        return;
      }
      if (options.refuse) {
        respond(socket, path, undefined, 500, 'Not allowed in this state');
        return;
      }
      const answer = () => {
        if (keys.some((k) => options.ignore.has(k))) {
          // Accepted, not done: the state pushed again is unchanged.
          respond(socket, path, undefined);
          push('/zone/state');
          return;
        }
        const changed = apply(path, params);
        respond(socket, path, undefined);
        changed.forEach(push);
        if (path === '/system/power' && params.power === 'ON' && options.wakeDelay > 0) {
          // A slow wake-up: on, but the zone says so only after a while.
          state.zone.power = false;
          setTimeout(() => {
            state.zone.power = true;
            push('/zone/state');
          }, options.wakeDelay);
        }
      };
      if (options.delay > 0) {
        setTimeout(answer, options.delay);
      } else {
        answer();
      }
    });
  });

  return {
    port: server.address().port,
    state,
    commands,
    reads,
    options,
    upgrades,
    /** Changes the state like the front panel would, and pushes it. */
    change(field, values) {
      Object.assign(state[field], values);
      const path = Object.keys(READS).find((p) => READS[p] === field);
      // The integration subscribes right after its snapshot: a change made
      // before its subscription arrived is pushed once it does.
      const started = Date.now();
      const tryPush = () => {
        if ((subscriptions.get(path)?.size ?? 0) > 0 || Date.now() - started > 1_000) {
          push(path);
        } else {
          setTimeout(tryPush, 5);
        }
      };
      tryPush();
    },
    /** Sends anything on every socket (hostile device). */
    broadcast(text) {
      for (const socket of sockets) {
        socket.send(text);
      }
    },
    connections: () => sockets.size,
    drop() {
      for (const socket of sockets) {
        socket.terminate();
      }
    },
    close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
