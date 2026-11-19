// The Lead chooser's name scoring (public/name-match.js): a plain browser script that sets globalThis.NameMatch,
// imported here for that side effect so the tests run the same file the browser loads. All names are made up.
import { beforeAll, describe, expect, it } from 'vitest';
import { readText } from './files';

type Person = { id: string; name: string };
type Ranked = Person & { score: number; likely: boolean };
type NameMatchApi = {
  scoreName: (leaderName: unknown, leadName: unknown) => number;
  rankPeople: (leaderName: unknown, people: unknown) => Ranked[];
  matchQuery: (query: unknown, name: unknown) => number;
  LIKELY_MIN: number;
  LIKELY_MARGIN: number;
  SUGGEST_MIN: number;
};

let N: NameMatchApi;

beforeAll(async () => {
  await import('../public/name-match.js' as string);
  N = (globalThis as unknown as { NameMatch: NameMatchApi }).NameMatch;
});

const score = (a: unknown, b: unknown) => N.scoreName(a, b);
const likelyBar = () => N.LIKELY_MIN;

describe('scoreName', () => {
  it('exact first and last name is 1', () => {
    expect(score('Jordan Notreal', 'Jordan Notreal')).toBe(1);
  });

  it('ignores case, accents, punctuation and extra spaces', () => {
    expect(score('élodie  FICTIF', 'Elodie Fictif')).toBe(1);
    expect(score("Rowan O'Mockery", 'rowan omockery')).toBe(1);
    expect(score('Jordan Notreal.', '  jordan   notreal ')).toBe(1);
  });

  it('token order does not matter', () => {
    expect(score('Jordan Notreal', 'Notreal, Jordan')).toBe(1);
    expect(score('Jordan Notreal', 'Notreal Jordan')).toBeGreaterThanOrEqual(0.95);
    expect(score('Notreal, Jordan Avery', 'Jordan Notreal')).toBeGreaterThanOrEqual(0.95);
  });

  it('knows common nicknames, in both directions', () => {
    for (const [a, b] of [['Bill Sampleby', 'William Sampleby'], ['Katie Inventa', 'Catherine Inventa'], ['Drew Hypothetic', 'Andrew Hypothetic'], ['Liz Fauxley', 'Elizabeth Fauxley'], ['Jack Unrealton', 'John Unrealton']]) {
      expect(score(a, b)).toBeGreaterThanOrEqual(likelyBar());
      expect(score(b, a)).toBe(score(a, b));
    }
  });

  it('a short form that starts the full name counts (3 letters or more)', () => {
    expect(score('Fran Mockley', 'Francesca Mockley')).toBeGreaterThanOrEqual(likelyBar());
    expect(score('Al Mockley', 'Alberto Mockley')).toBeLessThan(likelyBar()); // too short to tell
  });

  it('going by a middle name counts', () => {
    const s = score('Avery Notreal', 'Jordan Avery Notreal');
    expect(s).toBeGreaterThanOrEqual(likelyBar());
    expect(s).toBeLessThan(score('Jordan Notreal', 'Jordan Avery Notreal'));
  });

  it('a first initial is a moderate match, not a likely one', () => {
    const s = score('J Notreal', 'Jordan Notreal');
    expect(s).toBeGreaterThan(0.5);
    expect(s).toBeLessThan(likelyBar());
    expect(score('K Notreal', 'Jordan Notreal')).toBeLessThan(0.5);
  });

  it('tolerates a small typo but not in short names', () => {
    expect(score('Jordna Notreal', 'Jordan Notreal')).toBeGreaterThanOrEqual(likelyBar());
    expect(score('Jordan Notreel', 'Jordan Notreal')).toBeGreaterThanOrEqual(likelyBar());
    expect(score('Bo Fakerton', 'Jo Fakerton')).toBeLessThan(0.5); // two letters: no typo allowance
  });

  it('a hyphenated or two-word surname matches one part of it', () => {
    expect(score('Ana Mockley', 'Ana Mockley-Fauxton')).toBeGreaterThanOrEqual(likelyBar());
    expect(score('Ana Fauxton', 'Ana Mockley Fauxton')).toBeGreaterThanOrEqual(likelyBar());
  });

  it('ignores suffixes and middle initials', () => {
    expect(score('Jordan Notreal Jr.', 'Jordan Notreal')).toBe(1);
    expect(score('Jordan Notreal', 'Notreal, Jordan, III')).toBe(1);
    expect(score('Jordan Q. Notreal', 'Jordan Notreal')).toBe(1);
  });

  it('a shared surname alone (a sibling or spouse) is relevant but far from likely', () => {
    const s = score('Jordan Notreal', 'Casey Notreal');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeGreaterThanOrEqual(N.SUGGEST_MIN);
    expect(s).toBeLessThan(0.5);
  });

  it('a shared first name alone is weak', () => {
    const s = score('Jordan Notreal', 'Jordan Fakesmith');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(N.SUGGEST_MIN);
  });

  it('unrelated names score low, including near-miss surnames and back-to-front guesses', () => {
    expect(score('Jordan Notreal', 'Blair Imaginary')).toBe(0);
    expect(score('Jordan Notreal', 'Jordan Notrealson')).toBeLessThan(N.SUGGEST_MIN);
    // Read back to front, first names must agree exactly or by nickname: Jon/Jonesy is only a shared surname.
    expect(score('Jon Fakerton', 'Fakerton Jonesy')).toBeLessThan(0.5);
  });

  it('empty or odd input does not throw', () => {
    for (const [a, b] of [['', ''], [null, undefined], ['Jordan', ''], ['-- ,, .', 'Jordan Notreal'], [42, 'Jordan'], [{}, []], ['Jordan', 'Jordan']]) {
      const s = score(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(score('', '')).toBe(0);
  });
});

describe('rankPeople', () => {
  const people: Person[] = [
    { id: 'P1', name: 'Blair Imaginary' },
    { id: 'P2', name: 'Casey Notreal' },
    { id: 'P3', name: 'Jordan Avery Notreal' },
    { id: 'P4', name: 'Jordan Fakesmith' },
  ];

  it('ranks best first and flags one clear likely match', () => {
    const r = N.rankPeople('Jordan Notreal', people);
    expect(r.map((p) => p.id)).toEqual(['P3', 'P2', 'P4', 'P1']);
    expect(r.filter((p) => p.likely).map((p) => p.id)).toEqual(['P3']);
    expect(r[0]).toMatchObject({ id: 'P3', name: 'Jordan Avery Notreal', likely: true });
  });

  it('flags nobody when two people are both strong', () => {
    const r = N.rankPeople('Taylor Testwell', [...people, { id: 'P5', name: 'Taylor Testwell-Mock' }, { id: 'P6', name: 'Tay Testwell' }]);
    expect(r[0]!.score).toBeGreaterThanOrEqual(likelyBar());
    expect(r[1]!.score).toBeGreaterThanOrEqual(likelyBar());
    expect(r.some((p) => p.likely)).toBe(false);
  });

  it('flags nobody when the best is only a sibling', () => {
    const r = N.rankPeople('Morgan Notreal', people);
    expect(r[0]!.id).toBe('P2');
    expect(r.some((p) => p.likely)).toBe(false);
  });

  it('breaks ties by name, then id, whatever the input order', () => {
    const tied: Person[] = [
      { id: 'B', name: 'Zed Unrelated' },
      { id: 'A', name: 'Zed Unrelated' },
      { id: 'C', name: 'Amy Unrelated' },
    ];
    const ids = (list: Person[]) => N.rankPeople('Jordan Notreal', list).map((p) => p.id);
    expect(ids(tied)).toEqual(['C', 'A', 'B']);
    expect(ids([...tied].reverse())).toEqual(['C', 'A', 'B']);
  });

  it('copes with empty or odd input', () => {
    expect(N.rankPeople('Jordan Notreal', [])).toEqual([]);
    expect(N.rankPeople('Jordan Notreal', null)).toEqual([]);
    expect(N.rankPeople('', [{ id: 'X', name: 'Jordan' }])).toEqual([{ id: 'X', name: 'Jordan', score: 0, likely: false }]);
  });
});

describe('matchQuery (type-ahead)', () => {
  it('an empty search fits everyone', () => {
    expect(N.matchQuery('', 'Blair Imaginary')).toBe(1);
    expect(N.matchQuery('   ', 'Blair Imaginary')).toBe(1);
  });

  it('matches the start of or inside any word, ignoring case and accents', () => {
    expect(N.matchQuery('jor', 'Jordan Avery Notreal')).toBeGreaterThan(0);
    expect(N.matchQuery('NOTR', 'Jordan Avery Notreal')).toBeGreaterThan(0);
    expect(N.matchQuery('real', 'Jordan Avery Notreal')).toBeGreaterThan(0);
    expect(N.matchQuery('elodie', 'Élodie Fictif')).toBeGreaterThan(0);
    expect(N.matchQuery('jordan not', 'Jordan Avery Notreal')).toBeGreaterThan(0);
  });

  it('ranks a whole word above a word start above a word inside', () => {
    const whole = N.matchQuery('jordan', 'Jordan Notreal');
    const start = N.matchQuery('jord', 'Jordan Notreal');
    const inside = N.matchQuery('rdan', 'Jordan Notreal');
    expect(whole).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(inside);
  });

  it('finds nicknames and small typos, and leaves out the rest', () => {
    expect(N.matchQuery('bill', 'William Sampleby')).toBeGreaterThan(0);
    expect(N.matchQuery('jrodan', 'Jordan Notreal')).toBeGreaterThan(0);
    expect(N.matchQuery('zz', 'Jordan Notreal')).toBe(0);
    expect(N.matchQuery('jordan zz', 'Jordan Notreal')).toBe(0);
  });
});

describe('loading in the browser', () => {
  it('the page loads name-match.js before app.js, and the service worker caches it', async () => {
    const html = await readText('public/index.html');
    const a = html.indexOf('<script src="/name-match.js" defer></script>');
    const b = html.indexOf('<script src="/app.js" defer></script>');
    expect(a).toBeGreaterThan(-1);
    expect(a).toBeLessThan(b);
    const sw = await readText('public/sw.js');
    expect(sw).toContain("'/name-match.js',");
    const js = await readText('public/name-match.js');
    expect(js).not.toMatch(/\beval\(|new Function\(|fetch\(|XMLHttpRequest|console\.|localStorage|sessionStorage/);
  });
});
