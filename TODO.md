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
  as aiostreammagic's `power_off`: the device can be woken up again).
  (Review 2026-10-19) Standby on a device that is not connected is an error
  (UNREACHABLE, "… nothing sent"), never a success: a device whose
  connection just dropped may still be on, "already in standby" would be a
  guess.
- **Volume cap** (`max_volume`, 1..100, default 50 %): a higher volume asked
  from Gladys is set to the cap (clamped, logged), not refused, so a scene
  "volume 80" still does something. The cap is read inside the queued task,
  just before the message leaves (a configuration saved meanwhile applies).
  The feature range stays 0..100 (frozen at creation: changing the cap never
  changes the device structure). A volume set on the device itself above the
  cap is shown, not lowered while the device plays, except by the two
  commands of Gladys that would make it heard (review 2026-10-19):
  - unmute: the volume read with the mute decides; above the cap,
    `volume_percent: <cap>` is sent first, then `mute: false`, in the same
    budget; volume unknown (pre-amplifier on): refused, "nothing sent";
  - Power on: `/zone/state` is read again after the wake-up, and the volume
    lowered to the cap when above it; when the device cannot tell yet
    (still waking up), checked again every 1.5 s, 10 times at most, through
    the device queue (the ack of Power on never depends on it). After that,
    nothing more is done (said in the docs).
    The volume is only set and published when `pre_amp_mode` is true (as Home
    Assistant): otherwise refused, "nothing sent".
- Volume validated strictly before queueing: an integer 0..100 as a number or
  a string of digits; null, '', booleans, 12.5, '12abc', NaN refused.
- Mute is a push (Gladys sends a press, not a target): `/zone/state` is read
  again just before (1.5 s at most) and the explicit `mute: true|false` sent,
  never a toggle. Unknown mute state: nothing sent. Not a switch.
- Play / pause: the explicit action when the source lists it in `controls`
  (or lists nothing), else the toggle, decided on `/zone/play_state` read
  again (review 2026-10-19): Play toggles only from `pause` or `stop`
  (nothing to do on `play`), Pause only from `play` (nothing to do on
  `pause` or `stop`); any other state (`connecting`, `buffering`, `ready`,
  `NETWORK`, unknown) is refused, "play state X, nothing sent". Next /
  previous: `skip_track` ±1.
- Queue (review 2026-10-19): Standby and Mute go before the commands still
  waiting (after the other urgent ones), never before the one running.
- Late answers (review 2026-10-19): after a request timed out, the first
  `response` on its path within 2 s is dropped (data included), so it never
  settles the next request on that path with an old state.
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
  never sooner than 10 s after the last attempt; a reconnection to Gladys
  (`connected`) does not (review 2026-10-19: Gladys flapping must never make
  the devices asked faster). A ping every 30 s, no pong
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
  sends them; no User-Agent set. (Review 2026-10-19) `Host` kept: Node would
  send `Host: <host>` without `:80`, aiostreammagic forces `<host>:80`, and
  whether the device needs it is not known without a real device (milestone
  2: drop it if useless).
- mDNS answers (review 2026-10-19): only IPv4 addresses of a local network
  are asked (10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 but
  169.254.169.254); public, loopback, 0/8, broadcast (x.x.x.255,
  255.255.255.255) and multicast never. Typed addresses are not filtered.
- Flood guard (review 2026-10-19): every frame counts, before parsing
  (junk, binary frames and unknown paths included).
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
