import { describe, expect, it } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  MockRecorder,
  PycordDiscordRecorder,
  buildSystemFfmpegArgs,
  isCleanSystemRecorderClose,
  pcmDurationSeconds,
  pcmToWav,
} from "./index.js";

describe("mock recorder", () => {
  it("writes chunk files and returns chunk metadata", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-audio-"));
    const recorder = new MockRecorder({
      participants: [{ id: "9", username: "Jelena" }],
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
      micDevice: "2",
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
    expect(() => buildSystemFfmpegArgs({ outFile: "/tmp/a.wav" })).toThrow(
      /No capture device/,
    );
  });

  it("accepts intentional ffmpeg stop exits", () => {
    expect(isCleanSystemRecorderClose(0, null)).toBe(true);
    expect(isCleanSystemRecorderClose(255, null)).toBe(true);
    expect(isCleanSystemRecorderClose(null, "SIGINT")).toBe(true);
    expect(isCleanSystemRecorderClose(null, "SIGTERM")).toBe(true);
    expect(isCleanSystemRecorderClose(1, null)).toBe(false);
  });
});

describe("pycord discord recorder", () => {
  function createFakePython(dir: string): string {
    const driver = path.join(dir, "fake-sidecar.mjs");
    fs.writeFileSync(
      driver,
      `
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--probe")) {
  console.log(JSON.stringify({ event: "ready", dave: true }));
  process.exit(0);
}

const sessionDir = args[args.indexOf("--session-dir") + 1];
const mixed = path.join(sessionDir, "audio", "raw", "mixed.wav");
fs.mkdirSync(path.dirname(mixed), { recursive: true });
fs.writeFileSync(mixed, "fake");
console.log(JSON.stringify({ event: "ready", dave: true }));

let done = false;
function stop() {
  if (done) return;
  done = true;
  console.log(JSON.stringify({
    event: "stopped",
    tracks: [
      {
        userId: "mixed",
        username: "Discord Mixed",
        path: mixed,
        startSeconds: 0,
        durationSeconds: 1.25
      }
    ],
    warnings: ["sidecar smoke warning"]
  }));
}

process.stdin.setEncoding("utf8");
if (process.argv.includes("--token") || process.env.RESOUND_SIDECAR_TOKEN !== "token") {
  console.log(JSON.stringify({event: "error", message: "unsafe token transport"}));
  process.exit(1);
}
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("stop")) stop();
});
process.stdin.on("end", stop);
`,
      "utf8",
    );
    const launcher = path.join(dir, "fake-python.sh");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${driver}" "$@"\n`,
      "utf8",
    );
    fs.chmodSync(launcher, 0o755);
    return launcher;
  }

  it("probes and stops through the sidecar protocol", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-pycord-"));
    const pythonPath = createFakePython(dir);
    const recorder = new PycordDiscordRecorder({
      token: "token",
      guildId: "123",
      channelId: "456",
      pythonPath,
      startupTimeoutMs: 10_000,
    });

    const preflight = await recorder.preflight({
      sessionDir: dir,
      strictConsent: true,
    });
    expect(preflight.status).toBe("warning");
    expect(preflight.errors).toEqual([]);
    expect(
      preflight.dependencies.some(
        (dep) => dep.name === "pycord-sidecar" && dep.ok,
      ),
    ).toBe(true);

    await recorder.start({ sessionDir: dir });
    expect(recorder.getHealth().status).toBe("recording");

    const chunks = await recorder.stop();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.path).toContain("mixed.wav");
    expect(recorder.getHealth().status).toBe("warning");
    expect(recorder.captureSummary()).toEqual(["sidecar smoke warning"]);
  });

  it("terminates a sidecar that misses the startup deadline", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "resound-pycord-timeout-"),
    );
    const driver = path.join(dir, "hung.mjs");
    const pidFile = path.join(dir, "pid");
    fs.writeFileSync(
      driver,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      "utf8",
    );
    const launcher = path.join(dir, "fake-python.sh");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nif [ "$1" = "${path.resolve("packages/audio/python/discord_native_sidecar.py")}" ] && [ "$2" = "--probe" ]; then echo '{"event":"ready","dave":true,"dave_receive":true}'; exit 0; fi\nexec "${process.execPath}" "${driver}"\n`,
      "utf8",
    );
    fs.chmodSync(launcher, 0o755);
    const recorder = new PycordDiscordRecorder({
      token: "token",
      guildId: "123",
      channelId: "456",
      pythonPath: launcher,
      startupTimeoutMs: 250,
    });

    await expect(recorder.start({ sessionDir: dir })).rejects.toThrow(
      /did not become ready/,
    );
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("forces down a sidecar that misses the stop deadline", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-pycord-stop-"));
    const driver = path.join(dir, "wedged.mjs");
    const pidFile = path.join(dir, "pid");
    fs.writeFileSync(
      driver,
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log(JSON.stringify({event:"ready",dave:true,dave_receive:true})); process.stdin.resume(); setInterval(() => {}, 1000);`,
      "utf8",
    );
    const launcher = path.join(dir, "fake-python.sh");
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${driver}"\n`,
      "utf8",
    );
    fs.chmodSync(launcher, 0o755);
    const recorder = new PycordDiscordRecorder({
      token: "token",
      guildId: "123",
      channelId: "456",
      pythonPath: launcher,
      startupTimeoutMs: 10_000,
      stopTimeoutMs: 250,
    });

    await recorder.start({ sessionDir: dir });
    await expect(recorder.stop()).rejects.toThrow(/did not stop/);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

it("allows ongoing finalization work beyond the idle deadline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-progress-"));
  const driver = path.join(dir, "progress.mjs");
  const launcher = path.join(dir, "python");
  fs.writeFileSync(
    driver,
    `console.log(JSON.stringify({event:'ready',dave:true,dave_receive:true}));process.stdin.once('data',()=>{let n=0;const timer=setInterval(()=>{console.log(JSON.stringify({event:'progress',bytesProcessed:++n}));if(n===8){clearInterval(timer);console.log(JSON.stringify({event:'stopped',tracks:[]}));process.exitCode=0;process.stdin.destroy();}},250);});`,
  );
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexec "${process.execPath}" "${driver}"\n`,
    { mode: 0o700 },
  );
  const recorder = new PycordDiscordRecorder({
    token: "synthetic",
    guildId: "1",
    channelId: "2",
    pythonPath: launcher,
    startupTimeoutMs: 10000,
    stopTimeoutMs: 1000,
  });
  try {
    await recorder.start({ sessionDir: dir });
    await expect(recorder.stop()).resolves.toEqual([]);
  } finally {
    await recorder.abort();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
