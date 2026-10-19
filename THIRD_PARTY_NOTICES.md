# Third-party notices

This integration ports to JavaScript the logic of the following project: the
StreamMagic websocket protocol (`ws://<ip>/smoip`, the `{ path, params }`
messages, the answers matched by path, the subscriptions `{ update: 100,
zone }`), the paths and the command parameters (power, volume, mute, source,
play control), the fields of the payloads, and the play / pause / toggle
choice of Home Assistant (`src/streammagic/`). Nothing of it is installed at
runtime; its notice is reproduced below.

## aiostreammagic 2.13.2

<https://github.com/noahhusby/aiostreammagic> (the library behind the Home
Assistant Cambridge Audio integration), tag `2.13.2` of 2026-06-05

```
MIT License

Copyright (c) 2024 Noah Husby

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, Cambridge Audio integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/cambridge_audio>
(Apache License 2.0): only consulted, no code copied. The mDNS service types
it browses (`_stream-magic._tcp`, `_smoip._tcp`), its use of the `unit_id` as
the identity of a device, the volume offered only with the pre-amplifier on,
and the play / pause fallback to the toggle are reused as facts.

## ws

<https://github.com/websockets/ws> (MIT), installed at runtime: it is already
the websocket library of the Gladys integration SDK. Its license is shipped in
`node_modules/ws/LICENSE` inside the image.

## LM1LC3N7/gladys-devialet and LM1LC3N7/gladys-denon-avr

The structure of the app, the `/data` store and the handler wiring follow
integrations of the same author, under the Apache License 2.0 of this
repository.
