// -----------------------------------------------------------------------------
// The StreamMagic paths used, from aiostreammagic (MIT, see
// THIRD_PARTY_NOTICES.md), and the command messages built on them.
// -----------------------------------------------------------------------------

import { ZONE } from '../constants.js';

export const PATHS = Object.freeze({
  INFO: '/system/info',
  SOURCES: '/system/sources',
  ZONE_STATE: '/zone/state',
  PLAY_STATE: '/zone/play_state',
  NOW_PLAYING: '/zone/now_playing',
  PLAY_CONTROL: '/zone/play_control',
  POWER: '/system/power',
});

/** The paths read when a connection opens, then subscribed to. */
export const WATCHED = Object.freeze([
  PATHS.INFO,
  PATHS.SOURCES,
  PATHS.ZONE_STATE,
  PATHS.PLAY_STATE,
  PATHS.NOW_PLAYING,
]);

export const subscription = () => ({ update: 100, zone: ZONE });

/** [path, params] of each command, as aiostreammagic sends them. */
export const COMMANDS = Object.freeze({
  powerOn: () => [PATHS.POWER, { power: 'ON' }],
  /** Network standby: the device keeps its websocket and can be woken up. */
  standby: () => [PATHS.POWER, { power: 'NETWORK' }],
  setVolume: (percent) => [PATHS.ZONE_STATE, { zone: ZONE, volume_percent: percent }],
  setMute: (mute) => [PATHS.ZONE_STATE, { zone: ZONE, mute }],
  setSource: (id) => [PATHS.ZONE_STATE, { zone: ZONE, source: id }],
  play: () => [PATHS.PLAY_CONTROL, { match: 'none', zone: ZONE, action: 'play' }],
  pause: () => [PATHS.PLAY_CONTROL, { match: 'none', zone: ZONE, action: 'pause' }],
  toggle: () => [PATHS.PLAY_CONTROL, { match: 'none', zone: ZONE, action: 'toggle' }],
  next: () => [PATHS.PLAY_CONTROL, { match: 'none', zone: ZONE, skip_track: 1 }],
  previous: () => [PATHS.PLAY_CONTROL, { match: 'none', zone: ZONE, skip_track: -1 }],
});
