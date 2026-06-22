import { describe, expect, it } from "vitest";
import { checkConsentRequired } from "./index.js";
import { createManifest, recordConsentEvent } from "@resound/core";

describe("consent-required check", () => {
  it("fails with no consent", () => {
    const m = createManifest({ title: "x", startedAt: new Date("2026-06-22T00:00:00Z") });
    expect(checkConsentRequired(m).pass).toBe(false);
  });

  it("passes once recording is announced", () => {
    const m = createManifest({ title: "x", startedAt: new Date("2026-06-22T00:00:00Z") });
    recordConsentEvent(m, { type: "recording-announced", user_id: "1", username: "bot" });
    expect(checkConsentRequired(m).pass).toBe(true);
  });
});
