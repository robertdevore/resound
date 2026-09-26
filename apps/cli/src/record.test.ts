import { describe, expect, it } from "vitest";
import {
  buildFfmpegArgs,
  isCleanFfmpegClose,
  isInteractiveStopInput,
} from "./record.js";

describe("buildFfmpegArgs", () => {
  it("builds a single-device capture", () => {
    const args = buildFfmpegArgs({ outFile: "/tmp/a.wav", device: "1" });
    expect(args.join(" ")).toContain("-f avfoundation -i :1");
    expect(args.join(" ")).toContain("-ac 1 -ar 16000");
    expect(args).toContain("/tmp/a.wav");
    expect(args).not.toContain("-filter_complex");
  });

  it("mixes system + mic with amix", () => {
    const args = buildFfmpegArgs({
      outFile: "/tmp/a.wav",
      systemDevice: "1",
      micDevice: "2",
    });
    const s = args.join(" ");
    expect(s).toContain("-f avfoundation -i :1");
    expect(s).toContain("-f avfoundation -i :2");
    expect(s).toContain("[0:a][1:a]amix=inputs=2:duration=longest[a]");
    expect(s).toContain("-map [a]");
  });

  it("adds a duration limit when given", () => {
    const args = buildFfmpegArgs({
      outFile: "/tmp/a.wav",
      device: "1",
      durationSec: 30,
    });
    expect(args.join(" ")).toContain("-t 30");
  });

  it("throws when no device is provided", () => {
    expect(() => buildFfmpegArgs({ outFile: "/tmp/a.wav" })).toThrow(
      /No capture device/,
    );
  });
});

describe("isCleanFfmpegClose", () => {
  it("accepts normal exits and intentional terminal stops", () => {
    expect(isCleanFfmpegClose(0, null)).toBe(true);
    expect(isCleanFfmpegClose(255, null)).toBe(true);
    expect(isCleanFfmpegClose(null, "SIGINT")).toBe(true);
    expect(isCleanFfmpegClose(null, "SIGTERM")).toBe(true);
  });

  it("rejects unexpected exits", () => {
    expect(isCleanFfmpegClose(1, null)).toBe(false);
    expect(isCleanFfmpegClose(null, "SIGHUP")).toBe(false);
  });
});

describe("isInteractiveStopInput", () => {
  it("accepts Enter, q, and raw Ctrl+C as stop input", () => {
    expect(isInteractiveStopInput("\n")).toBe(true);
    expect(isInteractiveStopInput("\r")).toBe(true);
    expect(isInteractiveStopInput("q")).toBe(true);
    expect(isInteractiveStopInput("Q")).toBe(true);
    expect(isInteractiveStopInput("\u0003")).toBe(true);
  });

  it("ignores other input", () => {
    expect(isInteractiveStopInput("hello")).toBe(false);
  });
});

it("fails explicitly when ffmpeg ignores stop, with bounded diagnostics", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { recordAudio } = await import("./record.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-ffmpeg-stop-"));
  const launcher = path.join(dir, "ffmpeg");
  fs.writeFileSync(
    launcher,
    "#!/bin/sh\nwhile read line; do :; done\nexec sleep 60\n",
    { mode: 0o700 },
  );
  try {
    const recording = recordAudio({
      outFile: path.join(dir, "audio.wav"),
      device: "synthetic",
      ffmpegPath: launcher,
      stopTimeoutMs: 100,
    });
    recording.stop();
    await expect(recording.done).rejects.toThrow(/SIGKILL/);
    expect(
      fs.statSync(path.join(dir, "audio.wav.stderr.log")).mode & 0o077,
    ).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects instead of throwing from an event when a diagnostic file disappears", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { recordAudio } = await import("./record.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-ffmpeg-log-"));
  const launcher = path.join(dir, "ffmpeg");
  const outFile = path.join(dir, "audio.wav");
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nrm -- "${outFile}.stderr.log"\nexit 1\n`,
    { mode: 0o700 },
  );
  try {
    await expect(
      recordAudio({ outFile, device: "synthetic", ffmpegPath: launcher }).done,
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
