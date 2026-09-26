/** Reject overlapping guild operations instead of queueing stale authorization. */
export class GuildOperations {
  private readonly active = new Set<string>();

  acquire(guildId: string): () => void {
    if (this.active.has(guildId)) {
      throw new Error(
        "A session operation is already in progress. Try again when it completes.",
      );
    }
    this.active.add(guildId);
    return () => {
      this.active.delete(guildId);
    };
  }
}
