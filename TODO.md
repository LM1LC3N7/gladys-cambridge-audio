# TODO — Cambridge Audio v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-19): devices added by IP
      address or found by mDNS (`scanNetwork('mdns')`, optional), identity by
      unit id; one persistent websocket per address with pushed updates and
      spaced reconnection; power state, power on, standby, volume capped by
      `max_volume`, mute, play/pause/next/previous, playback state, source
      dropdown, title; "Find" and "Check" buttons; docs en/fr. Tested against a
      fake device on the loopback interface only, never with a real device.
      The store validator could not be run from the development session (no
      access to it there): to run before the first release.
- [ ] **Milestone 2 — real devices** (testers with a CXN, MXN, EVO, CXA or
      AXN). To check first:
  - the answer to a subscription message (a `response` or nothing), and the
    `type` of the pushed updates;
  - whether the device checks the `Origin` / `Host` headers of the upgrade
    (sent as aiostreammagic does);
  - the `unit_id` of `/system/info` against the `serial` TXT record of the
    mDNS announce (Home Assistant uses both as the same unique id), and the
    port announced by `_stream-magic._tcp` / `_smoip._tcp` (the websocket is
    always asked on port 80 today);
  - `volume_percent` and `pre_amp_mode` of an integrated amplifier (EVO, CXA
    with network module) and of a streamer feeding another amplifier;
  - what a device in network standby and in eco standby answers (today:
    network standby keeps the socket, eco standby closes it);
  - the `controls` of each source (radio, Spotify, AirPlay, inputs) and the
    play state values;
  - the rendering on the Gladys dashboard (not checked here): the `music`
    buttons (min = max = 1, as the core Sonos service), the
    `television/volume-mute` press, the two `button/push` buttons, the
    `unknown/binary` power, the `text/select` Source and the `text/text`
    title.
- [ ] **Milestone 3 — more**: presets and radio (`/presets/list`,
      `/zone/recall_preset`), volume up/down buttons, repeat/shuffle, the
      device's own volume limit (`/zone/audio` `volume_limit_percent`), a
      "forget a device" action.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: noahhusby/aiostreammagic 2.13.2 (MIT, tag of 2026-06-05, the library
  of the Home Assistant Cambridge Audio integration) is Python (aiohttp), so
  its protocol, paths, commands and payload fields are ported to JavaScript
  (`src/streammagic/`); MIT notice in `THIRD_PARTY_NOTICES.md`, copied into
  the image. The Home Assistant integration was read for the discovery
  (mDNS services, `unit_id` as unique id), the volume only with the
  pre-amplifier on, and the play / pause fallback to the toggle.
- Runtime dependency `ws` (^8.18.0, MIT) besides the SDK: the SDK already
  depends on it (deduplicated, nothing more in the image); it gives the
  `maxPayload` bound, the handshake timeout, the headers and ping/pong. Node's
  built-in WebSocket has no message size limit.
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('streammagic', <unit_id>)`, never the
  address. Feature keys are frozen: `power`, `power_on`, `standby`, `volume`,
  `mute`, `play`, `pause`, `next`, `previous`, `playback`, `source`, `title`.
  Every publication carries the full, fixed feature list (a device published
  again never loses a feature); only the source options grow (merged with the
  `supported_options` of the created device).
- **Power: read-only state + two `button/push` ("Power on", "Standby"), not a
  `switch`.** Lesson of lot 6: an "everything on / off" (voice assistants,
  `switch.*` scenes) must not wake an amplifier up nor cut it. The power state
  is `unknown/binary`, read only (`zone.power`; 0 also when the device does
  not answer after a failed connection attempt, not on a simple drop).
  "Power on" sends `power: ON`, "Standby" `power: NETWORK` (network standby,
  as aiostreammagic's `power_off`: the device can be woken up again). Standby
  on a device that is not connected sends nothing and is not an error.
- **Volume cap** (`max_volume`, 1..100, default 50 %): a higher volume asked
  from Gladys is set to the cap (clamped, logged), not refused, so a scene
  "volume 80" still does something. The cap is read inside the queued task,
  just before the message leaves (a configuration saved meanwhile applies).
  The feature range stays 0..100 (frozen at creation: changing the cap never
  changes the device structure). A volume set on the device itself above the
  cap is shown, never lowered by the integration. The volume is only set and
  published when `pre_amp_mode` is true (as Home Assistant): otherwise
  refused, "nothing sent".
- Volume validated strictly before queueing: an integer 0..100 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Mute is a push (Gladys sends a press, not a target): `/zone/state` is read
  again just before (1.5 s at most) and the explicit `mute: true|false` sent,
  never a toggle. Unknown mute state: nothing sent. Not a switch.
- Play / pause: the explicit action when the source lists it in `controls`
  (or lists nothing), else the toggle, sent only after `/zone/play_state`
  read again says it is needed (Play while playing, Pause while paused: nothing
  sent). Next / previous: `skip_track` ±1.
- Source: the select values are the source ids of the device (`/system/sources`,
  plain identifiers only), labels their names. A command is checked against
  the options, then against the list read again from the device.
- Commands: serialized per device, budget 3.5 s from the Gladys request (the
  wait in the queue included), each request bounded by what is left; a
  command still queued at its deadline is dropped, never sent late. A message
  that may have reached the device (sent, then no answer or socket closed) is
  answered "sent, without confirmation" (the pushed state shows the result);
  a device that is not connected gets "nothing sent". An error result of the
  device is answered "Refused by the device: <message>".
- Connection: one websocket per address (typed addresses and known devices),
  kept across reconnections to Gladys (`connected` only clears the status
  cache and `forgetPublishedStates`, then republishes the status, the
  devices and the states). Reconnection after 10 s, doubled after each
  failure up to 5 minutes; the count is only reset by a connection that
  stayed up 60 s (a device that drops right after connecting is not asked
  every 10 s). A configuration save or a search asks for a reconnection, but
  never sooner than 10 s after the last attempt. A ping every 30 s, no pong
  within 10 s closes the socket. Not persisted in /data: there is no rate
  limit nor credential to protect, and a restart starting over at 10 s is
  wanted.
- Reachability: a failed connection attempt is "eco standby, off or
  unreachable": power 0, named in the status message. A connection lost then
  reopened at the first attempt publishes nothing. When a device answers, its
  unit id is read first: another device at that address clears the old one's
  address (DHCP), never commanded there; a search then runs by itself every
  10 minutes while a created device has no address. The status stays
  "connected" (local integration, no account).
- Hostile input: 256 KB per message (`ws` `maxPayload`, the socket is closed
  above), binary frames ignored, one `JSON.parse` per message, only the
  expected fields of the expected types kept, strings cleaned (control and
  bidi characters) and cut (200 characters for the title, 64 for names), ids
  kept only when plain identifiers (never `__proto__`, `constructor`,
  `prototype`), 40 sources, 20 devices, 50 mDNS results, 32 pending requests
  at most; more than 300 messages in 10 s closes the socket (then spaced
  reconnection). No redirect followed, no compression negotiated. The device
  table of `/data` has no prototype.
- Headers: `Origin: ws://<host>` and `Host: <host>:<port>` as aiostreammagic
  sends them (the device checks them); no User-Agent set.
- Publication: grouped per device (at most one `publishChangedStates` per
  second), only the created devices. Text features show "—" when nothing
  plays (and in standby).
- Categories and types from the core only (`server/utils/constants.js`):
  `music` for volume, play, pause, next, previous and playback state (as the
  core Sonos service), `television/volume-mute` for mute (music has no mute
  type), `text/select` and `text/text`, `button/push`, `unknown/binary`. No
  unit: `DEVICE_FEATURE_UNITS_BY_CATEGORY` lists none for music, television,
  text, button or unknown. Store category `multimedia`.
- mDNS: `_stream-magic._tcp` and `_smoip._tcp` (the services Home Assistant
  browses); the websocket is always asked on port 80 (as aiostreammagic),
  whatever port the service announces.
- One zone, `ZONE1`, as aiostreammagic.
