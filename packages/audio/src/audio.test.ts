import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  MockRecorder,
  buildSystemFfmpegArgs,
  isCleanSystemRecorderClose,
  pcmDurationSeconds,
  pcmToWav
} from "./index.js";

describe("mock recorder", () => {
  it("writes chunk files and returns chunk metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-audio-"));
    const recorder = new MockRecorder({
      participants: [{ id: "9", username: "Jelena" }]
    });
    await recorder.start({ sessionDir: dir });
    const chunks = await recorder.stop();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.username).toBe("Jelena");
    expect(fs.existsSync(chunks[0]!.path)).toBe(true);
    expect(fs.existsSync(path.join(dir, "audio", "chunks"))).toBe(true);
  });
});

describe("pcm → wav", () => {
  const fmt = { sampleRate: 48000, channels: 2, bitDepth: 16 };

  it("writes a valid 44-byte RIFF/WAVE header", () => {
    const pcm = Buffer.alloc(960 * 2 * 2); // one 10ms-ish stereo frame
    const wav = pcmToWav(pcm, fmt);
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.length).toBe(pcm.length + 44);
  });

  it("computes duration from buffer length", () => {
    // 48000 samples * 2 channels * 2 bytes = 1 second of stereo s16le
    const pcm = Buffer.alloc(48000 * 2 * 2);
    expect(pcmDurationSeconds(pcm, fmt)).toBeCloseTo(1, 5);
  });
});

describe("system recorder helpers", () => {
  it("builds a single-device avfoundation capture", () => {
    const args = buildSystemFfmpegArgs({ outFile: "/tmp/a.wav", device: "1" });
    expect(args.join(" ")).toContain("-f avfoundation -i :1");
    expect(args.join(" ")).toContain("-ac 1 -ar 16000");
    expect(args).toContain("/tmp/a.wav");
    expect(args).not.toContain("-filter_complex");
  });

  it("mixes system and mic devices", () => {
    const args = buildSystemFfmpegArgs({
      outFile: "/tmp/a.wav",
      systemOutFile: "/tmp/system.wav",
      micOutFile: "/tmp/mic.wav",
      systemDevice: "1",
      micDevice: "2"
    });
    const rendered = args.join(" ");
    expect(rendered).toContain("-f avfoundation -i :1");
    expect(rendered).toContain("-f avfoundation -i :2");
    expect(rendered).toContain("aresample=16000:async=1:first_pts=0");
    expect(rendered).toContain("amix=inputs=2:duration=longest:normalize=0");
    expect(rendered).toContain("-map [mix]");
    expect(rendered).toContain("-map 0:a");
    expect(rendered).toContain("/tmp/system.wav");
    expect(rendered).toContain("-map 1:a");
    expect(rendered).toContain("/tmp/mic.wav");
  });

  it("requires at least one capture device", () => {
    expect(() => buildSystemFfmpegArgs({ outFile: "/tmp/a.wav" })).toThrow(/No capture device/);
  });

  it("accepts intentional ffmpeg stop exits", () => {
    expect(isCleanSystemRecorderClose(0, null)).toBe(true);
    expect(isCleanSystemRecorderClose(255, null)).toBe(true);
    expect(isCleanSystemRecorderClose(null, "SIGINT")).toBe(true);
    expect(isCleanSystemRecorderClose(null, "SIGTERM")).toBe(true);
    expect(isCleanSystemRecorderClose(1, null)).toBe(false);
  });
});
