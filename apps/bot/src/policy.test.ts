import { describe, expect, it } from "vitest";
import {
  authorizeSubcommand,
  canControlSession,
  isOperator,
  transcriptDelivery,
  voiceLifecycleChanges,
  type OperatorSubject,
} from "./policy.js";

const member: OperatorSubject = {
  userId: "member",
  hasManageGuild: false,
  roleIds: ["role-a"],
};

describe("Discord operator policy", () => {
  it("defaults to Manage Guild and supports explicit user or role allow-lists", () => {
    expect(isOperator(member, {} as NodeJS.ProcessEnv)).toBe(false);
    expect(
      isOperator({ ...member, hasManageGuild: true }, {} as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isOperator(member, {
        RESOUND_OPERATOR_USER_IDS: "other, member",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isOperator(member, {
        RESOUND_OPERATOR_ROLE_IDS: "role-a,role-b",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("allows the durable session owner or an operator to control a session", () => {
    expect(canControlSession(member, "member", {} as NodeJS.ProcessEnv)).toBe(
      true,
    );
    expect(canControlSession(member, "other", {} as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(
      canControlSession(member, "other", {
        RESOUND_OPERATOR_USER_IDS: "member",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it("covers every command with public, operator, or owner/operator access", () => {
    for (const command of ["consent", "status"]) {
      expect(
        authorizeSubcommand(command, member, "other", {} as NodeJS.ProcessEnv),
      ).toEqual({
        allowed: true,
      });
    }
    for (const command of ["doctor", "start"]) {
      expect(
        authorizeSubcommand(command, member, "other", {} as NodeJS.ProcessEnv),
      ).toEqual({ allowed: false, reason: "operator-required" });
    }
    for (const command of ["pause", "resume", "stop", "export", "recover"]) {
      expect(
        authorizeSubcommand(command, member, "other", {} as NodeJS.ProcessEnv),
      ).toEqual({ allowed: false, reason: "controller-required" });
      expect(
        authorizeSubcommand(command, member, "member", {} as NodeJS.ProcessEnv),
      ).toEqual({ allowed: true });
    }
  });

  it("defaults transcript delivery to private and only accepts explicit public/disabled values", () => {
    expect(transcriptDelivery({} as NodeJS.ProcessEnv)).toBe("ephemeral");
    expect(
      transcriptDelivery({
        RESOUND_TRANSCRIPT_DELIVERY: "channel",
      } as NodeJS.ProcessEnv),
    ).toBe("channel");
    expect(
      transcriptDelivery({
        RESOUND_TRANSCRIPT_DELIVERY: "disabled",
      } as NodeJS.ProcessEnv),
    ).toBe("disabled");
    expect(
      transcriptDelivery({
        RESOUND_TRANSCRIPT_DELIVERY: "bad",
      } as NodeJS.ProcessEnv),
    ).toBe("ephemeral");
  });
});

describe("voice lifecycle routing", () => {
  const base = { userId: "u1", username: "Ashley", bot: false };

  it("maps joins, leaves, and moves for the recorded channel", () => {
    expect(
      voiceLifecycleChanges(
        { ...base, channelId: null },
        { ...base, channelId: "recorded" },
        "recorded",
      ),
    ).toEqual([{ type: "joined", userId: "u1", username: "Ashley" }]);
    expect(
      voiceLifecycleChanges(
        { ...base, channelId: "recorded" },
        { ...base, channelId: "other" },
        "recorded",
      ),
    ).toEqual([{ type: "left", userId: "u1", username: "Ashley" }]);
  });

  it("ignores mute/deaf-only changes, unrelated channels, and bots", () => {
    expect(
      voiceLifecycleChanges(
        { ...base, channelId: "recorded" },
        { ...base, channelId: "recorded" },
        "recorded",
      ),
    ).toEqual([]);
    expect(
      voiceLifecycleChanges(
        { ...base, channelId: "other-a" },
        { ...base, channelId: "other-b" },
        "recorded",
      ),
    ).toEqual([]);
    expect(
      voiceLifecycleChanges(
        { ...base, bot: true, channelId: null },
        { ...base, bot: true, channelId: "recorded" },
        "recorded",
      ),
    ).toEqual([]);
  });
});
