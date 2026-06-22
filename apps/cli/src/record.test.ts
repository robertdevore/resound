import { describe, expect, it } from "vitest";
import { buildFfmpegArgs } from "./record.js";

describe("buildFfmpegArgs", () => {
  it("builds a single-device capture", () => {
    const args = buildFfmpegArgs({ outFile: "/tmp/a.wav", device: "1" });
    expect(args.join(" ")).toContain("-f avfoundation -i :1");
    expect(args.join(" ")).toContain("-ac 1 -ar 16000");
    expect(args).toContain("/tmp/a.wav");
    expect(args).not.toContain("-filter_complex");
  });

  it("mixes system + mic with amix", () => {
    const args = buildFfmpegArgs({ outFile: "/tmp/a.wav", systemDevice: "1", micDevice: "2" });
    const s = args.join(" ");
    expect(s).toContain("-f avfoundation -i :1");
    expect(s).toContain("-f avfoundation -i :2");
    expect(s).toContain("[0:a][1:a]amix=inputs=2:duration=longest[a]");
    expect(s).toContain("-map [a]");
  });

  it("adds a duration limit when given", () => {
    const args = buildFfmpegArgs({ outFile: "/tmp/a.wav", device: "1", durationSec: 30 });
    expect(args.join(" ")).toContain("-t 30");
  });

  it("throws when no device is provided", () => {
    expect(() => buildFfmpegArgs({ outFile: "/tmp/a.wav" })).toThrow(/No capture device/);
  });
});
