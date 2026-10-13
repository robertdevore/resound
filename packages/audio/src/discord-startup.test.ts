import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DiscordRecorder, type VoiceDeps } from "./discord-recorder.js";

describe("optional Discord adapter startup and failure ownership", () => {
  let dir: string;
  let speaking: EventEmitter;
  let input: PassThrough;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-discord-start-"));
    speaking = new EventEmitter();
    input = new PassThrough();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    input.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const deps = (): VoiceDeps => ({
    EndBehaviorType: { AfterSilence: 1 },
    opusDecoderStream: () => new PassThrough(),
  });
  function recorder(loadDependencies: () => Promise<VoiceDeps>) {
    return new DiscordRecorder({
      connection: { receiver: { speaking, subscribe: () => input } },
      loadDependencies,
    });
  }
  it("reserves startup before asynchronous dependency loading", async () => {
    let resolve!: (value: VoiceDeps) => void;
    const load = vi.fn(
      () =>
        new Promise<VoiceDeps>((done) => {
          resolve = done;
        }),
    );
    const capture = recorder(load);
    const first = capture.start({ sessionDir: dir });
    const second = capture.start({ sessionDir: dir });
    void second.catch(() => {});
    expect(load).toHaveBeenCalledTimes(1);
    await expect(second).rejects.toThrow(/already/);
    resolve(deps());
    await first;
    expect(speaking.listenerCount("start")).toBe(1);
    await capture.stop();
    expect(speaking.listenerCount("start")).toBe(0);
  });
  it("cannot activate capture after stop cancels pending startup", async () => {
    let resolve!: (value: VoiceDeps) => void;
    const capture = recorder(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const ready = capture.start({ sessionDir: dir });
    const rejected = expect(ready).rejects.toThrow(/stopped during startup/);
    await capture.stop();
    resolve(deps());
    await rejected;
    expect(speaking.listenerCount("start")).toBe(0);
    expect(capture.getHealth().status).toBe("idle");
  });
  it("destroys a subscription when decoder construction fails", async () => {
    const capture = recorder(async () => ({
      ...deps(),
      opusDecoderStream: () => {
        throw new Error("decoder unavailable");
      },
    }));
    await capture.start({ sessionDir: dir });
    speaking.emit("start", "123");
    expect(input.destroyed).toBe(true);
    expect(capture.getHealth().summary).toMatch(/failed/);
    await expect(capture.stop()).rejects.toThrow("decoder unavailable");
  });
  it("retains a pause flush failure instead of reporting successful finalization", async () => {
    const capture = recorder(async () => deps());
    await capture.start({ sessionDir: dir });
    speaking.emit("start", "123");
    input.write(Buffer.alloc(3840));
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => capture.pause()).toThrow("disk full");
    expect(capture.getHealth().status).toBe("failed");
    await expect(capture.stop()).rejects.toThrow("disk full");
    expect(input.destroyed).toBe(true);
  });
  it("permits retry after dependency loading fails", async () => {
    const load = vi
      .fn<() => Promise<VoiceDeps>>()
      .mockRejectedValueOnce(new Error("not installed"))
      .mockResolvedValue(deps());
    const capture = recorder(load);
    await expect(capture.start({ sessionDir: dir })).rejects.toThrow(
      "not installed",
    );
    await capture.start({ sessionDir: dir });
    await capture.stop();
    expect(speaking.listenerCount("start")).toBe(0);
  });
});
