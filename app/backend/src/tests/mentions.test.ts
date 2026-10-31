import { parseMentions } from '../services/mentionService.js';

describe('parseMentions', () => {
  it('extracts user ids, here, and channel', () => {
    const r = parseMentions('hi <@12|Bob> and <@here> and <@channel>');
    expect(r).toEqual({ userIds: [12], here: true, channel: true });
  });

  it('handles several mentions and removes duplicates', () => {
    const r = parseMentions('<@1|A> <@2|B> <@1|A> <@3|C>');
    expect(r.userIds).toEqual([1, 2, 3]);
    expect(r.here).toBe(false);
    expect(r.channel).toBe(false);
  });

  it('ignores malformed mentions and bare @words', () => {
    const r = parseMentions('@bob <@abc|X> <@|X> <@5> <@5|> <@-3|X> <@0|Z> <@99999999999|Big>');
    expect(r.userIds).toEqual([]);
    expect(r.here).toBe(false);
    expect(r.channel).toBe(false);
  });

  it('returns empty for empty or non-string input', () => {
    expect(parseMentions('')).toEqual({ userIds: [], here: false, channel: false });
    expect(parseMentions(undefined as unknown as string)).toEqual({ userIds: [], here: false, channel: false });
  });

  it('caps the number of mentions per message', () => {
    const text = Array.from({ length: 200 }, (_, i) => `<@${i + 1}|U>`).join(' ');
    expect(parseMentions(text).userIds.length).toBe(50);
  });

  it('does not backtrack badly on hostile input (ReDoS)', () => {
    const hostile = '<@1|'.repeat(10000) + 'a'.repeat(30000);
    const start = Date.now();
    parseMentions(hostile);
    expect(Date.now() - start).toBeLessThan(500);
    const longName = `<@1|${'a'.repeat(39000)}>`;
    const start2 = Date.now();
    expect(parseMentions(longName).userIds).toEqual([]);
    expect(Date.now() - start2).toBeLessThan(500);
  });

  it('only scans up to the message length limit', () => {
    const text = 'x'.repeat(40000) + '<@7|Late>';
    expect(parseMentions(text).userIds).toEqual([]);
  });
});
