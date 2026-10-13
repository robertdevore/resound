import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { PycordDiscordRecorder } from "./pycord-discord-recorder.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn, spawnSync: vi.fn() }));
class Child extends EventEmitter {
  stdout = new PassThrough();
  stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
  event(event: object) {
    this.stdout.write(JSON.stringify(event) + "\n");
  }
  close() {
    this.exitCode = 0;
    this.stdout.end();
    this.emit("close", 0, null);
  }
}
describe("Pycord process ownership", () => {
  let dir: string;
  let child: Child;
  let recorder: PycordDiscordRecorder;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-pycord-owned-"));
    child = new Child();
    spawn.mockReset().mockReturnValue(child);
    recorder = new PycordDiscordRecorder({
      token: "synthetic",
      guildId: "1",
      channelId: "2",
    });
  });
  afterEach(async () => {
    child.close();
    await Promise.resolve();
    vi.clearAllTimers();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function start() {
    const ready = recorder.start({ sessionDir: dir });
    child.event({ event: "ready", dave: true, dave_receive: true });
    await ready;
  }
  it("rejects overlapping startup without launching another sidecar", async () => {
    const ready = recorder.start({ sessionDir: dir });
    void ready.catch(() => {});
    const duplicate = recorder.start({ sessionDir: dir });
    void duplicate.catch(() => {});
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(duplicate).rejects.toThrow(/already/);
    child.event({ event: "ready" });
    await ready;
  });
  it("shares concurrent stop requests and returns the same result", async () => {
    await start();
    const first = recorder.stop();
    const second = recorder.stop();
    void first.catch(() => {});
    void second.catch(() => {});
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    child.event({ event: "stopped", tracks: [] });
    child.close();
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
    expect(await recorder.stop()).toEqual([]);
  });
  it("keeps stop pending until the child has closed", async () => {
    await start();
    let settled = false;
    const stopped = recorder.stop().then((result) => {
      settled = true;
      return result;
    });
    void stopped.catch(() => {});
    child.event({ event: "stopped", tracks: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(recorder.getHealth().status).toBe("stopping");
    child.close();
    await stopped;
    child = new Child();
    spawn.mockReturnValue(child);
    await start();
  });
  it("retains ownership through exit until close during abort", async () => {
    await start();
    let settled = false;
    const aborted = recorder.abort().then(() => {
      settled = true;
    });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    child.close();
    await aborted;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("settles startup immediately when stop closes before ready", async () => {
    const ready = recorder.start({ sessionDir: dir });
    const rejected = expect(ready).rejects.toThrow(/closed/);
    const stopped = recorder.stop();
    child.event({ event: "stopped", tracks: [] });
    child.close();
    await rejected;
    await expect(stopped).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shares failure outcomes across repeated stops", async () => {
    await start();
    const first = recorder.stop();
    const second = recorder.stop();
    const rejected = expect(first).rejects.toThrow("capture failed");
    child.event({ event: "error", message: "capture failed" });
    child.close();
    await rejected;
    await expect(second).rejects.toThrow("capture failed");
    await expect(recorder.stop()).rejects.toThrow("capture failed");
    expect(recorder.getHealth().summary).toMatch(/failed/);
  });
  it("enforces the deadline even after receiving stopped if the process stays alive", async () => {
    await start();
    const stopped = recorder.stop();
    const rejected = expect(stopped).rejects.toThrow(/did not stop/);
    child.event({ event: "stopped", tracks: [] });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.close();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
