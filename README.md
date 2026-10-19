# gladys-cambridge-audio

[Gladys Assistant](https://gladysassistant.com) external integration for
**Cambridge Audio** amplifiers and streamers with **StreamMagic**, on the
local network: power on, standby, volume (capped by an option), mute, source,
play, pause, next, previous and the title playing, through the websocket of
the devices (`ws://<ip>/smoip`), without any cloud. Unofficial, not
affiliated with Cambridge Audio.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake device only,
> never with a real Cambridge Audio device.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (CambridgeAudioApp)
                                   ├─ src/streammagic/link.js        one address: websocket, snapshot, subscriptions, spaced reconnection
                                   ├─ src/streammagic/connection.js  one session: requests matched by path, bounded messages (ws)
                                   ├─ src/streammagic/endpoints.js   paths and command messages (ported)
                                   ├─ src/streammagic/parse.js       payloads -> clean objects (ported, untrusted input)
                                   ├─ src/model.js                   known devices -> Gladys devices and states (pure)
                                   └─ src/store.js                   /data/cambridge-audio.json: known devices, their sources
```

- **Devices** are added by IP address (configuration), or found with
  `gladys.scanNetwork('mdns')` (services `_stream-magic._tcp` and
  `_smoip._tcp`, optional: a failure never blocks). Each device is identified
  by the `unit_id` of `/system/info` (external id `streammagic:<unit_id>`).
- **One websocket per address**, kept open: on connection the snapshot is
  read (`/system/info`, `/system/sources`, `/zone/state`, `/zone/play_state`,
  `/zone/now_playing`), then those paths are subscribed to and every pushed
  update is published (grouped, at most once a second per device). A ping
  every 30 s; no pong in 10 s closes the socket. Reconnection after 10 s, then
  doubled after each failure up to 5 minutes; the count is only reset by a
  connection that stayed up one minute.
- **Commands**: validated first (volume an integer 0..100, source among the
  dropdown options), the volume capped by `max_volume` (read just before
  sending), serialized per device, each within a 3.5 s budget (Gladys acks in
  5 s), dropped when they cannot start in time. Mute is a press: the state is
  read just before and the explicit value sent. Play and pause use the
  explicit action, or the toggle only after the play state read again says it
  is needed. A message that may have reached the device is reported "sent,
  without confirmation".
- **Features**: `music` (volume, play, pause, next, previous, playback state)
  like the core Sonos service, `television/volume-mute`, `text/select`
  (source), `text/text` (title), `button/push` (power on, standby) and a
  read-only `unknown/binary` power state. No switch.
- **Bounded input**: 256 KB per message (`ws` `maxPayload`), binary frames
  ignored, one `JSON.parse` per message, only the expected fields kept, 32
  pending requests at most, a socket flooded with more than 300 messages in 10
  s is closed.

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake device)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeStreamMagic.js` is a fake StreamMagic device on 127.0.0.1
(the paths used, pushed updates, silent and refusing modes). The end-to-end
tests run the real handlers against the SDK's fake Gladys.

## Credits

- [`aiostreammagic`](https://github.com/noahhusby/aiostreammagic) 2.13.2 by
  Noah Husby (MIT), the library behind the Home Assistant Cambridge Audio
  integration: the protocol, paths, commands and payload fields are ported
  from it to JavaScript.
- The Home Assistant Cambridge Audio integration (Apache-2.0) was consulted
  for the discovery, the identity and the play / pause behaviour.
- [`ws`](https://github.com/websockets/ws) (MIT), the websocket library the
  Gladys SDK already uses.
- The app structure follows
  [LM1LC3N7/gladys-devialet](https://github.com/LM1LC3N7/gladys-devialet) and
  [LM1LC3N7/gladys-denon-avr](https://github.com/LM1LC3N7/gladys-denon-avr)
  (same author, Apache-2.0).

Cambridge Audio and StreamMagic are trademarks of their owner, used here only
to name the compatible products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (aiostreammagic,
MIT): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
