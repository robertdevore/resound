import { afterEach, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAICompatibleTranscriber } from "./openai.js";

const servers: http.Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
async function setup(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resound-http-test-"));
  directories.push(dir);
  const audioPath = path.join(dir, "test.wav");
  fs.writeFileSync(audioPath, "synthetic-audio");
  return {
    audioPath,
    baseUrl: `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
  };
}
it("streams multipart audio to a real compatible HTTP endpoint", async () => {
  let received = "";
  const input = await setup((req, res) => {
    req.on("data", (chunk) => (received += chunk));
    req.on("end", () => res.end(JSON.stringify({ text: "hello" })));
  });
  const result = await new OpenAICompatibleTranscriber({
    apiKey: "synthetic",
    baseUrl: input.baseUrl,
  }).transcribe(input);
  expect(received).toContain("synthetic-audio");
  expect(result[0]?.text).toBe("hello");
});
it("aborts a stalled response body, not only connection setup", async () => {
  const input = await setup((_req, res) => {
    res.writeHead(200);
    res.write('{"text":"');
  });
  await expect(
    new OpenAICompatibleTranscriber({
      apiKey: "synthetic",
      baseUrl: input.baseUrl,
      timeoutMs: 100,
    }).transcribe(input),
  ).rejects.toThrow(/abort|timeout/i);
});
it("preserves large provider errors on disk with bounded error output", async () => {
  const input = await setup((_req, res) => {
    res.writeHead(500);
    res.end("x".repeat(1024 * 1024));
  });
  try {
    await new OpenAICompatibleTranscriber({
      apiKey: "synthetic",
      baseUrl: input.baseUrl,
    }).transcribe(input);
    throw new Error("Expected failure");
  } catch (error) {
    const message = (error as Error).message;
    expect(message.length).toBeLessThan(8500);
    const file = message.match(/Full provider error: ([^\]]+)/)![1]!;
    expect(fs.statSync(file).size).toBe(1024 * 1024);
    directories.push(path.dirname(file));
  }
});
