/* Holy Nudge: how likely is a Lead person's name the same human as a leader's name in the app?
 * Pure functions, no data kept, nothing sent anywhere. Used by the Team tab's Lead chooser to suggest people and
 * to filter the list as staff type. A suggestion only: the automatic matching on the server (src/core/match.ts)
 * never uses this.
 *
 * Plain classic script, loaded before app.js. It sets globalThis.NameMatch, so the browser (window.NameMatch)
 * and the tests (which import this file for its side effect) share this one implementation.
 */
(function () {
  'use strict';

  var LIKELY_MIN = 0.85; // a "likely match" scores at least this...
  var LIKELY_MARGIN = 0.15; // ...and beats the next best person by at least this much
  var SUGGEST_MIN = 0.35; // worth suggesting at all (a shared surname is, a shared first name alone is not)

  var SUFFIXES = { jr: 1, sr: 1, ii: 1, iii: 1, iv: 1 };

  // Common English nickname groups. Names in the same group are treated as the same first name.
  var NICKNAMES = [
    'william will bill billy willy liam',
    'katherine catherine kathryn kate katie kathy cathy kat',
    'michael mike mikey mick',
    'elizabeth liz lizzie lizzy beth betsy betty eliza ellie libby',
    'eleanor ellie nell nora elle',
    'alexander alex xander',
    'alexandra alex lexi sasha',
    'benjamin ben benny',
    'matthew matt matty',
    'joshua josh',
    'abigail abby abbie',
    'madison maddie maddy',
    'madeline madeleine madelyn maddie maddy',
    'zachary zach zack zac',
    'nicholas nick nicky',
    'christopher chris topher',
    'christian chris',
    'christina christine chris tina chrissy',
    'andrew andy drew',
    'thomas tom tommy',
    'daniel dan danny',
    'danielle dani',
    'joseph joe joey',
    'jacob jake',
    'samuel sam sammy',
    'samantha sam sammie',
    'anthony tony',
    'james jim jimmy jamie',
    'robert rob robbie bob bobby bert',
    'david dave davey',
    'stephen steven steve stevie',
    'gregory greg',
    'jennifer jen jenn jenny',
    'rebecca becca becky',
    'megan meg',
    'margaret meg maggie peggy',
    'gabriel gabe',
    'gabriella gabrielle gabby',
    'nathan nate',
    'nathaniel nate nat',
    'charles charlie chuck',
    'charlotte charlie lottie',
    'john jack johnny',
    'jonathan jon jonny',
    'edward ed eddie ted',
    'theodore theo ted teddy',
    'richard rick ricky rich richie',
    'timothy tim timmy',
    'patrick pat',
    'patricia pat patty trish',
    'victoria vicky tori',
    'jessica jess jessie',
    'susan sue susie',
    'deborah debbie deb',
    'olivia liv',
    'isabella isabelle izzy bella',
    'peter pete',
    'kenneth ken kenny',
    'philip phillip phil',
  ];
  var NICK = {}; // name -> list of group indexes
  NICKNAMES.forEach(function (line, gi) {
    line.split(' ').forEach(function (n) {
      (NICK[n] || (NICK[n] = [])).push(gi);
    });
  });

  function nicknames(a, b) {
    var ga = NICK[a];
    var gb = NICK[b];
    if (!ga || !gb) return false;
    for (var i = 0; i < ga.length; i++) if (gb.indexOf(ga[i]) !== -1) return true;
    return false;
  }

  /* Lowercase, accents off, apostrophes dropped (O'Neil -> oneil), other punctuation and hyphens become spaces. */
  function clean(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/['\u2018\u2019`]/g, '')
      .replace(/[^a-z0-9,]+/g, ' ');
  }

  function words(s) {
    return s.split(/[\s,]+/).filter(function (w) { return w && !SUFFIXES[w]; });
  }

  /* Tokens in given-name-first order. "Last, First Middle" is turned around. */
  function tokens(name) {
    var c = clean(name);
    var i = c.indexOf(',');
    if (i !== -1) {
      var before = words(c.slice(0, i));
      var after = words(c.slice(i + 1));
      if (before.length && after.length) return after.concat(before);
    }
    return words(c);
  }

  /* A single-letter middle initial is neither evidence for nor against: drop it (but keep a first initial). */
  function tidy(toks) {
    return toks.filter(function (t, i) { return i === 0 || t.length > 1; });
  }

  /* The ways to read a name: as written, and (two words or more, no comma) as "Last First Middle". Read that
     way, only the word moved to the end can be the surname. */
  function readings(name) {
    var t = tokens(name);
    var out = [{ toks: tidy(t), turned: false }];
    if (t.length > 1 && clean(name).indexOf(',') === -1) out.push({ toks: tidy(t.slice(1).concat(t[0])), turned: true });
    return out;
  }

  /* Optimal string alignment distance (Levenshtein plus adjacent swaps), stopping early past 2. */
  function distance(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    var prev2 = null;
    var prev = [];
    var j;
    for (j = 0; j <= b.length; j++) prev.push(j);
    for (var i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        var v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a.charAt(i - 1) === b.charAt(j - 2) && a.charAt(i - 2) === b.charAt(j - 1)) {
          v = Math.min(v, prev2[j - 2] + 1);
        }
        cur.push(v);
      }
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  /* Same word, or a small typo of it. Short words must be exact, so short unrelated names never score. */
  function wordSim(a, b) {
    if (a === b) return 1;
    var n = Math.min(a.length, b.length);
    if (n < 4) return 0;
    var d = distance(a, b);
    if (d === 1) return 0.85;
    if (d === 2 && n >= 7) return 0.7;
    return 0;
  }

  /* How strongly two first names point to the same person. Strict: same name or nickname only. */
  function firstRel(a, b, strict) {
    if (a === b) return 1;
    if (a.length > 1 && b.length > 1 && nicknames(a, b)) return 0.9;
    if (strict) return 0;
    if (a.length === 1 || b.length === 1) return a.charAt(0) === b.charAt(0) ? 0.6 : 0; // "J Smith"
    var s = a.length <= b.length ? a : b;
    var l = s === a ? b : a;
    if (s.length >= 3 && l.indexOf(s) === 0) return 0.85; // Sam / Samuel
    return wordSim(a, b) * 0.95;
  }

  /* One name goes by the other's middle name ("Lee Smith" / "John Lee Smith"). */
  function middleRel(first, others, skip) {
    var best = 0;
    others.forEach(function (o, i) {
      if (i === skip || o.length < 2 || first.length < 2) return;
      if (o === first) best = Math.max(best, 0.8);
      else if (nicknames(o, first)) best = Math.max(best, 0.75);
    });
    return best;
  }

  /* Score one reading of each name. turned: one of them is read as "Last First", so its surname is its last
     word only, and first names must agree exactly or by nickname (no prefix, initial or typo guesses). */
  function readingScore(ra, rb) {
    var a = ra.toks;
    var b = rb.toks;
    var turned = ra.turned || rb.turned;
    if (!a.length || !b.length) return 0;
    if (a.length === 1 || b.length === 1) {
      // A one-word name: weak evidence however it matches.
      var lone = a.length === 1 ? a[0] : b[0];
      var other = a.length === 1 ? b : a;
      var best = 0;
      other.forEach(function (o, i) { best = Math.max(best, i === 0 ? firstRel(lone, o, turned) : wordSim(lone, o)); });
      return 0.3 * best;
    }
    var ao = a.slice(1);
    var bo = b.slice(1);
    // Surname: the best agreement between later words on each side (covers hyphenated and two-word surnames).
    var sr = 0;
    var si = -1;
    var sj = -1;
    ao.forEach(function (x, i) {
      if (ra.turned && i !== ao.length - 1) return;
      bo.forEach(function (y, j) {
        if (rb.turned && j !== bo.length - 1) return;
        var s = wordSim(x, y);
        if (s > sr) { sr = s; si = i; sj = j; }
      });
    });
    var fr = firstRel(a[0], b[0], turned);
    if (sr > 0) {
      fr = Math.max(fr, middleRel(a[0], bo, sj), middleRel(b[0], ao, si));
      return sr * (0.4 + 0.6 * fr); // surname alone 0.4: siblings and spouses share surnames
    }
    return 0.25 * fr; // first name alone: maiden/married names exist, but first names are common
  }

  /* 0..1: how likely leadName is the same person as leaderName. 1 only for the same words in the same order. */
  function scoreName(leaderName, leadName) {
    var ra = readings(leaderName);
    var rb = readings(leadName);
    if (!ra[0].toks.length || !rb[0].toks.length) return 0;
    if (ra[0].toks.join(' ') === rb[0].toks.join(' ')) return 1;
    // As written; or one of the two (never both) read back to front, a little less sure.
    var best = readingScore(ra[0], rb[0]);
    if (ra[1]) best = Math.max(best, 0.97 * readingScore(ra[1], rb[0]));
    if (rb[1]) best = Math.max(best, 0.97 * readingScore(ra[0], rb[1]));
    return Math.round(Math.min(best, 0.97) * 1000) / 1000;
  }

  function sortKey(name) {
    return tokens(name).join(' ');
  }

  function byName(a, b) {
    var ka = sortKey(a.name);
    var kb = sortKey(b.name);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    var ia = String(a.id);
    var ib = String(b.id);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  }

  /* People scored against a leader's name, best first (ties by name, then id). At most one is flagged
     likely: it must clear LIKELY_MIN and lead the next best by LIKELY_MARGIN, so two strong people flag neither. */
  function rankPeople(leaderName, people) {
    var list = (Array.isArray(people) ? people : []).map(function (p) {
      return { id: p.id, name: String(p.name == null ? '' : p.name), score: scoreName(leaderName, p.name), likely: false };
    });
    list.sort(function (a, b) { return b.score - a.score || byName(a, b); });
    var top = list[0];
    if (top && top.score >= LIKELY_MIN && top.score - (list[1] ? list[1].score : 0) >= LIKELY_MARGIN) top.likely = true;
    return list;
  }

  /* 0..1: how well a typed search fits a name (0 = leave it out). Every typed word must fit some word of the
     name: whole word, start of a word, inside a word, a nickname, or a small typo. Empty search fits everyone. */
  function matchQuery(query, name) {
    var q = clean(query).split(/[\s,]+/).filter(Boolean);
    if (!q.length) return 1;
    var n = clean(name).split(/[\s,]+/).filter(Boolean);
    var total = 0;
    for (var i = 0; i < q.length; i++) {
      var t = q[i];
      var best = 0;
      for (var j = 0; j < n.length; j++) {
        var w = n[j];
        var s = 0;
        if (w === t) s = 1;
        else if (w.indexOf(t) === 0) s = 0.9;
        else if (nicknames(t, w)) s = 0.75;
        else if (t.length >= 2 && w.indexOf(t) !== -1) s = 0.6;
        else if (t.length >= 4 && (wordSim(t, w) || wordSim(t, w.slice(0, t.length)))) s = 0.5;
        if (s > best) best = s;
      }
      if (!best) return 0;
      total += best;
    }
    return total / q.length;
  }

  globalThis.NameMatch = {
    scoreName: scoreName,
    rankPeople: rankPeople,
    matchQuery: matchQuery,
    LIKELY_MIN: LIKELY_MIN,
    LIKELY_MARGIN: LIKELY_MARGIN,
    SUGGEST_MIN: SUGGEST_MIN,
  };
})();
