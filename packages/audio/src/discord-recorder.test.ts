import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DiscordRecorder } from "./discord-recorder.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-receive-"));
  dirs.push(dir);
  const speaking = new EventEmitter();
  const inputs: PassThrough[] = [];
  const recorder = new DiscordRecorder({
    connection: {
      receiver: {
        speaking,
        subscribe() {
          const input = new PassThrough();
          inputs.push(input);
          return input;
        },
      },
    },
    loadDependencies: async () => ({
      EndBehaviorType: { AfterSilence: 1 },
      opusDecoderStream: () => new PassThrough(),
    }),
  });
  await recorder.start({ sessionDir: dir });
  speaking.emit("start", "123");
  return { recorder, speaking, inputs, dir };
}

describe("Discord capture boundaries", () => {
  it("excludes paused speech and resumes an already speaking participant", async () => {
    const { recorder, inputs, speaking } = await fixture();
    inputs[0]!.write(Buffer.alloc(3840, 1));
    recorder.pause();
    inputs[0]!.write(Buffer.alloc(3840, 2));
    speaking.emit("start", "456");
    expect(inputs).toHaveLength(1);
    recorder.resume();
    inputs[0]!.write(Buffer.alloc(3840, 3));
    const chunks = await recorder.stop();
    expect(chunks).toHaveLength(2);
    expect(
      chunks.map((chunk) => fs.readFileSync(chunk.path).subarray(44)),
    ).toEqual([Buffer.alloc(3840, 1), Buffer.alloc(3840, 3)]);
  });

  it("flushes immediately on stop and detaches all capture resources", async () => {
    const { recorder, inputs, speaking } = await fixture();
    inputs[0]!.write(Buffer.alloc(3840, 1));
    const chunks = await recorder.stop();
    expect(chunks).toHaveLength(1);
    expect(inputs[0]!.destroyed).toBe(true);
    expect(speaking.listenerCount("start")).toBe(0);
    speaking.emit("start", "456");
    expect(inputs).toHaveLength(1);
    expect(await recorder.stop()).toEqual(chunks);
  });

  it("writes bounded chunks without waiting for silence or losing samples", async () => {
    const { recorder, inputs, dir } = await fixture();
    const second = Buffer.alloc(48000 * 4, 7);
    for (let i = 0; i < 31; i++) inputs[0]!.write(second);
    const files = fs.readdirSync(path.join(dir, "audio", "chunks"));
    expect(files).toHaveLength(1);
    expect(fs.statSync(path.join(dir, "audio", "chunks", files[0]!)).size).toBe(
      30 * second.length + 44,
    );
    const chunks = await recorder.stop();
    expect(chunks.map((chunk) => chunk.durationSeconds)).toEqual([30, 1]);
    expect(
      Buffer.concat(
        chunks.map((chunk) => fs.readFileSync(chunk.path).subarray(44)),
      ).equals(Buffer.alloc(31 * second.length, 7)),
    ).toBe(true);
  });

  it("surfaces receive errors and cleans up on abort", async () => {
    const { recorder, inputs, speaking } = await fixture();
    inputs[0]!.emit("error", new Error("receive failed"));
    expect(recorder.getHealth().status).toBe("failed");
    await expect(recorder.abort()).rejects.toThrow("receive failed");
    expect(speaking.listenerCount("start")).toBe(0);
    expect(inputs[0]!.destroyed).toBe(true);
  });
});
