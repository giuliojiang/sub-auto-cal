# sub-auto-cal

Auto-calibration tool for the t.racks DSP 4x4 Mini. Node.js + TypeScript,
run directly by Node's type stripping; TypeScript 7 typechecks on demand.

## Run

```sh
npm install
npm start            # serves http://127.0.0.1:8080, open it in a browser
npm test             # node:test suite
npm run typecheck    # tsc --noEmit (typescript 7)
```

## Layout

```text
src/main.ts          entry point
src/server.ts        HTTP API + static UI
src/dsp/protocol.ts  wire codec, scales, command builders (pure)
src/dsp/link.ts      USB-HID transport (node-hid)
src/dsp/device.ts    high-level DSP client (connect, read, setters, snapshot)
src/dsp/simulator.ts in-process virtual DSP behind the same link interface
src/audio.ts         backend WAV synth, playback, capture, level analysis
public/              control-only web UI (no audio device access in browser)
tests/               golden packet tests, scale tests, simulator round-trips
docs/protocol-notes.md  wire spec, written from reading the references
```

## USB permission

The DSP is VID 0168 / PID 0821. Reading it needs access to its hidraw
node; without a rule the connect call fails with a permission hint:

```sh
sudo sh -c 'echo "SUBSYSTEM==\"hidraw\", ATTRS{idVendor}==\"0168\", ATTRS{idProduct}==\"0821\", MODE=\"0660\", GROUP=\"plugdev\"" > /etc/udev/rules.d/99-dsp4x4.rules'
sudo udevadm control --reload && sudo udevadm trigger
# unplug + replug the DSP, user must be in plugdev
```

Until hardware is reachable, `POST /api/connect {"simulator": true}`
drives a virtual DSP with the same interface.

## Licence

MIT. Written from scratch from `docs/protocol-notes.md`; no reference
code is vendored or copied (see the notes for the references' licences).
