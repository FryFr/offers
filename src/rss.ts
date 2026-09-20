/** Bounded, non-expanding XML reader for RSS 2.0. DTDs/entities and unsupported markup fail closed. */
interface Element { name: string; text: string; children: Element[] }
function decode(text: string): string {
  return text.replace(/&([^;\s]+);/g, (_, name: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (named[name]) return named[name];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(name)) throw new Error('rss_entity_invalid');
    const code = name[1] === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('rss_entity_invalid');
    return String.fromCodePoint(code);
  });
}
export function parseRss(xml: string): Record<string, string>[] {
  if (Buffer.byteLength(xml) > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('rss_unsafe_xml');
  const root: Element = { name: '', text: '', children: [] }, stack = [root];
  const tokens = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g;
  let offset = 0, count = 0;
  for (const match of xml.matchAll(tokens)) {
    if (match.index !== offset || ++count > 100_000) throw new Error('rss_malformed');
    const token = match[0]; offset += token.length;
    const current = stack.at(-1)!;
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { current.text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) {
      if (!/^<\/[\w:.-]+\s*>$/.test(token) || stack.length < 2 || token.slice(2, -1).trim() !== current.name) throw new Error('rss_malformed');
      stack.pop(); continue;
    }
    if (token.startsWith('<')) {
      const opening = /^<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/.exec(token);
      if (!opening || stack.length > 32) throw new Error('rss_malformed');
      const child: Element = { name: opening[1]!, text: '', children: [] };
      current.children.push(child);
      if (!opening[3]) stack.push(child);
    } else current.text += decode(token);
  }
  if (offset !== xml.length || stack.length !== 1 || root.text.trim() || root.children.length !== 1 || root.children[0]!.name !== 'rss') throw new Error('rss_malformed');
  const channels = root.children[0]!.children.filter(n => n.name === 'channel');
  if (channels.length !== 1) throw new Error('rss_malformed');
  return channels[0]!.children.filter(n => n.name === 'item').map(item => {
    const result: Record<string, string> = {};
    for (const child of item.children) {
      if (!['title', 'link', 'guid', 'description', 'pubDate', 'company'].includes(child.name)) continue;
      if (child.children.length || Object.hasOwn(result, child.name)) throw new Error('rss_ambiguous_field');
      result[child.name] = child.text.trim();
    }
    return result;
  });
}
