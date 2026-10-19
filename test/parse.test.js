import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText,
  isSafeId,
  nowPlaying,
  parseInfo,
  parseNowPlaying,
  parsePlayState,
  parseSources,
  parseZoneState,
} from '../src/streammagic/parse.js';
import { sanitizeData } from '../src/store.js';

test('info: the unit id is the identity, a plain identifier only', () => {
  assert.deepEqual(
    parseInfo({ unit_id: 'abc123', name: ' Salon ', model: 'EVO 150', api: '1.9' }),
    {
      unitId: 'abc123',
      name: 'Salon',
      model: 'EVO 150',
      api: '1.9',
    },
  );
  for (const bad of [null, [], {}, { unit_id: '__proto__' }, { unit_id: 'a b' }, { unit_id: 5 }]) {
    assert.equal(parseInfo(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(isSafeId('constructor'), false);
  assert.equal(isSafeId('x'.repeat(65)), false);
});

test('sources: ids unique and safe, names cleaned, bounded', () => {
  const sources = parseSources({
    sources: [
      { id: 'AIRPLAY', name: 'Air\u0000Play' },
      { id: 'AIRPLAY', name: 'twice' },
      { id: '__proto__', name: 'x' },
      { id: 'USB', default_name: 'USB audio' },
      { id: 'IR' },
      'junk',
      ...Array.from({ length: 100 }, (_, i) => ({ id: `S${i}`, name: `S${i}` })),
    ],
  });
  assert.deepEqual(sources.slice(0, 3), [
    { id: 'AIRPLAY', name: 'Air Play' },
    { id: 'USB', name: 'USB audio' },
    { id: 'IR', name: 'IR' },
  ]);
  assert.equal(sources.length, 40);
  assert.equal(parseSources({ sources: 'x' }), undefined);
});

test('zone state: only the expected types', () => {
  assert.deepEqual(
    parseZoneState({ power: true, source: 'IR', mute: 0, volume_percent: 101, pre_amp_mode: true }),
    { power: true, source: 'IR', mute: undefined, volume: undefined, preAmp: true },
  );
  assert.equal(parseZoneState('x'), undefined);
});

test('play state and now playing', () => {
  const play = parsePlayState({ state: 'play', metadata: { title: 'T', station: 'FIP' } });
  assert.equal(nowPlaying(play), 'FIP - T');
  assert.equal(nowPlaying(parsePlayState({ state: 'stop' })), undefined);
  assert.deepEqual(parseNowPlaying({ controls: ['play', 'seek', 'play', 5] }), {
    controls: ['play'],
  });
  assert.equal(cleanText('a‮b c', 10), 'a b c');
  assert.equal(cleanText('x'.repeat(500), 200).length, 200);
});

test('/data: a plain copy, no prototype, unsafe keys dropped', () => {
  const data = sanitizeData(
    JSON.parse(
      '{"devices":{"__proto__":{"unitId":"__proto__"},"abc":{"unitId":"abc","host":"10.0.0.2","port":80,"sourceOptions":[{"value":"IR","label":"Radio"},{"value":"__proto__"}]},"bad":{"unitId":"other"}}}',
    ),
  );
  assert.equal(Object.getPrototypeOf(data.devices), null);
  assert.deepEqual(Object.keys(data.devices), ['abc']);
  assert.deepEqual(data.devices.abc.sourceOptions, [{ value: 'IR', label: 'Radio' }]);
});
