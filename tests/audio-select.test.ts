import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { alsaHwId, preferCaptureId, preferPlaybackId } from "../src/audio.ts";

const ALSA_UMIK = "card 1: U18dB [Umik-1  Gain: 18dB], device 0: USB Audio [USB Audio]";
const ALSA_DMIC = "card 0: sofhdadsp [sof-hda-dsp], device 6: DMIC (*) []";
const PULSE_UMIK = "pulse:alsa_input.usb-miniDSP_Umik-1_Gain__18dB_00002-00.analog-stereo";
const PULSE_GOOGLE = "pulse:alsa_output.usb-Google_Inc_Headphone_adapter_09SG019BLXTK03WY-00.analog-stereo";
const PULSE_SPEAKER = "pulse:alsa_output.pci-0000_00_1f.3-platform-skl_hda_dsp_generic.HiFi__Speaker__sink";
const ALSA_ADAPTER = "card 2: adapter [Headphone adapter], device 0: USB Audio [USB Audio]";

describe("device auto-select", () => {
  it("prefers the UMIK-1 ALSA card over DMIC and over pulse", () => {
    assert.equal(preferCaptureId([ALSA_DMIC, ALSA_UMIK, PULSE_UMIK]), ALSA_UMIK);
  });
  it("falls back to pulse UMIK, then DMIC", () => {
    assert.equal(preferCaptureId([ALSA_DMIC, PULSE_UMIK]), PULSE_UMIK);
    assert.equal(preferCaptureId([ALSA_DMIC]), ALSA_DMIC);
    assert.equal(preferCaptureId([]), undefined);
  });
  it("prefers the Google adapter pulse sink for playback", () => {
    assert.equal(preferPlaybackId([ALSA_ADAPTER, PULSE_SPEAKER, PULSE_GOOGLE]), PULSE_GOOGLE);
    assert.equal(preferPlaybackId([ALSA_ADAPTER]), undefined);
  });
  it("maps the UMIK-1 ALSA label to its plughw id", () => {
    assert.equal(alsaHwId(ALSA_UMIK), "plughw:1,0");
  });
});
