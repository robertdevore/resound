export interface OperatorSubject {
  userId: string;
  hasManageGuild: boolean;
  roleIds: readonly string[];
}

export type TranscriptDelivery = "ephemeral" | "channel" | "disabled";

function csvSet(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/** Safe-by-default operator policy with explicit user/role allow-list overrides. */
export function isOperator(
  subject: OperatorSubject,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (subject.hasManageGuild) return true;
  if (csvSet(env.RESOUND_OPERATOR_USER_IDS).has(subject.userId)) return true;
  const allowedRoles = csvSet(env.RESOUND_OPERATOR_ROLE_IDS);
  return subject.roleIds.some((roleId) => allowedRoles.has(roleId));
}

/** Session owners retain control; configured operators may recover or override. */
export function canControlSession(
  subject: OperatorSubject,
  ownerId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ownerId === subject.userId || isOperator(subject, env);
}

export interface CommandAuthorization {
  allowed: boolean;
  reason?: "operator-required" | "controller-required";
}

/** One complete policy matrix for every currently registered subcommand. */
export function authorizeSubcommand(
  subcommand: string,
  subject: OperatorSubject,
  ownerId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CommandAuthorization {
  if (["doctor", "start"].includes(subcommand)) {
    return isOperator(subject, env)
      ? { allowed: true }
      : { allowed: false, reason: "operator-required" };
  }
  if (["pause", "resume", "stop", "export", "recover"].includes(subcommand)) {
    return canControlSession(subject, ownerId, env)
      ? { allowed: true }
      : { allowed: false, reason: "controller-required" };
  }
  return { allowed: true };
}

export function transcriptDelivery(
  env: NodeJS.ProcessEnv = process.env,
): TranscriptDelivery {
  const configured = (env.RESOUND_TRANSCRIPT_DELIVERY ?? "ephemeral").trim();
  return configured === "channel" || configured === "disabled"
    ? configured
    : "ephemeral";
}

export interface VoiceStateSnapshot {
  channelId: string | null;
  userId: string;
  username: string;
  bot: boolean;
}

export type VoiceLifecycleChange =
  | { type: "joined"; userId: string; username: string }
  | { type: "left"; userId: string; username: string };

/** Ignore mute/deaf-only updates and map moves into leave/join for one recorded channel. */
export function voiceLifecycleChanges(
  before: VoiceStateSnapshot,
  after: VoiceStateSnapshot,
  recordedChannelId: string,
): VoiceLifecycleChange[] {
  if (
    after.bot ||
    before.bot ||
    !recordedChannelId ||
    before.channelId === after.channelId
  )
    return [];
  const changes: VoiceLifecycleChange[] = [];
  if (before.channelId === recordedChannelId) {
    changes.push({
      type: "left",
      userId: before.userId,
      username: before.username,
    });
  }
  if (after.channelId === recordedChannelId) {
    changes.push({
      type: "joined",
      userId: after.userId,
      username: after.username,
    });
  }
  return changes;
}
