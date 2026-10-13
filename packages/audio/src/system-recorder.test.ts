import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemRecorder } from "./system-recorder.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn, spawnSync: vi.fn() }));

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  kill = vi.fn();
  close(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

describe("system recorder ownership", () => {
  let dir: string;
  let child: FakeChild;
  let recorder: SystemRecorder;
  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-system-"));
    child = new FakeChild();
    spawn.mockReset().mockReturnValue(child);
    recorder = new SystemRecorder({ device: "0", startupProbeMs: 10 });
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function start() {
    const ready = recorder.start({ sessionDir: dir });
    await vi.advanceTimersByTimeAsync(10);
    await ready;
  }
  it("rejects a second start without replacing the owned process", async () => {
    const ready = recorder.start({ sessionDir: dir });
    await expect(recorder.start({ sessionDir: dir })).rejects.toThrow(
      /already/,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    await ready;
    const stopped = recorder.stop();
    child.close(0);
    await stopped;
  });
  it("reports a failed exit and releases ownership after failed stop", async () => {
    await start();
    child.close(1);
    expect(recorder.getHealth().status).toBe("failed");
    await expect(recorder.stop()).rejects.toThrow(/ffmpeg exited 1/);
    child = new FakeChild();
    spawn.mockReturnValue(child);
    await start();
    const stopped = recorder.stop();
    child.close(0);
    await stopped;
    expect(recorder.getHealth().status).toBe("idle");
  });
  it("shares concurrent and repeated stop requests", async () => {
    await start();
    const first = recorder.stop();
    const second = recorder.stop();
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    child.close(0);
    expect(await second).toEqual(await first);
    expect(await recorder.stop()).toEqual(await first);
  });
  it("rejects pause and resume after signal termination", async () => {
    await start();
    child.close(null, "SIGTERM");
    expect(recorder.getHealth().status).toBe("idle");
    expect(() => recorder.pause()).toThrow(/not running/);
    expect(() => recorder.resume()).toThrow(/not running/);
    await recorder.stop();
  });
  it("clears the startup timer and permits retry after an immediate failure", async () => {
    const ready = recorder.start({ sessionDir: dir });
    const rejected = expect(ready).rejects.toThrow(/ffmpeg exited 1/);
    child.close(1);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(recorder.getHealth().status).toBe("failed");
    child = new FakeChild();
    spawn.mockReturnValue(child);
    await start();
    const stopped = recorder.stop();
    child.close(0);
    await stopped;
  });
  it("waits for spawn-error close before allowing another start", async () => {
    const ready = recorder.start({ sessionDir: dir });
    const rejected = expect(ready).rejects.toThrow(/ffmpeg not found/);
    child.emit(
      "error",
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    await expect(recorder.start({ sessionDir: dir })).rejects.toThrow(
      /already/,
    );
    child.close(-2);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("resumes a paused child before requesting shutdown", async () => {
    await start();
    recorder.pause();
    expect(recorder.getHealth().status).toBe("paused");
    const stopped = recorder.stop();
    expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual([
      "SIGSTOP",
      "SIGCONT",
    ]);
    expect(() => recorder.pause()).toThrow(/not running/);
    child.close(0);
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("kills only the owned child at the stop deadline and surfaces failure", async () => {
    await start();
    const stopped = recorder.stop();
    const rejected = expect(stopped).rejects.toThrow(/SIGKILL/);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.close(null, "SIGKILL");
    await rejected;
    expect(recorder.getHealth().status).toBe("failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
