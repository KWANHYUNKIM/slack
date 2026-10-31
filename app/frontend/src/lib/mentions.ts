/** True when the message content mentions this user directly, or via <@channel> / <@here>. */
export function mentionsUser(content: string, userId: number): boolean {
  return (
    content.includes('<@channel>') ||
    content.includes('<@here>') ||
    content.includes(`<@${userId}|`)
  );
}
