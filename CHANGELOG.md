# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Unmute: the mute is kept ("volume not lowered to the cap, mute kept") unless
  the device gives back a volume at or under the cap after the lowering; a
  lowering it accepts but ignores no longer unmutes it above the cap.
- Power on: the volume lowered after the wake-up counts only once the device
  gives it back at or under the cap; otherwise the checks go on.
- Power on: during the checks after a Power on sent by Gladys (about 15 s), a
  volume pushed above the cap is brought back to it through the device queue;
  Standby ends that window.
- Power on, standby, volume, mute and source are confirmed only by a state
  carrying the value asked, never by the answer `result: 200` alone;
  otherwise "sent, without confirmation".
- Standby never waits behind the command running, and the commands still
  waiting that could wake the device (power on, source, play, next,
  previous) are not sent after it ("cancelled by Standby, nothing sent").
- The manifest test no longer pins the version 0.1.0 (it failed since the
  0.1.1 release).

## [0.1.1] - 2026-10-19

### Added

- Cambridge Audio StreamMagic amplifiers and streamers over their local
  websocket, without any cloud: added by IP address, or found with an
  optional mDNS search through Gladys, and kept by their unit id when their
  address changes.
- Power state (read only), "Power on" and "Standby" buttons, volume (0 to
  100, validated strictly, capped by the new `max_volume` option, 50 % by
  default), mute (each press reads the mute and sets the opposite), play,
  pause, next, previous, playback state, a "Source" dropdown read and set,
  and the title playing. Every command is answered to Gladys within 4
  seconds, or dropped, never sent late.
- Changes made on the device, its remote or its app are pushed to Gladys
  (grouped, at most once a second per device).
- A device in eco standby, off or unreachable shows its power at 0 and is
  named in the integration status; the websocket is opened again after 10 s,
  then at intervals doubled up to 5 minutes.
- "Find the devices" and "Check the devices" buttons.
- Unmuting lowers a volume above the cap to the cap first; Power on brings
  the volume back to the cap after the wake-up (checked again every 2.5 s for
  about 15 s when the device is slow to wake up, one check at a time per
  device).
- Standby and mute go before the commands waiting for a device.

### Fixed

- Play and pause through the toggle only from a known state (Play from pause
  or stop, Pause from play); an in-between state is refused, nothing sent.
- Standby on a device that is not connected is reported "nothing sent",
  never as done.
- The late answer of a request that timed out no longer settles the next
  request on the same path.
- A reconnection to Gladys no longer asks the silent devices again sooner.

### Security

- Messages are bounded (256 KB), parsed once, and only the expected fields are
  kept; a unit id or a source id `__proto__`, `constructor` or `prototype` is
  refused, and the device table has no prototype. A socket flooded with
  frames is closed (every frame counts, before parsing).
- The mDNS search only connects to local network addresses (no public,
  loopback, broadcast, multicast or cloud metadata address).

[Unreleased]: https://github.com/LM1LC3N7/gladys-cambridge-audio/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-cambridge-audio/releases/tag/v0.1.1
