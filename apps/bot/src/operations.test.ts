import { expect, it } from "vitest";
import { GuildOperations } from "./operations.js";

it("holds authorization and session selection together across asynchronous work", async () => {
  const operations = new GuildOperations();
  const release = operations.acquire("guild-a");
  await Promise.resolve();
  expect(() => operations.acquire("guild-a")).toThrow(/already in progress/);
  const releaseOther = operations.acquire("guild-b");
  releaseOther();
  release();
  expect(() => operations.acquire("guild-a")).not.toThrow();
});
