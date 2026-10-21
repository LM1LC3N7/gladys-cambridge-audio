# Cambridge Audio (StreamMagic) for Gladys

Control your **Cambridge Audio** amplifiers and streamers with **StreamMagic**
(CXN, MXN, EVO, CXA, AXN, Edge…) from Gladys, locally, without any cloud:
power on, standby, volume, mute, source, play, pause, next, previous and the
title playing.

> **Important.** This integration has never been tested with a real device:
> it was written from the `aiostreammagic` library (the one Home Assistant
> uses) and tested against a fake device only. Your feedback is welcome.
> Unofficial integration, not affiliated with Cambridge Audio.

## Setup

1. Give each device a **fixed IP address** in your router (reserved DHCP
   lease).
2. In Gladys, install the **Cambridge Audio** integration, then open its
   configuration.
3. Type the IP addresses, separated by commas (for example
   `192.168.1.40, 192.168.1.41`). The **Find the devices** button can also
   look for them on the network (mDNS, optional: the search cannot cross
   every network).
4. Choose the **volume cap** (50 % by default).
5. The devices appear in the **Discovery** tab: create them.

The integration keeps a websocket open with each device (`ws://<ip>/smoip`,
port 80): changes made on the device, its remote or the StreamMagic app show
in Gladys right away.

## What you get

| Feature        | Gladys type                | Note                                                      |
| -------------- | -------------------------- | --------------------------------------------------------- |
| Power          | binary state (read only)   | 1 on, 0 in standby or unreachable                         |
| Power on       | button                     | wakes the device from network standby                     |
| Standby        | button                     | puts the device in network standby                        |
| Volume         | music / volume (0 to 100)  | capped, only when the pre-amplifier of the device is on   |
| Mute           | button (television / mute) | each press reads the state, then sets the opposite        |
| Play, pause    | music buttons              | the explicit action, or the toggle only when it is needed |
| Next, previous | music buttons              |                                                           |
| Playback       | music state (read only)    | 1 playing, 0 otherwise                                    |
| Source         | dropdown                   | the sources of the device; the list only grows            |
| Now playing    | text (read only)           | "Artist - Title" (or the station); "—" when nothing plays |

On purpose, no **switch**: an "everything off" or "everything on" from a
voice assistant or a scene neither wakes nor cuts your amplifier.

## Volume cap

The volume asked from Gladys (dashboard, scene, voice assistant) never goes
above the cap of the configuration: a higher volume is set to the cap. The
cap is read again just before sending: a new value saved applies at once. The
volume set on the device itself (knob, remote, app) is not changed by the
integration, except in the two cases where Gladys would make it heard:

- **Unmute**: when the volume of the device is above the cap, it is set to
  the cap first, then the mute is removed, only once the device says its
  volume is at or under the cap; otherwise the mute is kept ("volume not
  lowered to the cap, mute kept"). When the volume cannot be read, nothing is
  sent.
- **Power on**: after the wake-up, the volume is read again and set to the
  cap when above it. When the device is slow to wake up, or does not confirm
  the lowering, the integration checks again every 2.5 s for about 15 s; a
  volume turned up above the cap during those 15 s is lowered too. After
  that, or after a Standby, the volume is not corrected (the device resumes
  the volume it had before standby).

When the pre-amplifier of the device is off (a streamer plugged into another
amplifier), the volume is neither shown nor set: set it on the amplifier.

## Standby and reconnection

- In **network standby**, the device stays reachable: Power goes to 0 and the
  Power on button wakes it up.
- In **eco standby**, the device leaves the network: it shows as off, is named
  in the integration status, and the integration tries to connect again at
  spaced intervals (10 s, then doubled after each failure, up to 5 minutes).
  The Power on button cannot do anything then.
- When another device answers at the address of a created one (address
  changed), its address is forgotten and a search runs by itself every 10
  minutes; you can also type the new address.

## Commands

Every command is answered within 4 seconds (Gladys waits 5 seconds). Power
on, standby, volume, mute and source are confirmed only when the device gives
back the value asked (a device can accept a message and ignore it); a command
that left for the device without that confirmation is reported "sent,
without confirmation", and the state pushed by the device then shows what it
did. A command that could not leave is reported "nothing sent": so is any
command, Standby included, to a device that is not connected. Standby never
waits behind another command, and cancels the commands still waiting that
could wake the device up (power on, source, play, next, previous: "cancelled
by Standby, nothing sent"). Mute goes before the commands waiting.

When the source only offers the play/pause toggle, Play acts only when paused
or stopped, Pause only when playing; in an in-between state (connecting,
buffering…), the command is refused and nothing is sent.

## Configuration buttons

- **Find the devices**: mDNS search through Gladys, then the typed addresses.
- **Check the devices**: the connection, power and volume of each device, and
  the cap in force.

## Data and privacy

The integration asks for no account and no password: the StreamMagic
websocket has none. It keeps in `/data/cambridge-audio.json` the list of the
known devices (id, address, name, model, sources). Nothing leaves your local
network.

## Known limits

- One zone (`ZONE1`), as the StreamMagic app.
- No presets, radio, equalizer, balance, display brightness, repeat or
  shuffle yet.
- Never tested with a real device: the real answers may differ.
