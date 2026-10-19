import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddress, parseMaxVolume } from '../src/config.js';
import { MAX_VOLUME } from '../src/constants.js';

test('addresses: IPv4 or host name, optional port, URL reduced', () => {
  assert.deepEqual(parseAddress('192.168.1.20'), { host: '192.168.1.20', port: 80 });
  assert.deepEqual(parseAddress('ws://192.168.1.20:8080/smoip'), {
    host: '192.168.1.20',
    port: 8080,
  });
  assert.deepEqual(parseAddress('CXN.local'), { host: 'cxn.local', port: 80 });
  for (const bad of ['', '999.1.1.1', '1.2.3', 'a b', 'host:0', 'host:70000', '-x.local', null]) {
    assert.equal(parseAddress(bad), undefined, String(bad));
  }
});

test('the volume cap: an integer 1..100, the default when unreadable', () => {
  assert.equal(DEFAULT_CONFIG.max_volume, MAX_VOLUME.default);
  assert.equal(MAX_VOLUME.default, 50);
  assert.equal(parseMaxVolume(70), 70);
  assert.equal(parseMaxVolume('35'), 35);
  assert.equal(parseMaxVolume(0), 1);
  assert.equal(parseMaxVolume(250), 100);
  assert.equal(parseMaxVolume(44.6), 45);
  for (const bad of [null, undefined, '', ' ', 'abc', true, NaN, {}]) {
    assert.equal(parseMaxVolume(bad), MAX_VOLUME.default, String(bad));
  }
});

test('normalizeConfig', () => {
  const config = normalizeConfig({
    addresses: '192.168.1.20, 192.168.1.20;192.168.1.21:80 nope!',
    max_volume: '30',
  });
  assert.deepEqual(
    config.addresses.map((a) => a.host),
    ['192.168.1.20', '192.168.1.21'],
  );
  assert.deepEqual(config.invalid, ['nope!']);
  assert.equal(config.maxVolume, 30);
  assert.deepEqual(normalizeConfig().addresses, []);
  assert.equal(normalizeConfig().maxVolume, 50);
  assert.equal(normalizeConfig({ max_volume: null }).maxVolume, 50);
});
