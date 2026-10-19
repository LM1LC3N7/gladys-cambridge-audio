// -----------------------------------------------------------------------------
// The StreamMagic payloads, ported from the models of aiostreammagic (MIT, see
// THIRD_PARTY_NOTICES.md): `/system/info`, `/system/sources`, `/zone/state`,
// `/zone/play_state` and `/zone/now_playing`, the `params.data` of each
// message.
//
// Every payload is untrusted: only the expected fields of the expected types
// are kept, strings cut and cleaned, ids kept only when they are plain
// identifiers (never `__proto__`, `constructor` or `prototype`).
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

// Control characters (C0, DEL, C1), the bidirectional marks, embeddings,
// overrides and isolates (U+061C, U+200E, U+200F, U+202A-U+202E,
// U+2066-U+2069) and the line/paragraph separators (U+2028, U+2029) are
// removed from what is shown in Gladys. Written as code point ranges on
// purpose: the characters themselves are invisible in an editor.
const UNPRINTABLE = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x061c, 0x061c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];
const isUnprintable = (char) => {
  const code = char.codePointAt(0);
  return UNPRINTABLE.some(([from, to]) => code >= from && code <= to);
};

/** A printable string of at most `max` characters, or undefined. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = [...value.slice(0, max * 4)]
    .map((char) => (isUnprintable(char) ? ' ' : char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? undefined : [...text].slice(0, max).join('');
}

const SAFE_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** Names that would reach Object.prototype when used as a key: never an id. */
export const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const isSafeId = (value) =>
  typeof value === 'string' && SAFE_ID.test(value) && !RESERVED_KEYS.has(value);
const safeId = (value) => (isSafeId(value) ? value : undefined);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bool = (value) => (typeof value === 'boolean' ? value : undefined);
const percent = (value) =>
  Number.isInteger(value) && value >= 0 && value <= 100 ? value : undefined;

/**
 * `/system/info` -> who the device is. The `unit_id` is its identity (the
 * unique id Home Assistant gives it); undefined without a usable one.
 */
export function parseInfo(data) {
  if (!isObject(data)) {
    return undefined;
  }
  const unitId = safeId(data.unit_id);
  if (!unitId) {
    return undefined;
  }
  return {
    unitId,
    name: cleanText(data.name, LIMITS.name),
    model: cleanText(data.model, LIMITS.name),
    api: cleanText(data.api, 16),
  };
}

/** `/system/sources` -> [{ id, name }], at most LIMITS.sources, ids unique. */
export function parseSources(data) {
  const list = Array.isArray(data?.sources) ? data.sources : undefined;
  if (!list) {
    return undefined;
  }
  const seen = new Set();
  const sources = [];
  for (const item of list.slice(0, LIMITS.sources * 2)) {
    const id = safeId(item?.id);
    if (!id || seen.has(id) || sources.length >= LIMITS.sources) {
      continue;
    }
    seen.add(id);
    sources.push({
      id,
      name: cleanText(item.name, LIMITS.name) ?? cleanText(item.default_name, LIMITS.name) ?? id,
    });
  }
  return sources;
}

/**
 * `/zone/state` -> { power, source, mute, volume, preAmp }. A field missing
 * or of another type is left undefined: never published, never decided on.
 * The volume is only controlled by the device when its pre-amplifier is on
 * (`pre_amp_mode`), as in Home Assistant.
 */
export function parseZoneState(data) {
  if (!isObject(data)) {
    return undefined;
  }
  return {
    power: bool(data.power),
    source: safeId(data.source),
    mute: bool(data.mute),
    volume: percent(data.volume_percent),
    preAmp: bool(data.pre_amp_mode),
  };
}

/** `/zone/play_state` -> { state, title, artist, station }. */
export function parsePlayState(data) {
  if (!isObject(data)) {
    return undefined;
  }
  const metadata = isObject(data.metadata) ? data.metadata : {};
  return {
    state: safeId(data.state),
    title: cleanText(metadata.title, LIMITS.title),
    artist: cleanText(metadata.artist, LIMITS.title),
    station: cleanText(metadata.station, LIMITS.title),
  };
}

const CONTROLS = new Set(['play', 'pause', 'play_pause', 'track_next', 'track_previous', 'stop']);

/** `/zone/now_playing` -> { controls }: the transport controls the current source accepts. */
export function parseNowPlaying(data) {
  if (!isObject(data)) {
    return undefined;
  }
  const controls = (Array.isArray(data.controls) ? data.controls.slice(0, 32) : []).filter(
    (c) => typeof c === 'string' && CONTROLS.has(c),
  );
  return { controls: [...new Set(controls)] };
}

/** "Artist - Title" (the station when there is no artist), the title alone, or undefined. */
export function nowPlaying(play) {
  if (!play) {
    return undefined;
  }
  const artist = play.artist ?? play.station;
  if (!play.title && !artist) {
    return undefined;
  }
  return [artist, play.title].filter(Boolean).join(' - ');
}

/** 1 playing, 0 otherwise; undefined when the play state is unknown. */
export function isPlaying(play) {
  if (!play?.state) {
    return undefined;
  }
  return play.state === 'play' ? 1 : 0;
}
