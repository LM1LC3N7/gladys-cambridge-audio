// -----------------------------------------------------------------------------
// CambridgeAudioApp with the SDK's fake Gladys, the exact handlers of the
// container (src/handlers.js), a memory store and the fake StreamMagic device
// on the loopback interface. The background round never fires: the tests
// drive it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CambridgeAudioApp, isLanAddress, parseVolumeCommand } from '../src/app.js';
import { createWebSocket } from '../src/streammagic/connection.js';
import { NOTHING, TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { DeviceLink } from '../src/streammagic/link.js';
import { UNIT_ID, startFakeDevice } from './fixtures/fakeStreamMagic.js';

const SELECTOR = 'cambridge-audio';
const id = (key, unit = UNIT_ID) => `ext:${SELECTOR}:streammagic:${unit}${key ? `:${key}` : ''}`;

/** No background round, no heartbeat; real (short) timeouts. */
const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

const FAST = {
  ...TIMINGS,
  connectTimeout: 500,
  requestTimeout: 500,
  reconnectBase: 40,
  reconnectMax: 200,
  stableAfter: 10_000,
  publishDelay: 5,
  persistDelay: 5,
  scanSeconds: 1,
};

async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function setup(t, { deviceOptions, config, scanResults = {}, timings = {}, ...rest } = {}) {
  const device = await startFakeDevice(deviceOptions);
  t.after(() => device.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${device.port}` },
    scanResults,
  });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const store = new MemoryStore();
  const app = new CambridgeAudioApp({
    gladys,
    logger,
    store,
    timers,
    timings: { ...FAST, ...timings },
    ...rest,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  await gladys.connect();
  return { device, gladys, app, logs, store };
}

async function discovered(gladys, unit = UNIT_ID) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id(undefined, unit)),
    'the device in the Discovery tab',
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id(undefined, unit));
}

async function createDevice(gladys, unit = UNIT_ID) {
  const device = await discovered(gladys, unit);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id('power', unit)) !== undefined, 'the power state');
  return device;
}

const set = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id === id(key)),
    value,
  );

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

test('a typed address becomes a Gladys device; its states once created', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await discovered(gladys);
  assert.equal(device.name, 'Living room (CXN100)');
  assert.deepEqual(device.params, [{ name: 'IP_ADDRESS', value: '127.0.0.1' }]);
  const keys = device.features.map((f) => f.external_id.slice(id().length + 1));
  assert.deepEqual(keys, [
    'power',
    'power_on',
    'standby',
    'volume',
    'mute',
    'play',
    'pause',
    'next',
    'previous',
    'playback',
    'source',
    'title',
  ]);
  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));
  // No switch, nothing an "everything on / off" could command; the power is read only.
  assert.ok(device.features.every((f) => f.category !== 'switch'));
  assert.deepEqual([byKey.power.category, byKey.power.read_only], ['unknown', true]);
  assert.deepEqual([byKey.power_on.category, byKey.power_on.type], ['button', 'push']);
  assert.deepEqual([byKey.standby.category, byKey.standby.type], ['button', 'push']);
  assert.deepEqual([byKey.volume.category, byKey.volume.type], ['music', 'volume']);
  assert.equal(byKey.volume.unit, undefined, 'no unit for the music category');
  assert.deepEqual(byKey.source.supported_options, [
    { value: 'AIRPLAY', label: 'AirPlay' },
    { value: 'SPOTIFY', label: 'Spotify' },
    { value: 'TOSLINK1', label: 'TV' },
  ]);
  assert.equal(gladys.fake.states.length, 0, 'no state before the device is created');
  assert.equal(fake.upgrades[0].origin, 'ws://127.0.0.1', 'the origin aiostreammagic sends');

  await createDevice(gladys);
  await waitFor(() => gladys.fake.lastState(id('title')) !== undefined, 'the title');
  assert.equal(gladys.fake.lastState(id('power')), 1);
  assert.equal(gladys.fake.lastState(id('volume')), 30);
  assert.equal(gladys.fake.lastState(id('mute')), 0);
  assert.equal(gladys.fake.lastState(id('playback')), 1);
  assert.equal(gladys.fake.lastState(id('title')), 'Daft Punk - Get Lucky');
  assert.equal(gladys.fake.lastState(id('source')), 'SPOTIFY');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.connectionStatus.message, undefined);
});

test('changes made on the device are pushed to Gladys', async (t) => {
  const { gladys, device: fake } = await setup(t);
  await createDevice(gladys);
  fake.change('zone', { volume_percent: 55, mute: true });
  await waitFor(() => gladys.fake.lastState(id('volume')) === 55, 'the new volume');
  assert.equal(gladys.fake.lastState(id('mute')), 1);
  fake.change('play', { state: 'pause', metadata: { station: 'FIP', title: 'Jazz' } });
  await waitFor(() => gladys.fake.lastState(id('playback')) === 0, 'the pause');
  assert.equal(gladys.fake.lastState(id('title')), 'FIP - Jazz');
  fake.change('zone', { power: false });
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'the standby');
  assert.equal(gladys.fake.lastState(id('title')), NOTHING);
});

test('volume: set, capped by the configuration, validated before anything is sent', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  const device = await createDevice(gladys);
  assert.equal((await set(gladys, device, 'volume', 42)).success, true);
  assert.equal(fake.state.zone.volume_percent, 42);
  await waitFor(() => gladys.fake.lastState(id('volume')) === 42, 'the volume pushed back');
  // Default cap: 50 %.
  assert.equal((await set(gladys, device, 'volume', 90)).success, true);
  assert.equal(fake.state.zone.volume_percent, 50);
  // A lower cap saved in the configuration applies to the next command.
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, max_volume: 20 });
  assert.equal(app.config.maxVolume, 20);
  assert.equal((await set(gladys, device, 'volume', '35')).success, true);
  assert.equal(fake.state.zone.volume_percent, 20);
  assert.equal((await set(gladys, device, 'volume', 10)).success, true);
  assert.equal(fake.state.zone.volume_percent, 10);
  const before = fake.commands.length;
  for (const bad of [null, '', ' ', -1, 101, 12.5, '12abc', true, NaN, Infinity, '1e2', {}]) {
    assert.equal((await set(gladys, device, 'volume', bad)).success, false, String(bad));
  }
  assert.equal(fake.commands.length, before, 'no invalid volume reached the device');
});

test('parseVolumeCommand accepts integers 0..100 only', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand(100), 100);
  assert.equal(parseVolumeCommand(' 7 '), 7);
  for (const bad of [null, undefined, '', -1, 101, 1.5, '1.5', '0x10', true, [], {}]) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
});

test('volume: refused when the pre-amplifier is off, and not published', async (t) => {
  const { gladys, device: fake } = await setup(t, { deviceOptions: { noPreAmp: true } });
  const device = await createDevice(gladys);
  await settle();
  assert.equal(gladys.fake.lastState(id('volume')), undefined);
  const ack = await set(gladys, device, 'volume', 20);
  assert.equal(ack.success, false);
  assert.match(ack.error, /pre-amplifier off/);
  assert.equal(fake.commands.length, 0);
});

test('mute: each press reads the mute and sets the opposite', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.zone.mute, true);
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.equal(fake.state.zone.mute, false);
  assert.deepEqual(
    fake.commands.map((c) => c.params.mute),
    [true, false],
    'explicit values, never a toggle',
  );
});

test('power on and standby are buttons', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  assert.equal((await set(gladys, device, 'standby')).success, true);
  assert.deepEqual(fake.commands.at(-1), { path: '/system/power', params: { power: 'NETWORK' } });
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'the standby state');
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.deepEqual(fake.commands.at(-1), { path: '/system/power', params: { power: 'ON' } });
  await waitFor(() => gladys.fake.lastState(id('power')) === 1, 'the power state');
  // The read-only power state cannot be commanded.
  assert.equal((await set(gladys, device, 'power', 1)).success, false);
});

test('play and pause: the toggle only when needed, on the play state read again', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  // Playing, the source only offers play_pause.
  assert.equal((await set(gladys, device, 'play')).success, true);
  assert.equal(fake.commands.length, 0, 'already playing: nothing sent');
  assert.equal((await set(gladys, device, 'pause')).success, true);
  assert.equal(fake.commands.at(-1).params.action, 'toggle');
  assert.equal(fake.state.play.state, 'pause');
  assert.equal((await set(gladys, device, 'pause')).success, true);
  assert.equal(fake.commands.length, 1, 'already paused: nothing sent');
  assert.equal((await set(gladys, device, 'play')).success, true);
  assert.equal(fake.state.play.state, 'play');
  // A source with explicit controls gets the explicit action.
  fake.change('nowPlaying', { controls: ['play', 'pause', 'track_next'] });
  await settle();
  assert.equal((await set(gladys, device, 'pause')).success, true);
  assert.equal(fake.commands.at(-1).params.action, 'pause');
  assert.equal((await set(gladys, device, 'next')).success, true);
  assert.equal(fake.commands.at(-1).params.skip_track, 1);
  assert.equal((await set(gladys, device, 'previous')).success, true);
  assert.equal(fake.commands.at(-1).params.skip_track, -1);
});

test('source: among the options, checked against the list read again', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  assert.equal((await set(gladys, device, 'source', 'TOSLINK1')).success, true);
  assert.equal(fake.state.zone.source, 'TOSLINK1');
  await waitFor(() => gladys.fake.lastState(id('source')) === 'TOSLINK1', 'the source');
  assert.equal((await set(gladys, device, 'source', 'NOPE')).success, false);
  // The source disappears from the device: refused, but its option is kept.
  fake.state.sources = fake.state.sources.filter((s) => s.id !== 'AIRPLAY');
  fake.change('sources', {});
  await settle();
  const ack = await set(gladys, device, 'source', 'AIRPLAY');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not available now/);
  assert.ok(
    gladys.fake.discoveredDevices[0].features
      .find((f) => f.external_id === id('source'))
      .supported_options.some((o) => o.value === 'AIRPLAY'),
    'the dropdown only grows',
  );
});

test('a silent device: "sent, without confirmation" before the Gladys deadline', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    deviceOptions: { silent: true },
    timings: { commandBudget: 300 },
  });
  const device = await createDevice(gladys);
  const started = Date.now();
  const ack = await set(gladys, device, 'volume', 10);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Sent, without confirmation/);
  assert.equal(fake.commands.length, 1);
});

test('a refused command says so', async (t) => {
  const { gladys } = await setup(t, { deviceOptions: { refuse: true } });
  const device = await createDevice(gladys);
  const ack = await set(gladys, device, 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Refused by the device: Not allowed in this state/);
});

test('a device that stops answering: power 0, named in the status, reconnected later', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  const device = await createDevice(gladys);
  const port = fake.port;
  await fake.close();
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'power 0');
  await waitFor(
    () => /Not connected/.test(gladys.fake.connectionStatus.message?.en ?? ''),
    'the status',
  );
  const ack = await set(gladys, device, 'volume', 10);
  assert.equal(ack.success, false);
  assert.match(ack.error, /nothing sent/);
  // Standby on a device that does not answer: never "done", nothing sent.
  const standby = await set(gladys, device, 'standby');
  assert.equal(standby.success, false);
  assert.match(standby.error, /not connected .*nothing sent/);
  const link = [...app.links.values()][0];
  assert.ok(link.failures >= 1);
  // Back on the network: found again at the next attempt (spaced out).
  const again = await startFakeDevice({ port });
  t.after(() => again.close());
  await waitFor(() => gladys.fake.lastState(id('power')) === 1, 'power 1 again');
  await waitFor(() => gladys.fake.connectionStatus.message === undefined, 'a clean status');
});

test('reconnection is spaced out: the delay doubles up to the maximum', () => {
  let now = 0;
  const link = new DeviceLink({
    address: { host: '192.0.2.1', port: 80 },
    timings: TIMINGS,
    now: () => now,
  });
  const delays = Array.from({ length: 7 }, () => link.backoff());
  assert.deepEqual(delays, [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
  // A connection that dropped right away does not reset the count...
  link.connectedAt = 0;
  now = 5_000;
  assert.equal(link.backoff(), 300_000);
  // ...one that stayed up a minute does.
  link.connectedAt = 0;
  now = 60_000;
  assert.equal(link.backoff(), 10_000);
});

test('a reconnection to Gladys keeps the link, republishes the status and the devices', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  await createDevice(gladys);
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await app.start(gladys.fake.config, { connected: true });
  assert.equal(fake.connections(), 1, 'the websocket is not reopened');
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.ok(gladys.fake.bodies('POST', '/discovered_device').length > discoveries);
});

test('a typed address that does not answer is named in the status', async (t) => {
  const { gladys } = await setup(t, { config: { addresses: '127.0.0.1:1, nope!' } });
  await waitFor(
    () => /127\.0\.0\.1:1/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'the silent address',
  );
  assert.match(gladys.fake.connectionStatus.message.en, /nope!/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('another device at the address of a created one: its address is cleared', async (t) => {
  const { gladys, device: fake, app } = await setup(t);
  await createDevice(gladys);
  const port = fake.port;
  await fake.close();
  const other = await startFakeDevice({ port, unitId: 'ffeeddccbbaa' });
  t.after(() => other.close());
  await discovered(gladys, 'ffeeddccbbaa');
  await waitFor(() => app.data.devices[UNIT_ID].host === '', 'the old address cleared');
  await waitFor(() => gladys.fake.lastState(id('power')) === 0, 'power 0 for the lost device');
  await app.updateStatus();
  assert.match(gladys.fake.connectionStatus.message.en, /Address unknown/);
});

test('hostile messages are ignored; a flood or an oversized message closes the socket', async (t) => {
  const {
    gladys,
    device: fake,
    app,
  } = await setup(t, {
    timings: { floodMessages: 20, floodWindow: 10_000 },
  });
  await createDevice(gladys);
  fake.broadcast('not json');
  fake.broadcast(JSON.stringify([1, 2]));
  fake.broadcast(
    JSON.stringify({ path: '/zone/state', params: { data: { volume_percent: 'x' } } }),
  );
  fake.broadcast(
    JSON.stringify({ path: '/system/info', params: { data: { unit_id: '__proto__' } } }),
  );
  await settle();
  assert.equal(gladys.fake.lastState(id('volume')), 30);
  assert.equal(Object.getPrototypeOf(app.data.devices), null);
  const link = [...app.links.values()][0];
  const failures = link.failures;
  fake.broadcast('x'.repeat(300 * 1024));
  await waitFor(() => link.failures > failures, 'the socket closed');
  await waitFor(() => link.connected, 'connected again');
  const before = link.failures;
  for (let i = 0; i < 30; i += 1) {
    fake.change('zone', { volume_percent: i });
  }
  await waitFor(() => link.failures > before, 'the flood closed the socket');
});

test('"Find the devices": mDNS answers identified, then created like typed ones', async (t) => {
  let fakePort;
  const urls = [];
  const { gladys, device: fake } = await setup(t, {
    config: { addresses: '' },
    deviceOptions: { checkOrigin: false },
    scanResults: {
      mdns: [
        { name: 'x', host: 'cxn.local', addresses: ['192.168.1.40', 'fe80::1'], port: 80, txt: [] },
        { name: 'junk', host: null, addresses: 'nope', port: null, txt: [] },
      ],
    },
    // Every socket goes to the fake device on the loopback interface: the
    // tests never leave it, whatever address the mDNS answer gives.
    createSocket: (url, options) => {
      urls.push(url);
      return createWebSocket(`ws://127.0.0.1:${fakePort}/smoip`, options);
    },
  });
  fakePort = fake.port;
  const ack = await gladys.fake.action('find_devices');
  assert.equal(ack.success, true);
  assert.match(ack.data.message.en, /Found: Living room \(CXN100\) \(192\.168\.1\.40\)/);
  assert.match(ack.data.message.fr, /Trouvés/);
  assert.equal(urls[0], 'ws://192.168.1.40:80/smoip', 'always port 80');
  await discovered(gladys);
});

test('"Check the devices" reports each device and the cap', async (t) => {
  const { gladys } = await setup(t);
  await createDevice(gladys);
  const ack = await gladys.fake.action('check_devices');
  assert.match(ack.data.message.en, /connected, on, volume 30/);
  assert.match(ack.data.message.en, /Volume cap: 50 %/);
  assert.match(ack.data.message.fr, /Plafond de volume : 50 %/);
});

test('the known devices are kept in /data', async (t) => {
  const { gladys, store } = await setup(t);
  await createDevice(gladys);
  await waitFor(() => Object.keys(store.data.devices ?? {}).length === 1, 'the save');
  const saved = store.data.devices[UNIT_ID];
  assert.equal(saved.host, '127.0.0.1');
  assert.equal(saved.sourceOptions.length, 3);
  assert.equal(JSON.stringify(store.data).includes('token'), false);
});

// --- Review fixes ------------------------------------------------------------------

const volumes = (fake) =>
  fake.commands.filter((c) => 'volume_percent' in c.params).map((c) => c.params.volume_percent);

test('I1 unmuting never plays above the cap: the volume is lowered first', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  fake.change('zone', { volume_percent: 90, mute: true });
  await settle();
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.deepEqual(
    fake.commands.map((c) => c.params),
    [
      { zone: 'ZONE1', volume_percent: 50 },
      { zone: 'ZONE1', mute: false },
    ],
  );
  // Muting does not touch the volume.
  fake.change('zone', { volume_percent: 90 });
  await settle();
  assert.equal((await set(gladys, device, 'mute')).success, true);
  assert.deepEqual(fake.commands.at(-1).params, { zone: 'ZONE1', mute: true });
  assert.deepEqual(volumes(fake), [50]);
  // Unmuting without a volume read: refused, nothing sent.
  delete fake.state.zone.volume_percent;
  const before = fake.commands.length;
  const ack = await set(gladys, device, 'mute');
  assert.equal(ack.success, false);
  assert.match(ack.error, /volume unknown, nothing sent/);
  assert.equal(fake.commands.length, before);
});

test('I1 Power on: a device waking up above the cap is brought back to it', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  fake.change('zone', { power: false, volume_percent: 85 });
  await settle();
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.deepEqual(volumes(fake), [50]);
  // At or below the cap: nothing more is sent.
  fake.change('zone', { power: false, volume_percent: 30 });
  await settle();
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.deepEqual(volumes(fake), [50]);
});

test('I1 Power on: a slow wake-up is checked again in the background', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    deviceOptions: { wakeDelay: 150 },
    timings: { wakeCheckDelay: 50, wakeChecks: 10 },
  });
  const device = await createDevice(gladys);
  fake.change('zone', { power: false, volume_percent: 85 });
  await settle();
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.deepEqual(volumes(fake), [], 'not on yet when the command is answered');
  await waitFor(() => volumes(fake).length === 1, 'the cap after the wake-up');
  assert.deepEqual(volumes(fake), [50]);
});

test('R1 one wake-up check chain per device: a new press starts it over', async (t) => {
  const {
    gladys,
    device: fake,
    app,
  } = await setup(t, {
    deviceOptions: { wakeDelay: 60_000 },
    timings: { wakeCheckDelay: 100, wakeChecks: 50 },
  });
  const device = await createDevice(gladys);
  fake.change('zone', { power: false });
  await settle();
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  await settle(150);
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.equal(app.wakeChecks.size, 1);
  const before = fake.reads.filter((p) => p === '/zone/state').length;
  await settle(1_050);
  const checks = fake.reads.filter((p) => p === '/zone/state').length - before;
  // One chain: about one read every 100 ms (two chains would give about 20).
  assert.ok(checks >= 5 && checks <= 12, `${checks} reads in 1 s`);
  await app.stop();
  assert.equal(app.wakeChecks.size, 0, 'stop() ends the chain');
  const stopped = fake.reads.length;
  await settle(250);
  assert.equal(fake.reads.length, stopped);
});

test('R2 a wake-up check without answer does not make the next ones drop theirs', async (t) => {
  const timings = { staleAnswer: 200, wakeCheckDelay: 250, wakeChecks: 6, preRead: 100 };
  assert.ok(TIMINGS.wakeCheckDelay > TIMINGS.staleAnswer, 'the real timings keep the order');
  const { gladys, device: fake } = await setup(t, { deviceOptions: { wakeDelay: 100 }, timings });
  const device = await createDevice(gladys);
  fake.change('zone', { power: false, volume_percent: 85 });
  await settle();
  assert.equal((await set(gladys, device, 'power_on')).success, true);
  assert.deepEqual(volumes(fake), [], 'still waking up');
  // The first background read is left unanswered (it times out), then the
  // device answers normally: the volume ends at the cap.
  fake.options.dropReads = 1;
  await waitFor(() => volumes(fake).length === 1, 'the cap', 3_000);
  assert.deepEqual(volumes(fake), [50]);
  assert.equal(fake.options.dropReads, 0, 'one read was dropped');
});

test('I2 the toggle only from pause or stop (Play) and from play (Pause)', async (t) => {
  const { gladys, device: fake } = await setup(t);
  const device = await createDevice(gladys);
  for (const state of ['connecting', 'buffering', 'NETWORK', 'ready', 'weird']) {
    fake.state.play.state = state;
    for (const key of ['play', 'pause']) {
      const ack = await set(gladys, device, key);
      assert.equal(ack.success, false, `${key} on ${state}`);
      assert.match(ack.error, new RegExp(`play state ${state}, nothing sent`));
    }
  }
  assert.equal(fake.commands.length, 0);
  fake.state.play.state = 'stop';
  assert.equal((await set(gladys, device, 'pause')).success, true);
  assert.equal(fake.commands.length, 0, 'Pause on stop: nothing to do');
  assert.equal((await set(gladys, device, 'play')).success, true);
  assert.equal(fake.commands.at(-1).params.action, 'toggle');
  assert.equal(fake.state.play.state, 'play');
});

test('I3 Standby right after a connection drop: not connected, nothing sent', async (t) => {
  const { gladys, device: fake } = await setup(t, {
    timings: { reconnectBase: 5_000, reconnectMax: 5_000 },
  });
  const device = await createDevice(gladys);
  fake.drop();
  await settle(50);
  const ack = await set(gladys, device, 'standby');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not connected .*nothing sent/);
  assert.equal(fake.state.zone.power, true);
});

test('M1 the late answer of a timed-out request never settles the next one', async (t) => {
  const { gladys, device: fake } = await setup(t, { timings: { commandBudget: 300 } });
  const device = await createDevice(gladys);
  fake.options.silent = true;
  assert.equal((await set(gladys, device, 'volume', 40)).success, false);
  fake.options.silent = false;
  fake.state.zone.mute = false;
  const press = set(gladys, device, 'mute');
  // The late answer of the volume (an old state, muted) arrives first.
  fake.broadcast(
    JSON.stringify({
      path: '/zone/state',
      type: 'response',
      result: 200,
      message: 'OK',
      params: { data: { mute: true, power: true, pre_amp_mode: true, volume_percent: 40 } },
    }),
  );
  assert.equal((await press).success, true);
  assert.equal(fake.state.zone.mute, true, 'muted, from the real state');
});

test('M2 every frame counts for the flood guard, unknown paths and junk included', async (t) => {
  const {
    gladys,
    device: fake,
    app,
  } = await setup(t, {
    timings: { floodMessages: 20, floodWindow: 10_000 },
  });
  await createDevice(gladys);
  const link = [...app.links.values()][0];
  const failures = link.failures;
  for (let i = 0; i < 30; i += 1) {
    fake.broadcast(i % 2 ? 'junk' : JSON.stringify({ path: '/unknown', params: { data: {} } }));
  }
  await waitFor(() => link.failures > failures, 'the flood closed the socket');
});

test('M3 mDNS answers: local network addresses only', async (t) => {
  for (const ok of [
    '10.1.2.3',
    '172.16.0.9',
    '172.31.255.1',
    '192.168.1.40',
    '169.254.3.4',
    '100.64.0.1',
  ]) {
    assert.equal(isLanAddress(ok), true, ok);
  }
  for (const bad of [
    '8.8.8.8',
    '169.254.169.254',
    '127.0.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1.255',
    '224.0.0.251',
    '172.32.0.1',
    '100.128.0.1',
    'fe80::1',
    'cxn.local',
    null,
  ]) {
    assert.equal(isLanAddress(bad), false, String(bad));
  }
  const asked = [];
  const { app } = await setup(t, {
    config: { addresses: '' },
    identify: async ({ address }) => {
      asked.push(address.host);
      throw new Error('no');
    },
    scanResults: {
      mdns: [
        {
          name: 'x',
          host: 'x.local',
          addresses: ['8.8.8.8', '169.254.169.254', '127.0.0.1', '192.168.1.40', '0.0.0.0'],
          port: 80,
          txt: [],
        },
      ],
    },
  });
  await app.findDevices();
  assert.deepEqual(asked, ['192.168.1.40']);
});

test('M4 reconnections to Gladys never make an unreachable address asked faster', async (t) => {
  let attempts = 0;
  const { gladys, app } = await setup(t, {
    config: { addresses: '127.0.0.1:9' },
    timings: { reconnectBase: 300, reconnectMax: 5_000 },
    createSocket: (url, options) => {
      attempts += 1;
      return createWebSocket(url, options);
    },
  });
  const started = Date.now();
  while (Date.now() - started < 1_500) {
    await app.start(await gladys.getConfig(), { connected: true });
    await settle(20);
  }
  // 0, 300, 900 ms: the backoff alone, whatever the reconnections.
  assert.ok(attempts <= 3, `${attempts} attempts`);
});

test('M5 standby and mute go before the commands waiting', async (t) => {
  const { gladys, device: fake } = await setup(t, { deviceOptions: { delay: 150 } });
  const device = await createDevice(gladys);
  const first = set(gladys, device, 'volume', 10);
  await settle(20);
  const second = set(gladys, device, 'volume', 20);
  await settle(5);
  const mute = set(gladys, device, 'mute');
  await settle(5);
  const standby = set(gladys, device, 'standby');
  const acks = await Promise.all([first, second, mute, standby]);
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks),
  );
  assert.deepEqual(
    fake.commands.map((c) => Object.keys(c.params).find((k) => k !== 'zone')),
    ['volume_percent', 'mute', 'power', 'volume_percent'],
  );
});
