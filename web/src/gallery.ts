// Start-up mode and the session gallery of the static build.
//
// The static build (VITE_ILS_STATIC=1, `make web-static`) never talks to an
// engine: with ?session= it replays that file, without it it shows the
// gallery read from sessions/index.json. The build embedded in the binary
// goes live when there is no ?session=.

// True in the static build. Fixed at compile time.
export const STATIC = import.meta.env.VITE_ILS_STATIC === '1';

// Where the gallery reads its list, relative to the page.
export const INDEX_URL = 'sessions/index.json';

export type Boot = { mode: 'live' } | { mode: 'replay'; session: string } | { mode: 'gallery' };

// What the page does on load, from its query string.
export function bootMode(search: string, isStatic: boolean): Boot {
  const session = new URLSearchParams(search).get('session');
  if (session !== null) return { mode: 'replay', session };
  return isStatic ? { mode: 'gallery' } : { mode: 'live' };
}

export interface GalleryEntry {
  file: string; // path under sessions/, e.g. "samples/x.ils"
  title: string;
  models: string[];
  description: string;
  size?: number; // bytes of the .ils file
}

function text(v: unknown, what: string, i: number): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`entry ${i}: ${what} must be a non-empty string`);
  return v;
}

// A relative path to a .ils file inside sessions/: no scheme, no leading
// slash, no "..", no backslashes or query characters.
function validFile(f: string): boolean {
  return (
    /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.ils$/.test(f) && !f.split('/').some((part) => part === '..' || part === '.')
  );
}

// Validates the parsed sessions/index.json. Throws with a readable message.
export function parseIndex(json: unknown): GalleryEntry[] {
  if (!Array.isArray(json)) throw new Error('index.json must be an array');
  return json.map((e: unknown, i): GalleryEntry => {
    if (typeof e !== 'object' || e === null) throw new Error(`entry ${i}: not an object`);
    const o = e as Record<string, unknown>;
    const file = text(o.file, 'file', i);
    if (!validFile(file)) throw new Error(`entry ${i}: bad file path "${file}"`);
    const models = o.models;
    if (!Array.isArray(models) || models.length === 0 || models.length > 2) {
      throw new Error(`entry ${i}: models must list one or two names`);
    }
    const entry: GalleryEntry = {
      file,
      title: text(o.title, 'title', i),
      models: models.map((m) => text(m, 'models[]', i)),
      description: text(o.description, 'description', i),
    };
    if (o.size !== undefined) {
      if (typeof o.size !== 'number' || !Number.isInteger(o.size) || o.size < 0) {
        throw new Error(`entry ${i}: size must be a whole number of bytes`);
      }
      entry.size = o.size;
    }
    return entry;
  });
}

// The page URL that replays an entry.
export function sessionHref(entry: GalleryEntry): string {
  return `?session=${encodeURI(`sessions/${entry.file}`)}`;
}

// Download size of a session file, as 96 kB or 1.4 MB.
export function fileSize(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} kB`;
}

// Fetches and validates the gallery list.
export async function loadIndex(url = INDEX_URL): Promise<GalleryEntry[]> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(`cannot fetch ${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`cannot fetch ${url}: HTTP ${res.status}`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error(`${url} is not valid JSON`);
  }
  return parseIndex(json);
}
