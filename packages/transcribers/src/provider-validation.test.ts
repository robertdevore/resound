import { describe, expect, it } from "vitest";
import { parseOpenAiWhisperJson, parseWhisperCppJson } from "./index.js";

for (const [dialect, parse, field] of [
  ["openai", parseOpenAiWhisperJson, "segments"],
  ["whisper.cpp", parseWhisperCppJson, "transcription"],
] as const) {
  describe(`${dialect} provider validation`, () => {
    it.each([{}, null, [], { error: "synthetic failure" }])(
      "rejects an unrecognized response %j",
      (body) => {
        expect(() => parse(JSON.stringify(body))).toThrow(
          /Invalid transcription response/,
        );
      },
    );
    it.each([null, {}, [null], [{ text: 42 }]])(
      "rejects malformed rows %j",
      (rows) => {
        expect(() => parse(JSON.stringify({ [field]: rows }))).toThrow(
          /Invalid transcription response/,
        );
      },
    );
    it("rejects supplied nonnumeric offsets instead of coercing them", () => {
      const row =
        dialect === "openai"
          ? { start: "2", end: 3, text: "hello" }
          : { offsets: { from: "2000", to: 3000 }, text: "hello" };
      expect(() => parse(JSON.stringify({ [field]: [row] }))).toThrow(
        /Invalid transcription response/,
      );
    });
    it("accepts explicit silence and omitted optional offsets", () => {
      expect(parse(JSON.stringify({ [field]: [] }))).toEqual([]);
      expect(parse(JSON.stringify({ [field]: [{ text: " hello " }] }))).toEqual(
        [{ start: 0, end: 0, text: "hello" }],
      );
    });
  });
}
it("retains text-only and empty-text OpenAI responses", () => {
  expect(parseOpenAiWhisperJson('{"text":" hello "}')).toEqual([
    { start: 0, end: 0, text: "hello" },
  ]);
  expect(parseOpenAiWhisperJson('{"text":""}')).toEqual([]);
});
