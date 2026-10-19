// -----------------------------------------------------------------------------
// Known devices -> Gladys devices and states (pure). One Gladys device per
// StreamMagic device, keyed by its `unit_id`: the address may change, the unit
// id does not.
//
// The categories and types are the ones of the Gladys core: `music` like the
// core Sonos service (volume, play, pause, next, previous, playback state),
// `television/volume-mute` for the mute press (music has no mute type),
// `text/select` for the source, `text/text` for the title, `button/push` for
// "Power on" and "Standby", and the power state read only (`unknown/binary`):
// no switch, nothing an "everything on / off" (voice assistants, scenes) could
// turn into a command. No unit: the core lists none for these categories.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE, FEATURES, NOTHING } from './constants.js';
import { isPlaying, nowPlaying } from './streammagic/parse.js';

/** The feature definitions, by frozen key, in their frozen order. */
export const FEATURE_SPECS = Object.freeze({
  [FEATURES.POWER]: {
    name: 'Power',
    category: C.UNKNOWN,
    type: T.SENSOR.BINARY,
    min: 0,
    max: 1,
    read_only: true,
    keep_history: true,
  },
  [FEATURES.POWER_ON]: {
    name: 'Power on',
    category: C.BUTTON,
    type: T.BUTTON.PUSH,
    min: 0,
    max: 1,
  },
  [FEATURES.STANDBY]: { name: 'Standby', category: C.BUTTON, type: T.BUTTON.PUSH, min: 0, max: 1 },
  [FEATURES.VOLUME]: {
    name: 'Volume',
    category: C.MUSIC,
    type: T.MUSIC.VOLUME,
    min: 0,
    max: 100,
    has_feedback: true,
  },
  [FEATURES.MUTE]: {
    name: 'Mute',
    category: C.TELEVISION,
    type: T.TELEVISION.VOLUME_MUTE,
    min: 0,
    max: 1,
    has_feedback: true,
  },
  [FEATURES.PLAY]: { name: 'Play', category: C.MUSIC, type: T.MUSIC.PLAY, min: 1, max: 1 },
  [FEATURES.PAUSE]: { name: 'Pause', category: C.MUSIC, type: T.MUSIC.PAUSE, min: 1, max: 1 },
  [FEATURES.NEXT]: { name: 'Next', category: C.MUSIC, type: T.MUSIC.NEXT, min: 1, max: 1 },
  [FEATURES.PREVIOUS]: {
    name: 'Previous',
    category: C.MUSIC,
    type: T.MUSIC.PREVIOUS,
    min: 1,
    max: 1,
  },
  [FEATURES.PLAYBACK]: {
    name: 'Playback',
    category: C.MUSIC,
    type: T.MUSIC.PLAYBACK_STATE,
    min: 0,
    max: 1,
    read_only: true,
  },
  [FEATURES.SOURCE]: {
    name: 'Source',
    category: C.TEXT,
    type: T.TEXT.SELECT,
    min: 0,
    max: 0,
    has_feedback: true,
  },
  [FEATURES.TITLE]: {
    name: 'Now playing',
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
  },
});

/** The options of the "Source" dropdown: every source this device has shown. */
export const sourceOptions = (device) =>
  (Array.isArray(device.sourceOptions) ? device.sourceOptions : []).map(({ value, label }) => ({
    value,
    label,
  }));

export function deviceName(device) {
  const name = device.name || `Cambridge Audio ${device.unitId}`;
  return device.model && device.model !== name ? `${name} (${device.model})` : name;
}

export function buildDevice(gladys, device) {
  const ids = gladys.externalIds(DEVICE_TYPE, device.unitId);
  return {
    name: deviceName(device),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'IP_ADDRESS', value: device.host || '' }],
    // Always the full, fixed list: a device published again never loses a feature.
    features: Object.entries(FEATURE_SPECS).map(([key, { name, ...spec }]) => ({
      name,
      external_id: ids.feature(key),
      read_only: false,
      has_feedback: false,
      keep_history: false,
      ...spec,
      ...(key === FEATURES.SOURCE ? { supported_options: sourceOptions(device) } : {}),
    })),
  };
}

/** The feature key of a feature external id of `device`, or undefined. */
export function featureKey(deviceExternalId, featureExternalId) {
  const prefix = `${deviceExternalId}:`;
  return String(featureExternalId ?? '').startsWith(prefix)
    ? String(featureExternalId).slice(prefix.length)
    : undefined;
}

/**
 * The states of a device. `state` is the link state ({ zone, play }) of a
 * connected device, `null` for a device that does not answer (power 0 only),
 * undefined for "nothing known" (nothing published).
 */
export function stateList(gladys, device, state) {
  if (state === undefined) {
    return [];
  }
  const ids = gladys.externalIds(DEVICE_TYPE, device.unitId);
  const id = (key) => ids.feature(key);
  if (state === null) {
    return [{ device_feature_external_id: id(FEATURES.POWER), state: 0 }];
  }
  const states = [];
  const zone = state.zone ?? {};
  if (typeof zone.power === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.POWER), state: zone.power ? 1 : 0 });
  }
  if (zone.preAmp === true && Number.isInteger(zone.volume)) {
    states.push({ device_feature_external_id: id(FEATURES.VOLUME), state: zone.volume });
  }
  if (typeof zone.mute === 'boolean') {
    states.push({ device_feature_external_id: id(FEATURES.MUTE), state: zone.mute ? 1 : 0 });
  }
  if (
    typeof zone.source === 'string' &&
    sourceOptions(device).some((option) => option.value === zone.source)
  ) {
    states.push({ device_feature_external_id: id(FEATURES.SOURCE), text: zone.source });
  }
  const playing = isPlaying(state.play);
  if (playing !== undefined) {
    states.push({ device_feature_external_id: id(FEATURES.PLAYBACK), state: playing });
  }
  if (state.play) {
    states.push({
      device_feature_external_id: id(FEATURES.TITLE),
      text: (zone.power === false ? undefined : nowPlaying(state.play)) ?? NOTHING,
    });
  }
  return states;
}
