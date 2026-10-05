/**
 * Reader for osmium's OPL text format (`osmium cat -f opl`): one object per line,
 *   n<id> … x<lon> y<lat> T<k=v,…>
 *   w<id> … T<k=v,…> N<n1,n2,…>
 *   r<id> … T<k=v,…> M<type><id>@<role>,…
 * Special characters in tags and roles are escaped as %<hex code point>%.
 */
export type Tags = Partial<Record<string, string>>;

export interface OsmNode {
  id: number;
  lon: number;
  lat: number;
  tags: Tags;
}

export interface OsmWay {
  id: number;
  tags: Tags;
  refs: number[];
}

export interface OsmMember {
  type: 'n' | 'w' | 'r';
  ref: number;
  role: string;
}

export interface OsmRelation {
  id: number;
  tags: Tags;
  members: OsmMember[];
}

export interface OsmData {
  nodes: Map<number, OsmNode>;
  ways: Map<number, OsmWay>;
  relations: Map<number, OsmRelation>;
}

export function unescapeOpl(text: string): string {
  return text.replace(/%([0-9a-fA-F]+)%/g, (_, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}

/** Shared by every untagged element (most nodes): millions of empty objects add up. */
const NO_TAGS: Tags = Object.freeze({});

function parseTags(field: string): Tags {
  if (field.length === 0) return NO_TAGS;
  const tags: Tags = {};
  for (const pair of field.split(',')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    tags[unescapeOpl(pair.slice(0, eq))] = unescapeOpl(pair.slice(eq + 1));
  }
  return tags;
}

export function parseOpl(text: string): OsmData {
  const data: OsmData = { nodes: new Map(), ways: new Map(), relations: new Map() };
  for (const line of text.split('\n')) addOplLine(data, line);
  return data;
}

/**
 * Parses OPL from a stream, one line at a time: a 20 km city is ~450 MB of OPL, too close to V8's
 * string limit to hold whole.
 */
export async function parseOplStream(lines: AsyncIterable<string>): Promise<OsmData> {
  const data: OsmData = { nodes: new Map(), ways: new Map(), relations: new Map() };
  for await (const line of lines) addOplLine(data, line);
  return data;
}

function addOplLine(data: OsmData, line: string): void {
  if (line.length === 0) return;
  const fields = line.split(' ');
  const head = fields[0] ?? '';
  const id = Number(head.slice(1));
  const field = (letter: string): string =>
    fields.find((f) => f.startsWith(letter))?.slice(1) ?? '';
  const tags = parseTags(field('T'));
  if (head.startsWith('n')) {
    const lon = Number(field('x'));
    const lat = Number(field('y'));
    if (Number.isFinite(lon) && Number.isFinite(lat) && field('x') !== '')
      data.nodes.set(id, { id, lon, lat, tags });
  } else if (head.startsWith('w')) {
    const refs = field('N')
      .split(',')
      .filter((r) => r.length > 0)
      .map((r) => Number(r.slice(1)));
    data.ways.set(id, { id, tags, refs });
  } else if (head.startsWith('r')) {
    const members = field('M')
      .split(',')
      .filter((m) => m.length > 0)
      .map((m) => {
        const at = m.indexOf('@');
        return {
          type: m[0] as OsmMember['type'],
          ref: Number(m.slice(1, at)),
          role: unescapeOpl(m.slice(at + 1)),
        };
      });
    data.relations.set(id, { id, tags, members });
  }
}
