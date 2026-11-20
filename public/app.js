/* Holy Nudge: leader and admin views, onboarding, push subscription.
 * Plain JavaScript, no framework. Student data is only ever held in memory
 * and rendered with textContent; it is never written to storage, caches, logs or URLs.
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'hn_token';
  var SKIP_KEY = 'hn_skip_onboarding';

  /* ---------------------------------------------------------------- environment */

  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  var query = new URLSearchParams(location.search);
  /* localhost only: leader | admin | invalid | empty, plus the pre-launch previews
     (real data not connected yet): prelaunch (a non-staff leader, starts at onboarding; add &fake=1 to click through),
     prelaunch-off (non-staff, notifications not on: the "finish setting up" screen),
     prelaunch-done (non-staff, all set up: the "you're all set" screen), admin-sample (staff seeing sample data).
     With admin or admin-sample, &tab=team opens the Team tab and &match=<leader id> opens that row's Lead chooser. */
  var mock = isLocal ? query.get('mock') : null;
  var mockPrelaunch = mock === 'prelaunch' || mock === 'prelaunch-off' || mock === 'prelaunch-done';
  var sim = isLocal ? query.get('sim') : null; // onboarding situation overrides, localhost only
  var fakeEnable = isLocal && query.get('fake') === '1'; // pretend the permission + subscribe step works

  function store(op, key, value) {
    try {
      if (op === 'get') return window.localStorage.getItem(key);
      if (op === 'set') window.localStorage.setItem(key, value);
      if (op === 'del') window.localStorage.removeItem(key);
    } catch (_) {
      /* private mode or blocked storage: carry on without it */
    }
    return null;
  }

  function session(op, key, value) {
    try {
      if (op === 'get') return window.sessionStorage.getItem(key);
      if (op === 'set') window.sessionStorage.setItem(key, value);
      if (op === 'del') window.sessionStorage.removeItem(key);
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  /* The token from /l/<token>, if the page was opened that way. */
  function getPathToken() {
    var m = location.pathname.match(/^\/l\/([^/]+)\/?$/);
    if (!m) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch (_) {
      return m[1];
    }
  }

  var token = null; // the token in use for API calls
  var pathToken = null; // token from the URL (an installed iPhone app always opens its original link)
  var storedToken = null; // last token the server accepted on this device

  /* Remember a token only once the server has accepted it, here and in the service worker. */
  function rememberToken(t) {
    if (mock || !t) return;
    storedToken = t;
    store('set', TOKEN_KEY, t);
    sendTokenToSW();
  }

  /* On any 401: the link is unknown or was turned off. Forget it everywhere on this device. */
  function forgetToken() {
    token = null;
    storedToken = null;
    store('del', TOKEN_KEY);
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then(function (reg) {
        var target = reg.active || navigator.serviceWorker.controller;
        if (target) target.postMessage({ type: 'forget-token' });
      })
      .catch(function () {});
  }

  /*
   * The URL's token was refused, but this device holds a different one the server accepted before
   * (for example staff made themselves a new link inside the installed app, which still opens the
   * old link). Switch to it instead of locking them out.
   */
  function switchToStoredToken() {
    if (mock || !storedToken || token === storedToken) return false;
    token = storedToken;
    pathToken = null;
    try {
      history.replaceState(null, '', '/l/' + encodeURIComponent(token));
    } catch (_) {
      /* ignore */
    }
    return true;
  }

  /* ---------------------------------------------------------------- tiny DOM helper */

  function h(tag, props) {
    var el = document.createElement(tag);
    var p = props || {};
    Object.keys(p).forEach(function (k) {
      var v = p[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, kid) {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) {
      kid.forEach(function (k) {
        append(el, k);
      });
    } else if (kid.nodeType) el.appendChild(kid);
    else el.appendChild(document.createTextNode(String(kid)));
  }

  function svg(markup) {
    var t = document.createElement('template');
    t.innerHTML = markup.trim();
    return t.content.firstChild;
  }

  var SHARE_GLYPH =
    '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M8 7l4-4 4 4M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/></svg>';
  var PLUS_GLYPH =
    '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8M8 12h8"/></svg>';

  var root = document.getElementById('app');

  function show() {
    while (root.firstChild) root.removeChild(root.firstChild);
    for (var i = 0; i < arguments.length; i++) append(root, arguments[i]);
    window.scrollTo(0, 0);
  }

  /* ---------------------------------------------------------------- formatting */

  function firstName(name) {
    return String(name || '').trim().split(/\s+/)[0] || 'friend';
  }

  function plural(n, one, many) {
    return n === 1 ? one : many;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function niceDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
    if (!m) return '';
    return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]);
  }

  function localIsoDate() {
    var d = new Date();
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function statusWords(status) {
    switch (status) {
      case 'NOT_STARTED':
        return 'Not started yet';
      case 'IN_PROCESS':
        return 'In progress';
      case 'WAITING':
        return 'Waiting';
      case 'DONE':
        return 'Done';
      default:
        return 'Status unknown';
    }
  }

  function dueInfo(item) {
    if (typeof item.daysOverdue === 'number' && item.daysOverdue > 0) {
      return { text: item.daysOverdue + ' ' + plural(item.daysOverdue, 'day', 'days') + ' overdue', late: true };
    }
    if (item.due) {
      if (item.due === localIsoDate()) return { text: 'Due today', late: false };
      return { text: 'Due ' + niceDate(item.due), late: false };
    }
    return { text: 'No due date', late: false };
  }

  function waitingWords(hours) {
    if (typeof hours !== 'number') return '';
    if (hours >= 48) return 'Waiting ' + Math.floor(hours / 24) + ' days for a leader';
    if (hours >= 1) return 'Waiting ' + Math.floor(hours) + ' ' + plural(Math.floor(hours), 'hour', 'hours') + ' for a leader';
    return 'Just arrived';
  }

  function cleanPhone(p) {
    return String(p || '').replace(/[^\d+]/g, '');
  }

  /* ---------------------------------------------------------------- mock data (localhost only) */

  function mockItem(id, queueId, queueName, status, due, daysOverdue, name, phone, extra) {
    var item = {
      entryId: id,
      queueId: queueId,
      queueName: queueName,
      queueUrl: 'https://example.com/queues/' + queueId,
      status: status,
      due: due,
      daysOverdue: daysOverdue,
      individual: { name: name, phone: phone },
    };
    if (!phone) delete item.individual.phone;
    if (extra) Object.keys(extra).forEach(function (k) { item[k] = extra[k]; });
    return item;
  }

  var hoursAgo = function (h) { return new Date(Date.now() - h * 3600000).toISOString(); };
  // All made up. A mix on purpose: staff and servant leaders, notifications on and off, one with no working link,
  // two added by name and not matched to Lead yet (17, 18), and the owner unmatched (15, which other staff can't change).
  // Coordinators: one queue (11), two (14), one not matched to Lead yet (18), and staff who also coordinates (16).
  var mockLeaders = [
    { id: 11, name: 'Devon Mockford', hasLink: true, lastSeenAt: hoursAgo(24 * 9), notificationsOn: false, isStaff: false, canManage: true, isYou: false, matched: true, coordinates: ['Service Team'] },
    { id: 12, name: 'Lee Madeup', hasLink: false, lastSeenAt: null, notificationsOn: false, isStaff: false, canManage: true, isYou: false, matched: true, coordinates: [] },
    { id: 13, name: 'Quinn Adminson', hasLink: true, lastSeenAt: hoursAgo(0.2), notificationsOn: true, isStaff: true, canManage: true, isYou: true, matched: true, coordinates: [] },
    { id: 14, name: 'Sam Fakename', hasLink: true, lastSeenAt: hoursAgo(3), notificationsOn: true, isStaff: false, canManage: true, isYou: false, matched: true, coordinates: ['Connect Card Coordinators', 'Outreach Team'] },
    { id: 15, name: 'Riley Ownerperson', hasLink: true, lastSeenAt: hoursAgo(30), notificationsOn: true, isStaff: true, canManage: false, isYou: false, matched: false, coordinates: [] },
    { id: 16, name: 'Avery Placeholder', hasLink: true, lastSeenAt: hoursAgo(50), notificationsOn: false, isStaff: true, canManage: true, isYou: false, matched: true, coordinates: ['Staff'] },
    { id: 17, name: 'Jordan Notreal', hasLink: true, lastSeenAt: null, notificationsOn: false, isStaff: false, canManage: true, isYou: false, matched: false, coordinates: [] },
    { id: 18, name: 'Taylor Testwell', hasLink: true, lastSeenAt: hoursAgo(5), notificationsOn: true, isStaff: false, canManage: true, isYou: false, matched: false, coordinates: ['Bible Study Hosts & Events Team'] },
  ];

  // Lead people nobody with a link is matched to yet (made up). Near-misses on purpose: an exact name would
  // already have been matched by the server. For Jordan Notreal (17): one likely match (the fuller legal name),
  // a sibling (same surname) and two other Jordans. For Taylor Testwell (18): two strong candidates, so neither
  // is tagged likely.
  var mockLeadPeople = [
    { id: 'P301', name: 'Blair Imaginary' },
    { id: 'P302', name: 'Casey Notreal' },
    { id: 'P303', name: 'Jordan Notrealson' },
    { id: 'P304', name: 'Morgan Fakerson' },
    { id: 'P305', name: 'Robin Pretendly' },
    { id: 'P306', name: 'Taylor Testwell-Mock' },
    { id: 'P307', name: 'Jordan Avery Notreal' },
    { id: 'P308', name: 'Jordan Fakesmith' },
    { id: 'P309', name: 'Tay Testwell' },
    { id: 'P310', name: 'Alexandra Mockley' },
    { id: 'P311', name: 'William Sampleby' },
    { id: 'P312', name: 'Katherine Inventa' },
    { id: 'P313', name: 'Zachary Unrealton' },
    { id: 'P314', name: 'Madeline Dummer' },
    { id: 'P315', name: 'Nathaniel Fauxley' },
    { id: 'P316', name: 'Rebecca Phantomly' },
    { id: 'P317', name: 'Gabriel Notatall' },
    { id: 'P318', name: 'Élodie Fictif' },
    { id: 'P319', name: 'Christopher Madeupson' },
    { id: 'P320', name: 'Abigail Pseudonym' },
    { id: 'P321', name: 'Sam Fakerson-Lee' },
    { id: 'P322', name: 'Drew Hypothetic' },
    { id: 'P323', name: 'Margaret Placeholderly' },
    { id: 'P324', name: 'Joshua Testerton' },
    { id: 'P325', name: 'Eleanor Mockingham' },
    { id: 'P326', name: 'Benjamin Nobodyson' },
  ];

  var mockAdded = []; // people "added" in a mock session (so a repeat name answers name_taken)

  function mockMe() {
    var manager = mock === 'manager'; // a queue coordinator who is not staff: their queues only, no link controls
    var admin = mock === 'admin' || mock === 'admin-sample' || manager;
    var items = [
      mockItem('e1', 'q3', 'Outreach Team', 'NOT_STARTED', '2026-11-10', 7, 'Pat Example', '405-555-0101'),
      mockItem('e2', 'q4', 'Bible Study Hosts & Events Team', 'IN_PROCESS', '2026-11-14', 3, 'Rowan Placeholder', '405-555-0102'),
      mockItem('e3', 'q3', 'Outreach Team', 'NOT_STARTED', '2026-11-25', null, 'Maple Sample-Longname-Hyphenated', null),
    ];
    var me = {
      leader: { name: admin ? 'Quinn Adminson' : 'Sam Fakename', isAdmin: admin, notificationsOn: mock === 'prelaunch-done' },
      live: !mockPrelaunch && mock !== 'admin-sample',
      behind: mock === 'empty' || mockPrelaunch ? [] : items,
      generatedAt: new Date().toISOString(),
    };
    if (mockPrelaunch) return me; // the server sends no sample data to non-staff before launch
    if (admin) {
      var unassigned = [
        mockItem('e10', 'q1', 'Connect Card Coordinators', 'NOT_STARTED', '2026-11-02', 15, 'Jules Nobody', '405-555-0110', { hoursWaiting: 360 }),
        mockItem('e11', 'q1', 'Connect Card Coordinators', 'NOT_STARTED', '2026-11-09', 8, 'Indigo Testperson', null, { hoursWaiting: 60 }),
        mockItem('e12', 'q2', 'Staff', 'NOT_STARTED', '2026-11-16', 1, 'Corey Sampleton', '405-555-0112', { hoursWaiting: 26 }),
        mockItem('e13', 'q1', 'Connect Card Coordinators', 'NOT_STARTED', null, null, 'Robin Notreal', '405-555-0113', { hoursWaiting: 0 }),
      ];
      me.admin = {
        unassigned: unassigned,
        byLeader: [
          { leader: null, notificationsOn: false, items: unassigned },
          { leader: { name: 'Sam Fakename' }, notificationsOn: true, items: items.slice(0, 2) },
          { leader: { name: 'Devon Mockford' }, notificationsOn: false, items: [mockItem('e20', 'q5', 'Service Team', 'WAITING', '2026-11-12', 5, 'Ash Fictional', '405-555-0120')] },
        ],
        leadersWithoutNotifications: [{ name: 'Devon Mockford' }, { name: 'Lee Madeup' }],
      };
      if (!manager) {
        me.admin.leaders = mockLeaders;
        me.admin.leadPeople = mockLeadPeople.slice();
      }
    }
    return me;
  }

  function mockApi(path, method, body) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (mock === 'invalid') return reject(new ApiError(401, 'invalid_token'));
        if (path === '/api/me') return resolve(mockMe());
        if (path === '/api/vapid-public-key') return resolve({ key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' });
        if (path === '/api/subscribe' && method === 'POST') return resolve({ ok: true });
        if (path === '/api/test-push' && method === 'POST') return resolve({ ok: true, sent: 1 });
        if (path === '/api/leader-link' && method === 'POST') {
          var row = mockLeaders.filter(function (l) { return l.id === (body && body.leaderId); })[0];
          if (!row) return reject(new ApiError(404, 'not_found'));
          if (!row.canManage) return reject(new ApiError(403, 'owner_protected'));
          var fake = 'mock' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + 'link';
          return resolve({ url: location.origin + '/l/' + fake, self: !!row.isYou });
        }
        if (path === '/api/leader-revoke' && method === 'POST') return resolve({ ok: true });
        if (path === '/api/leader-match' && method === 'POST') {
          var who = mockLeaders.filter(function (l) { return l.id === (body && body.leaderId); })[0];
          if (!who) return reject(new ApiError(404, 'not_found'));
          if (!who.canManage) return reject(new ApiError(403, 'owner_protected'));
          if (!who.hasLink) return reject(new ApiError(400, 'no_link'));
          if (body.chmsId === null) {
            who.matched = false;
            return resolve({ ok: true, matched: false });
          }
          var pick = mockLeadPeople.filter(function (p) { return p.id === body.chmsId; })[0];
          if (!pick) return reject(new ApiError(404, 'unknown_person'));
          mockLeadPeople = mockLeadPeople.filter(function (p) { return p !== pick; });
          who.matched = true;
          return resolve({ ok: true, matched: true });
        }
        if (path === '/api/leader-add' && method === 'POST') {
          var nm = String((body && body.name) || '').replace(/\s+/g, ' ').trim();
          var taken = mockLeaders.concat(mockAdded).some(function (l) { return l.name.toLowerCase() === nm.toLowerCase(); });
          if (taken) return reject(new ApiError(409, 'name_taken'));
          var role = body && body.role === 'staff' ? 'staff' : 'leader';
          if (body && body.role !== undefined && body.role !== 'staff' && body.role !== 'leader') return reject(new ApiError(400, 'invalid_role'));
          var added = { id: 100 + mockAdded.length, name: nm, role: role };
          mockAdded.push(added);
          var link = 'mock' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + 'link';
          return resolve({ url: location.origin + '/l/' + link, leader: added });
        }
        reject(new ApiError(404, 'not_found'));
      }, 250);
    });
  }

  /* ---------------------------------------------------------------- API */

  function ApiError(status, code) {
    this.status = status;
    this.code = code;
  }

  function api(path, opts) {
    var o = opts || {};
    var method = o.method || 'GET';
    if (mock) return mockApi(path, method, o.body);
    var headers = { Authorization: 'Bearer ' + token };
    if (o.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: method,
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      cache: 'no-store',
    }).then(function (res) {
      if (res.status === 401) {
        // Try this device's previously accepted token once; otherwise forget the dead link everywhere.
        if (switchToStoredToken()) throw new ApiError(401, 'retry');
        forgetToken();
        throw new ApiError(401, 'invalid_token');
      }
      return res
        .json()
        .catch(function () {
          return null;
        })
        .then(function (data) {
          if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'error');
          return data;
        });
    });
  }

  /* ---------------------------------------------------------------- service worker */

  function sendTokenToSW() {
    if (mock || !token || token !== storedToken || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then(function (reg) {
        var target = reg.active || navigator.serviceWorker.controller;
        if (target) target.postMessage({ type: 'token', token: token });
      })
      .catch(function () {});
  }

  function setUpServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').then(sendTokenToSW, function () {});
    navigator.serviceWorker.addEventListener('controllerchange', sendTokenToSW);
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'refresh') load(true);
    });
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('timeout'));
      }, ms);
      promise.then(
        function (v) {
          clearTimeout(timer);
          resolve(v);
        },
        function (e) {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  function b64urlToBytes(b64) {
    var pad = '='.repeat((4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /* ---------------------------------------------------------------- situation detection */

  function detectBase() {
    var ua = navigator.userAgent || '';
    var ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 && !/Android|Windows|CrOS/.test(ua));
    var standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    var safari = /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|DuckDuckGo|FBAN|FBAV|Instagram|GSA\/|Line\/|Snapchat|Twitter|LinkedInApp|MicroMessenger|; wv/.test(ua);
    var ver = /OS (\d+)[_.](\d+)/.exec(ua);
    var iosOld = !!(ver && (Number(ver[1]) < 16 || (Number(ver[1]) === 16 && Number(ver[2]) < 4)));
    var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    return {
      ios: ios,
      standalone: standalone,
      safari: safari,
      iosOld: iosOld,
      supported: supported,
      perm: 'Notification' in window ? Notification.permission : 'unsupported',
      subscribed: false,
    };
  }

  function applySim(env) {
    switch (sim) {
      case 'ios-safari':
        env.ios = true; env.standalone = false; env.safari = true; env.supported = false;
        break;
      case 'ios-chrome':
        env.ios = true; env.standalone = false; env.safari = false; env.supported = false;
        break;
      case 'ios-installed':
        env.ios = true; env.standalone = true; env.supported = true;
        break;
      case 'denied':
        env.supported = true; env.perm = 'denied';
        break;
      case 'denied-ios':
        env.ios = true; env.standalone = true; env.supported = true; env.perm = 'denied';
        break;
      case 'unsupported':
        env.supported = false; env.ios = false;
        break;
      case 'enable':
        env.supported = true; env.perm = 'default';
        break;
    }
    return env;
  }

  function detectEnv() {
    var env = applySim(detectBase());
    if (mock === 'prelaunch-done') {
      env.supported = true; env.perm = 'granted'; env.subscribed = true;
      return Promise.resolve(env);
    }
    if (!env.supported || env.perm !== 'granted' || sim) return Promise.resolve(env);
    return withTimeout(navigator.serviceWorker.ready, 3000)
      .then(function (reg) {
        return reg.pushManager.getSubscription();
      })
      .then(function (sub) {
        env.subscribed = !!sub;
        return env;
      })
      .catch(function () {
        return env;
      });
  }

  /* ---------------------------------------------------------------- state */

  var S = {
    me: null,
    env: null,
    view: 'loading', // loading | notoken | invalid | error | onboarding | success | main
    tab: 'mine',
    skipped: session('get', SKIP_KEY) === '1',
    loadedAt: 0,
    errorCode: null,
    minted: {}, // leader id -> URL just minted (memory only, shown once, gone on reload)
    justAdded: null, // id of the leader staff just added: their new-link panel shows under the add form
    addRole: 'leader', // leader | staff: the role chosen in the add form
    addName: '', // what is typed in the add form (survives a re-render)
    addOpen: false, // add form is tucked behind an "Add a leader" button until tapped
    matchOpen: null, // id of the leader whose Lead chooser is open (staff)
    matchChoice: '', // the Lead person picked in that chooser (survives a re-render)
    matchQuery: null, // what is typed in the chooser's search (null: not opened yet, starts as the leader's first name)
    matchNote: {}, // leader id -> short note after a match change ("Matched to ...")
  };
  if (mock) {
    var mockTab = query.get('tab');
    if (mockTab === 'mine' || mockTab === 'unassigned' || mockTab === 'behind' || mockTab === 'team') S.tab = mockTab;
    var mockMatch = Number(query.get('match'));
    if (mockMatch > 0) {
      S.tab = 'team';
      S.matchOpen = mockMatch;
    }
  }

  /* Real data is not connected yet and this is not staff: there is no student list to show, only setup. */
  function isPreLaunch() {
    return !!S.me && S.me.live === false && !S.me.leader.isAdmin;
  }

  /* Notifications will reach this person: on this device, or (iPhone Safari tab) on their Home Screen app. */
  function notificationsReady() {
    if (S.env.subscribed) return true;
    return S.env.ios && !S.env.standalone && S.me.leader.notificationsOn;
  }

  function needsOnboarding() {
    if (S.skipped) return false;
    if (S.env.subscribed) return false;
    // Already on for some device and this is just a Safari tab on iOS: don't nag.
    if (S.env.ios && !S.env.standalone && S.me.leader.notificationsOn) return false;
    return true;
  }

  function load(silent) {
    if (!silent) show(loadingScreen());
    return api('/api/me')
      .then(function (me) {
        rememberToken(token);
        return detectEnv().then(function (env) {
          S.me = me;
          S.env = env;
          S.loadedAt = Date.now();
          // Keep the server in step if this device is subscribed but the server lost track.
          if (env.subscribed && !me.leader.notificationsOn && !mock) resyncSubscription();
          if (silent && S.view === 'main') S.view = 'main';
          else S.view = needsOnboarding() ? 'onboarding' : 'main';
          render();
        });
      })
      .catch(function (e) {
        if (e instanceof ApiError && e.code === 'retry') return load(silent);
        if (e instanceof ApiError && e.status === 401) {
          S.me = null;
          S.view = 'invalid';
        } else if (!silent || !S.me) {
          S.errorCode = e instanceof ApiError ? e.code : null;
          S.view = 'error';
        } else return;
        render();
      });
  }

  function resyncSubscription() {
    navigator.serviceWorker.ready
      .then(function (reg) {
        return reg.pushManager.getSubscription();
      })
      .then(function (sub) {
        if (sub) return api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      })
      .catch(function () {});
  }

  function render() {
    if (closeOpenMenu) closeOpenMenu(false); // its node is about to be replaced
    switch (S.view) {
      case 'notoken':
        return show(noTokenScreen());
      case 'invalid':
        return show(invalidScreen());
      case 'error':
        return show(errorScreen());
      case 'onboarding':
        return show(onboardingScreen());
      case 'success':
        return show(successScreen());
      case 'main':
        show(mainScreen());
        return revealSelectedTab();
      default:
        return show(loadingScreen());
    }
  }

  /* ---------------------------------------------------------------- simple message screens */

  /* The wordmark is the app icon plus live text, coloured by the stylesheet's tokens, so light and dark
     follow the page itself (an SVG with its own prefers-color-scheme rule flips unreliably on iOS). */
  function wordmark(small) {
    return h(
      'div',
      { class: 'wordmark' + (small ? ' small' : ''), role: 'img', 'aria-label': 'Holy Nudge' },
      h('img', { src: '/icon.svg', alt: '', width: '48', height: '48' }),
      h('span', { class: 'wm-text', 'aria-hidden': 'true' }, h('span', { class: 'wm-holy' }, 'Holy'), h('span', { class: 'wm-nudge' }, 'Nudge'))
    );
  }

  function markImg() {
    return wordmark(false);
  }

  /* Wildwood College's logo, small, at the foot of a screen. Two fixed-colour images; the stylesheet's own
     media query shows the one that suits the colour scheme (a <picture> or self-theming SVG misbehaved on iOS). */
  function wildwoodLogo() {
    return h(
      'div',
      { class: 'ww' },
      h('img', { class: 'ww-light', src: '/brand/wildwood-college-navy.png', alt: 'Wildwood College', width: '450', height: '140', loading: 'lazy', decoding: 'async' }),
      h('img', { class: 'ww-dark', src: '/brand/wildwood-college-white.png', alt: 'Wildwood College', width: '450', height: '140', loading: 'lazy', decoding: 'async' })
    );
  }

  function loadingScreen() {
    return h('div', { class: 'screen center' }, markImg(), h('p', { class: 'muted' }, 'Loading your nudges…'));
  }

  function noTokenScreen() {
    return h(
      'div',
      { class: 'screen center' },
      markImg(),
      h('h1', {}, 'Hi there, welcome to Holy Nudge'),
      h('p', { class: 'lead' }, 'This app opens from your own personal link. Please find the email we sent you and tap the link inside.'),
      h('p', { class: 'muted small' }, 'Can’t find it? Just ask Cameron and he’ll send it again.'),
      wildwoodLogo()
    );
  }

  function invalidScreen() {
    return h(
      'div',
      { class: 'screen center' },
      markImg(),
      h('h1', {}, 'This link isn’t working any more'),
      h('p', { class: 'lead' }, 'This link is not valid any more. Please ask Cameron for a new one and we’ll get you sorted.'),
      wildwoodLogo()
    );
  }

  function errorScreen() {
    if (S.errorCode === 'rate_limited') {
      return h(
        'div',
        { class: 'screen center' },
        markImg(),
        h('h1', {}, 'Let’s take a little breather'),
        h('p', { class: 'lead' }, 'Your list has been refreshed a lot in the last few minutes. Give it a few minutes and try again.'),
        h('button', { class: 'btn primary', type: 'button', onclick: function () { load(); } }, 'Try again'),
        wildwoodLogo()
      );
    }
    return h(
      'div',
      { class: 'screen center' },
      markImg(),
      h('h1', {}, 'Hmm, we couldn’t load your list'),
      h('p', { class: 'lead' }, 'Check your connection and try again. It’s not you, it’s us.'),
      h('button', { class: 'btn primary', type: 'button', onclick: function () { load(); } }, 'Try again'),
      wildwoodLogo()
    );
  }

  /* ---------------------------------------------------------------- onboarding */

  function skipButton() {
    return h(
      'button',
      {
        class: 'btn link',
        type: 'button',
        onclick: function () {
          S.skipped = true;
          session('set', SKIP_KEY, '1');
          S.view = 'main';
          render();
        },
      },
      isPreLaunch() ? 'Not now, I’ll finish later' : 'Not now, just show my list'
    );
  }

  function copyLinkButton() {
    var label = h('span', {}, 'Copy this link');
    return h(
      'button',
      {
        class: 'btn small-btn',
        type: 'button',
        onclick: function () {
          copyText(location.href).then(function (ok) {
            label.textContent = ok ? 'Copied' : 'Press and hold the address bar to copy';
          });
        },
      },
      label
    );
  }

  function onboardingScreen() {
    var env = S.env;
    var title, body;

    if (env.ios && !env.standalone) {
      title = 'Add Holy Nudge to your Home Screen';
      var steps = [];
      if (!env.safari) {
        steps.push(
          h('li', {}, h('div', {}, h('strong', {}, 'Open this link in Safari. '), 'It looks like you’re in another browser or inside an app. Tap its menu and choose “Open in Safari”, or copy the link and paste it into Safari.', h('div', { class: 'gap-top' }, copyLinkButton())))
        );
      }
      steps.push(
        h('li', {}, h('div', {}, 'Tap the ', h('strong', {}, 'Share'), ' button ', svg(SHARE_GLYPH), ' at the bottom of Safari (top right on iPad).')),
        h('li', {}, h('div', {}, 'Scroll down and tap ', h('strong', {}, 'Add to Home Screen'), ' ', svg(PLUS_GLYPH), ', then tap ', h('strong', {}, 'Add'), '.')),
        h('li', {}, h('div', {}, 'Open ', h('strong', {}, 'Holy Nudge'), ' from your Home Screen, not from Safari. That’s where you’ll turn on notifications.'))
      );
      body = [
        h('ol', { class: 'steps' }, steps),
        h(
          'div',
          { class: 'panel notice' },
          h('p', { class: 'small' }, env.iosOld
            ? 'Your iPhone looks like it’s on an older iOS. Notifications need iOS 16.4 or later, so you may need to update in Settings, General, Software Update.'
            : 'Notifications on iPhone need iOS 16.4 or later, and this has to be done in Safari. Not sure which iOS you have? Settings, General, About.')
        ),
      ];
    } else if (!env.supported) {
      title = 'Notifications aren’t available here';
      body = [
        h(
          'div',
          { class: 'panel' },
          h('p', {}, env.ios && env.iosOld
            ? 'Notifications on iPhone need iOS 16.4 or later. You can update in Settings, General, Software Update.'
            : 'This browser can’t receive notifications, so we can’t nudge you here.'),
          h('p', { class: 'muted' }, (isPreLaunch() ? '' : 'You can still use this page to see who’s waiting on you. ') + 'For notifications, try Safari on an iPhone (added to the Home Screen), or Chrome, Edge or Firefox on a computer or Android phone.')
        ),
      ];
    } else if (env.perm === 'denied') {
      title = 'Notifications are switched off';
      body = [
        h(
          'div',
          { class: 'panel' },
          h('p', {}, 'No worries, you can switch them back on. Here’s how:'),
          env.ios
            ? h('ol', { class: 'steps' }, h('li', {}, h('div', {}, 'Open the ', h('strong', {}, 'Settings'), ' app on your iPhone.')), h('li', {}, h('div', {}, 'Tap ', h('strong', {}, 'Notifications'), ', then ', h('strong', {}, 'Holy Nudge'), '.')), h('li', {}, h('div', {}, 'Turn on ', h('strong', {}, 'Allow Notifications'), ', then come back here.')))
            : h('ol', { class: 'steps' }, h('li', {}, h('div', {}, 'Tap the lock or settings icon next to the address bar.')), h('li', {}, h('div', {}, 'Find ', h('strong', {}, 'Notifications'), ' and set it to ', h('strong', {}, 'Allow'), '.')), h('li', {}, h('div', {}, 'Come back here and tap the button below.'))),
          h('p', { class: 'status-line', id: 'recheck-msg', role: 'status' }),
          h('button', {
            class: 'btn primary',
            type: 'button',
            onclick: function () {
              recheckPermission();
            },
          }, 'I’ve changed it, check again')
        ),
      ];
    } else {
      title = 'Let’s turn on your nudges';
      var statusEl = h('p', { class: 'status-line', role: 'status' });
      var btn = h('button', { class: 'btn primary big', type: 'button' }, 'Turn on notifications');
      btn.addEventListener('click', function () {
        enableNotifications(btn, statusEl);
      });
      body = [
        h('p', { class: 'lead' }, 'We’ll send one gentle nudge in the morning when a student is waiting on you. Nothing else, we promise.'),
        btn,
        statusEl,
      ];
    }

    return h(
      'div',
      { class: 'screen' },
      markImg(),
      h('div', {}, h('h1', {}, title), env.ios && !env.standalone ? h('p', { class: 'lead gap-top' }, 'Just a minute of setup and then you’re done.') : null),
      body,
      skipButton(),
      wildwoodLogo()
    );
  }

  function recheckPermission() {
    var now = 'Notification' in window ? Notification.permission : 'unsupported';
    if (now === 'denied') {
      var m = document.getElementById('recheck-msg');
      if (m) {
        m.className = 'status-line err';
        m.textContent = 'Still switched off. Give the steps above another go, then try again.';
      }
      return;
    }
    S.env.perm = now;
    render();
  }

  function enableNotifications(btn, statusEl) {
    function say(msg, kind) {
      statusEl.className = 'status-line' + (kind ? ' ' + kind : '');
      statusEl.textContent = msg;
    }

    btn.disabled = true;
    say('One moment…');

    // requestPermission must be the first thing that happens inside the tap.
    var permP = fakeEnable ? Promise.resolve('granted') : Notification.requestPermission();
    permP
      .then(function (perm) {
        if (perm === 'denied') {
          S.env.perm = 'denied';
          render();
          return null;
        }
        if (perm !== 'granted') {
          btn.disabled = false;
          say('No problem. Tap the button again whenever you’re ready.');
          return null;
        }
        return subscribeThisDevice().then(function () {
          S.env.perm = 'granted';
          S.env.subscribed = true;
          S.me.leader.notificationsOn = true;
          // Before launch the "you're all set" screen is the main screen (there is no list to go on to).
          S.view = isPreLaunch() ? 'main' : 'success';
          render();
        });
      })
      .catch(function (e) {
        btn.disabled = false;
        if (e instanceof ApiError && e.status === 401) {
          S.view = 'invalid';
          return render();
        }
        if (e instanceof ApiError && e.code === 'subscription_conflict') {
          return say('This device is already getting nudges for someone else’s link. Ask Cameron if that’s a surprise.', 'err');
        }
        say('Something went wrong turning notifications on. Please try again in a moment.', 'err');
      });
  }

  function subscribeThisDevice() {
    if (fakeEnable) return api('/api/subscribe', { method: 'POST', body: { subscription: {} } });
    var reg;
    return withTimeout(navigator.serviceWorker.ready, 8000)
      .then(function (r) {
        reg = r;
        return api('/api/vapid-public-key');
      })
      .then(function (res) {
        var opts = { userVisibleOnly: true, applicationServerKey: b64urlToBytes(res.key) };
        return reg.pushManager.subscribe(opts).catch(function (err) {
          if (err && err.name === 'InvalidStateError') {
            // An older subscription with a different key: replace it.
            return reg.pushManager
              .getSubscription()
              .then(function (old) {
                return old ? old.unsubscribe() : null;
              })
              .then(function () {
                return reg.pushManager.subscribe(opts);
              });
          }
          throw err;
        });
      })
      .then(function (sub) {
        return api('/api/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      });
  }

  function successScreen() {
    var statusEl = h('p', { class: 'status-line', role: 'status' });
    var test = testButton(statusEl, 'primary big');
    return h(
      'div',
      { class: 'screen' },
      markImg(),
      h('div', {}, h('h1', {}, 'You’re all set'), h('p', { class: 'lead gap-top' }, 'Nudges are on. Want to see what one looks like?')),
      test,
      statusEl,
      h('button', { class: 'btn', type: 'button', onclick: function () { S.view = 'main'; render(); } }, 'Show my list'),
      wildwoodLogo()
    );
  }

  function testButton(statusEl, cls) {
    var btn = h('button', { class: 'btn ' + (cls || ''), type: 'button' }, 'Send me a test nudge');
    btn.addEventListener('click', function () {
      btn.disabled = true;
      statusEl.className = 'status-line';
      statusEl.textContent = 'Sending…';
      api('/api/test-push', { method: 'POST' })
        .then(function (res) {
          if (res && res.sent > 0) {
            statusEl.className = 'status-line ok';
            statusEl.textContent = 'Sent! It should pop up in a few seconds.';
          } else {
            statusEl.className = 'status-line err';
            statusEl.textContent = 'Nothing went out, because no device is signed up yet. Try turning notifications on again.';
          }
        })
        .catch(function (e) {
          statusEl.className = 'status-line err';
          statusEl.textContent =
            e instanceof ApiError && e.status === 429
              ? 'You’ve sent a few tests already. Try again in a few minutes.'
              : 'That didn’t go through. Please try again in a moment.';
        })
        .then(function () {
          btn.disabled = false;
        });
    });
    return btn;
  }

  /* ---------------------------------------------------------------- clipboard / email */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return legacyCopy(text);
        }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    var ta = h('textarea', { class: 'copy-buffer', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      ta.setSelectionRange(0, text.length);
    } catch (_) {
      /* ignore */
    }
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }

  function mailtoFor(link) { // { name, url }
    var subject = 'Your Holy Nudge link';
    var body =
      'Hi ' + firstName(link.name) + ',\n\n' +
      'Here is your personal link for Holy Nudge, a little app that gives you a friendly nudge when a student is waiting to hear from you:\n\n' +
      link.url + '\n\n' +
      'Open it on your phone and follow the steps to add it to your Home Screen and turn on notifications. This link is just for you, so please keep it to yourself.\n\n' +
      'Thank you for caring for these students!';
    return 'mailto:?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }

  /* ---------------------------------------------------------------- cards */

  function actionsFor(item) {
    var ind = item.individual || {};
    var phone = cleanPhone(ind.phone);
    var kids = [];
    if (phone) {
      kids.push(h('a', { class: 'btn', href: 'sms:' + phone, 'aria-label': 'Text ' + (ind.name || '') }, 'Text'));
      kids.push(h('a', { class: 'btn', href: 'tel:' + phone, 'aria-label': 'Call ' + (ind.name || '') }, 'Call'));
    }
    if (item.queueUrl) {
      kids.push(h('a', { class: 'btn primary', href: item.queueUrl, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Open ' + (ind.name || 'this person') + ' in ChMS' }, 'Open in ChMS'));
    }
    return h('div', { class: 'actions' }, kids);
  }

  function personCard(item, opts) {
    var o = opts || {};
    var ind = item.individual || {};
    var due = dueInfo(item);
    var meta = [h('span', { class: 'chip' }, item.queueName || 'Queue'), h('span', { class: 'chip' }, statusWords(item.status))];
    var line = o.waiting ? waitingWords(item.hoursWaiting) : null;
    return h(
      'li',
      { class: 'card' + (due.late ? ' overdue' : '') },
      h('h3', {}, ind.name || 'Unnamed'),
      h('div', { class: 'meta' }, meta),
      h('div', {}, h('span', { class: 'due' + (due.late ? ' late' : '') }, due.text), line ? h('span', { class: 'muted' }, ' · ' + line) : null),
      actionsFor(item)
    );
  }

  function emptyState(title, text) {
    return h('div', { class: 'panel empty' }, h('div', { class: 'sprig', 'aria-hidden': 'true' }), h('h2', {}, title), h('p', { class: 'muted' }, text));
  }

  /* ---------------------------------------------------------------- main view */

  function greeting() {
    var hr = new Date().getHours();
    var part = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    return part + ', ' + firstName(S.me.leader.name);
  }

  function mainScreen() {
    var me = S.me;
    if (isPreLaunch()) return preLaunchScreen();
    var parts = [];

    parts.push(
      h(
        'div',
        { class: 'top' },
        h('div', { class: 'brand' }, wordmark(true)),
        h('button', { class: 'btn small-btn', type: 'button', onclick: function () { load(true); } }, 'Refresh')
      )
    );

    // Staff see sample students until real data is connected; say so, quietly.
    if (me.live === false && me.leader.isAdmin) {
      parts.push(h('p', { class: 'muted small gap-top gap-bottom' }, 'You’re seeing sample data. Real students will appear once ChMS is connected.'));
    }

    if (me.admin) parts.push(tabBar());

    var tab = me.admin ? S.tab : 'mine';
    if (tab === 'mine') parts.push(mineView());
    else if (tab === 'unassigned') parts.push(unassignedView());
    else if (tab === 'behind') parts.push(behindView());
    else parts.push(teamView());

    parts.push(footer());
    return h('div', {}, parts);
  }

  /* ---------------------------------------------------------------- before launch (non-staff) */

  var CHECK_GLYPH =
    '<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  /*
   * Real data isn't connected yet, so there is no list to show and nothing has been checked.
   * Either they're set up (nothing more to do, a test button), or we steer them back to setup.
   */
  function preLaunchScreen() {
    if (!notificationsReady()) {
      return h(
        'div',
        { class: 'screen' },
        markImg(),
        h('div', {}, h('h1', {}, 'Let’s finish setting up'), h('p', { class: 'lead gap-top' }, 'Notifications aren’t on yet, so we can’t send your morning nudge. It only takes a minute.')),
        h('button', { class: 'btn primary big', type: 'button', onclick: function () { S.skipped = false; session('del', SKIP_KEY); S.view = 'onboarding'; render(); } }, 'Finish setting up'),
        wildwoodLogo()
      );
    }
    var statusEl = h('p', { class: 'status-line', role: 'status' });
    return h(
      'div',
      { class: 'screen' },
      markImg(),
      h('div', { class: 'done-mark' }, svg(CHECK_GLYPH)),
      h('div', {}, h('h1', {}, 'You’re all set, ' + firstName(S.me.leader.name)), h('p', { class: 'lead gap-top' }, 'Notifications are on, and you’re set up. There’s nothing else you need to do right now.')),
      h('div', { class: 'panel good' }, h('p', {}, 'When students are waiting on you, a morning notification will tell you how many.')),
      h('p', { class: 'muted' }, 'Want to see what that looks like?'),
      testButton(statusEl, 'primary big'),
      statusEl,
      h('p', { class: 'muted small center-text' }, 'Holy Nudge · a gentle push for Wildwood College'),
      wildwoodLogo()
    );
  }

  function tabBar() {
    var a = S.me.admin;
    var tabs = [
      { id: 'mine', label: 'Mine', n: S.me.behind.length },
      { id: 'unassigned', label: 'Unassigned', n: a.unassigned.length },
      { id: 'behind', label: 'Behind', n: null },
      { id: 'team', label: 'Team', n: teamBadge() },
    ];
    return h(
      'div',
      { class: 'tabs', role: 'tablist' },
      tabs.map(function (t) {
        return h(
          'button',
          {
            class: 'tab',
            type: 'button',
            role: 'tab',
            'aria-selected': S.tab === t.id ? 'true' : 'false',
            onclick: function () {
              S.tab = t.id;
              render();
            },
          },
          t.label,
          t.n ? h('span', { class: 'count' }, '(' + t.n + ')') : null
        );
      })
    );
  }

  function revealSelectedTab() {
    var bar = root.querySelector('.tabs');
    var sel = root.querySelector('.tab[aria-selected="true"]');
    if (bar && sel) bar.scrollLeft = sel.offsetLeft - (bar.clientWidth - sel.offsetWidth) / 2;
  }

  function notificationsBanner() {
    if (S.env.subscribed) return null;
    if (S.env.ios && !S.env.standalone && S.me.leader.notificationsOn) return null;
    return h(
      'div',
      { class: 'panel notice gap-bottom' },
      h('p', {}, 'Notifications are off on this device, so we can’t nudge you in the morning.'),
      h('button', { class: 'btn primary', type: 'button', onclick: function () { S.skipped = false; session('del', SKIP_KEY); S.view = 'onboarding'; render(); } }, 'Turn them on')
    );
  }

  function mineView() {
    var behind = S.me.behind;
    var n = behind.length;
    var head = h('div', { class: 'hello' }, h('h1', {}, greeting()), h('p', { class: 'lead' }, n === 0 ? 'Nothing is waiting on you today.' : n + ' ' + plural(n, 'student', 'students') + ' would love to hear from you.'));
    var banner = notificationsBanner();
    if (n === 0) {
      return h('div', {}, head, banner, emptyState('You’re all caught up', 'Nobody is waiting on you right now. Thank you for caring for these students so well.'));
    }
    return h('div', {}, head, banner, h('ul', { class: 'list' }, behind.map(function (i) { return personCard(i); })));
  }

  function unassignedView() {
    var items = S.me.admin.unassigned;
    var head = h('div', { class: 'hello' }, h('h2', {}, 'Waiting for a leader'), h('p', { class: 'muted' }, 'These students are in a queue with nobody looking after them yet, longest wait first.'));
    if (!items.length) return h('div', {}, head, emptyState('Everyone has a leader', 'Nobody is waiting for a leader right now. Nice work.'));
    return h('div', {}, head, h('ul', { class: 'list' }, items.map(function (i) { return personCard(i, { waiting: true }); })));
  }

  function behindView() {
    var groups = S.me.admin.byLeader.slice().sort(function (a, b) {
      if (!a.leader && b.leader) return 1; // unassigned group last
      if (a.leader && !b.leader) return -1;
      return 0;
    });
    var head = h('div', { class: 'hello' }, h('h2', {}, 'Everyone who’s behind'), h('p', { class: 'muted' }, 'Grouped by leader, so you know who to cheer on.'));
    if (!groups.length) return h('div', {}, head, emptyState('Nobody is behind', 'Every queue is on track. Lovely.'));
    return h(
      'div',
      {},
      head,
      h(
        'div',
        { class: 'list' },
        groups.map(function (g) {
          var name = g.leader ? g.leader.name : 'No leader yet';
          return h(
            'details',
            { class: 'group', open: groups.length <= 3 },
            h('summary', {}, h('span', { class: 'group-title' }, h('span', {}, name), h('span', { class: 'chip accent' }, g.items.length + ' ' + plural(g.items.length, 'student', 'students')), g.leader && g.notificationsOn === false ? h('span', { class: 'chip' }, 'notifications off') : null)),
            h('ul', { class: 'list' }, g.items.map(function (i) { return personCard(i); }))
          );
        })
      )
    );
  }

  /* People who have a working link but have not turned on notifications: the ones worth a friendly reminder. */
  function teamNotificationsOff(leaders) {
    return leaders.filter(function (l) { return l.hasLink && !l.notificationsOn; });
  }

  /* The Team tab's count: staff count people with a link and no notifications; coordinators (no
     leader list) keep the server's list of leaders in their queues without notifications. */
  function teamBadge() {
    var a = S.me.admin;
    return Array.isArray(a.leaders) ? teamNotificationsOff(a.leaders).length : a.leadersWithoutNotifications.length;
  }

  /* People with a working link who aren't tied to a Lead person, so once live they'd see no students. */
  function teamUnmatched(leaders) {
    return leaders.filter(function (l) { return l.hasLink && l.matched === false; });
  }

  function teamSummary(leaders) {
    var linked = leaders.filter(function (l) { return l.hasLink; }).length;
    var off = teamNotificationsOff(leaders).length;
    if (!linked) return 'Nobody has a link yet. Add someone, or make a link on their row.';
    var text = !off
      ? 'Everyone with a link has notifications on.'
      : off + ' of ' + linked + ' ' + plural(linked, 'person', 'people') + ' with a link ' + plural(off, 'hasn’t', 'haven’t') + ' turned on notifications yet.';
    var unmatched = teamUnmatched(leaders).length;
    if (unmatched) text += ' ' + unmatched + ' ' + plural(unmatched, 'person isn’t', 'people aren’t') + ' matched to Lead yet.';
    return text;
  }

  function teamView() {
    var a = S.me.admin;
    if (Array.isArray(a.leaders)) return leadersSection(a.leaders); // link management is for staff only

    // Coordinators (not staff): a simple list, no link controls.
    var off = a.leadersWithoutNotifications;
    return h(
      'section',
      { class: 'section' },
      h('h2', {}, 'Haven’t turned on notifications'),
      off.length ? h('p', { class: 'muted' }, 'A friendly reminder to these folks will help.') : null,
      off.length
        ? h('ul', { class: 'list' }, off.map(function (l) { return h('li', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'name' }, l.name))); }))
        : emptyState('Everyone is set up', 'All your leaders have notifications on.')
    );
  }

  function leadersSection(leaders) {
    return h(
      'section',
      { class: 'section' },
      h('h2', {}, 'Team'),
      h('p', { class: 'muted', id: 'team-summary' }, teamSummary(leaders)),
      h('p', { class: 'muted small' }, 'Each link is personal and works like a password. A new link is shown just once, so send it straight away. Making a new one turns the old one off.'),
      addLeaderPanel(leaders),
      leaders.length
        ? h('ul', { class: 'list' }, leaders.map(leaderRow))
        : h('p', { class: 'muted' }, 'No leaders yet. They appear after the first morning run.')
    );
  }

  function addErrorWords(e, name) {
    var code = e instanceof ApiError ? e.code : '';
    if (code === 'name_taken') return name + ' is already on the list. Use New link on their row.';
    if (code === 'name_required') return 'Type their name first.';
    if (code === 'name_too_short') return 'That’s a bit short. Please use at least 2 characters.';
    if (code === 'name_too_long') return 'That’s a long name. Please keep it under 60 characters.';
    if (code === 'invalid_role') return 'Please choose Servant leader or Staff.';
    if (code === 'invalid_name') return 'That name has a character we can’t use. Please type it again.';
    if (e instanceof ApiError && (e.status === 429 || e.status === 403)) return linkErrorWords(e);
    return 'That didn’t go through. Please check your connection and try again.';
  }

  /* Staff add someone who isn't in ChMS yet: name in, personal link out (shown once, in the usual panel). */
  function addLeaderPanel(leaders) {
    var statusEl = h('p', { class: 'status-line small', role: 'status' });
    var input = h('input', {
      class: 'text-input',
      id: 'add-leader-name',
      name: 'leader-name',
      type: 'text',
      maxlength: '80',
      autocapitalize: 'words',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'done',
    });
    input.value = S.addName;
    input.addEventListener('input', function () { S.addName = input.value; });
    var btn = h('button', { class: 'btn primary', type: 'submit' }, 'Add and make link');

    function fail(msg) {
      statusEl.className = 'status-line small err';
      statusEl.textContent = msg;
    }

    function roleOption(value, title, help) {
      var radio = h('input', { type: 'radio', name: 'leader-role', value: value, checked: S.addRole === value });
      radio.addEventListener('change', function () { if (radio.checked) S.addRole = value; });
      return h('label', { class: 'role-option' }, radio, h('span', { class: 'role-title' }, title), h('span', { class: 'role-help' }, help));
    }
    var roles = h(
      'fieldset',
      { class: 'role-set' },
      h('legend', { class: 'field-label' }, 'Their role'),
      roleOption('leader', 'Servant leader', 'Sees only the students assigned to them.'),
      roleOption('staff', 'Staff', 'Sees every queue and can add people and manage links.')
    );

    var form = h(
      'form',
      { class: 'add-form', novalidate: true },
      roles,
      h('label', { class: 'field-label', for: 'add-leader-name' }, 'Their name'),
      h('div', { class: 'add-row' }, input, btn),
      statusEl
    );
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = input.value.replace(/\s+/g, ' ').trim();
      var len = Array.from(name).length;
      if (!name) return fail('Type their name first.');
      if (len < 2) return fail('That’s a bit short. Please use at least 2 characters.');
      if (len > 60) return fail('That’s a long name. Please keep it under 60 characters.');
      var role = S.addRole === 'staff' ? 'staff' : 'leader';
      if (role === 'staff' && !window.confirm(name + ' will be able to see every student and manage everyone’s links. Add as staff?')) return;
      btn.disabled = true;
      statusEl.className = 'status-line small';
      statusEl.textContent = 'Adding ' + name + '…';
      api('/api/leader-add', { method: 'POST', body: { name: name, role: role } })
        .then(function (res) {
          var row = { id: res.leader.id, name: res.leader.name, hasLink: true, lastSeenAt: null, notificationsOn: false, isStaff: res.leader.role === 'staff', canManage: true, isYou: false, coordinates: [] };
          S.me.admin.leaders.push(row);
          S.me.admin.leaders.sort(function (a, b) { return a.name.localeCompare(b.name); });
          S.minted[row.id] = res.url;
          S.justAdded = row.id;
          S.addName = '';
          S.addRole = 'leader';
          S.addOpen = false;
          renderInPlace();
        })
        .catch(function (e) {
          if (e instanceof ApiError && e.status === 401) {
            S.view = 'invalid';
            return render();
          }
          btn.disabled = false;
          fail(addErrorWords(e, name));
        });
    });

    var added = S.justAdded === null ? null : leaders.filter(function (l) { return l.id === S.justAdded; })[0];
    var url = added ? S.minted[added.id] : null;

    // Tucked away until asked for: a small button, then the form. A just-made link stays visible until Done.
    if (!S.addOpen) {
      var openBtn = h('button', { class: 'btn small-btn', type: 'button', onclick: function () {
        S.addOpen = true;
        renderInPlace();
        var el = document.getElementById('add-leader-name');
        if (el) el.focus();
      } }, 'Add a leader');
      return h('div', { class: 'add-closed' }, openBtn, added && url ? h('div', { class: 'panel' }, mintedPanel(added, url)) : null);
    }

    var cancelBtn = h('button', { class: 'btn link', type: 'button', onclick: function () {
      S.addOpen = false;
      S.addName = '';
      S.addRole = 'leader';
      renderInPlace();
    } }, 'Cancel');
    form.querySelector('.add-row').appendChild(cancelBtn);
    return h(
      'div',
      { class: 'panel' },
      h('h3', {}, 'Add a leader'),
      h('p', { class: 'muted small' }, 'For someone who isn’t in ChMS yet. We’ll make them a personal link. Send it to them: they open it on their phone and follow the steps.'),
      form
    );
  }

  function lastSeenWords(iso) {
    var t = iso ? Date.parse(iso) : NaN;
    if (isNaN(t)) return 'Hasn’t opened Holy Nudge yet';
    var hours = (Date.now() - t) / 3600000;
    if (hours < 1) return 'Opened Holy Nudge in the last hour';
    if (hours < 24) return 'Last opened ' + Math.floor(hours) + ' ' + plural(Math.floor(hours), 'hour', 'hours') + ' ago';
    var days = Math.floor(hours / 24);
    return 'Last opened ' + days + ' ' + plural(days, 'day', 'days') + ' ago';
  }

  function linkErrorWords(e) {
    var code = e instanceof ApiError ? e.code : '';
    if (code === 'owner_protected') return 'Only the owner can change the owner’s link.';
    if (code === 'forbidden') return 'Only staff can change links.';
    if (code === 'cannot_revoke_self') return 'You can’t turn off your own link here, but you can make yourself a new one.';
    if (code === 'rate_limited') return 'That’s a lot of link changes. Give it a few minutes and try again.';
    if (code === 'not_found') return 'We couldn’t find that leader. Try Refresh.';
    return 'That didn’t go through. Please try again in a moment.';
  }

  /* Re-render without jumping back to the top of the page. */
  function renderInPlace() {
    var y = window.scrollY;
    render();
    window.scrollTo(0, y);
  }

  /* Staff made themselves a new link: use it from now on so this device is not locked out. */
  function adoptOwnNewLink(url) {
    var m;
    try {
      m = new URL(url).pathname.match(/^\/l\/([^/]+)$/);
    } catch (_) {
      m = null;
    }
    if (!m || mock) return;
    token = decodeURIComponent(m[1]);
    pathToken = token;
    rememberToken(token);
    try {
      history.replaceState(null, '', '/l/' + encodeURIComponent(token));
    } catch (_) {
      /* ignore */
    }
  }

  function mintLink(l, btn, statusEl) {
    var msg = l.isYou
      ? 'This replaces your own link. This device switches to the new one; anywhere else you use Holy Nudge will need the new link.'
      : l.hasLink
        ? 'This replaces ' + l.name + '’s current link. Their old link stops working right away.'
        : 'Make a personal link for ' + l.name + '?';
    if (!window.confirm(msg)) return;
    btn.disabled = true;
    statusEl.className = 'status-line small';
    statusEl.textContent = 'Making a new link…';
    return api('/api/leader-link', { method: 'POST', body: { leaderId: l.id } })
      .then(function (res) {
        if (res.self) adoptOwnNewLink(res.url);
        S.minted[l.id] = res.url;
        l.hasLink = true;
        renderInPlace();
      })
      .catch(function (e) {
        if (e instanceof ApiError && e.status === 401) {
          S.view = 'invalid';
          return render();
        }
        btn.disabled = false;
        statusEl.className = 'status-line small err';
        statusEl.textContent = linkErrorWords(e);
      });
  }

  function revokeLink(l, btn, statusEl) {
    if (!window.confirm('Turn off ' + l.name + '’s link? It stops working right away and their notifications stop. You can make them a new link any time.')) return;
    btn.disabled = true;
    statusEl.className = 'status-line small';
    statusEl.textContent = 'Turning it off…';
    return api('/api/leader-revoke', { method: 'POST', body: { leaderId: l.id } })
      .then(function () {
        delete S.minted[l.id];
        l.hasLink = false;
        l.notificationsOn = false;
        renderInPlace();
      })
      .catch(function (e) {
        if (e instanceof ApiError && e.status === 401) {
          S.view = 'invalid';
          return render();
        }
        btn.disabled = false;
        statusEl.className = 'status-line small err';
        statusEl.textContent = linkErrorWords(e);
      });
  }

  function mintedPanel(l, url) {
    var label = h('span', {}, 'Copy');
    return h(
      'div',
      { class: 'panel notice minted' },
      h('p', { class: 'small' }, l.isYou
        ? 'Here’s your new link. This device already uses it. It’s shown only this once.'
        : 'Here’s ' + firstName(l.name) + '’s new link. It’s shown only this once, so copy or email it now.'),
      h('p', { class: 'link-text' }, url),
      h(
        'div',
        { class: 'btns' },
        h('button', { class: 'btn small-btn', type: 'button', 'aria-label': 'Copy the new link for ' + l.name, onclick: function () {
          copyText(url).then(function (ok) {
            label.textContent = ok ? 'Copied' : 'Hold to copy';
            setTimeout(function () { label.textContent = 'Copy'; }, 2000);
          });
        } }, label),
        h('a', { class: 'btn small-btn primary', href: mailtoFor({ name: l.name, url: url }), 'aria-label': 'Email the new link to ' + l.name }, 'Email'),
        h('button', { class: 'btn small-btn link', type: 'button', onclick: function () { delete S.minted[l.id]; if (S.justAdded === l.id) S.justAdded = null; renderInPlace(); } }, 'Done')
      )
    );
  }

  /* ---- matching a leader to their Lead (ChMS) person (staff) ---- */

  function openMatch(l) {
    S.matchOpen = l.id;
    S.matchChoice = '';
    S.matchQuery = null;
    delete S.matchNote[l.id];
    renderInPlace();
    // On a phone, keep the keyboard down so the suggestions stay in view; elsewhere start in the search box.
    var touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    var el = document.getElementById((touch ? 'match-panel-' : 'match-search-') + l.id);
    if (el) el.focus();
  }

  function closeMatch() {
    S.matchOpen = null;
    S.matchChoice = '';
    S.matchQuery = null;
    renderInPlace();
  }

  function matchErrorWords(e) {
    var code = e instanceof ApiError ? e.code : '';
    if (code === 'person_taken') return 'Someone else is already matched to that person. Try Refresh.';
    if (code === 'unknown_person') return 'We couldn’t find that person in Lead any more. Try Refresh.';
    if (code === 'no_link') return 'Make them a link first, then match them.';
    if (code === 'invalid_person') return 'Choose who they are in Lead first.';
    if (code === 'owner_protected') return 'Only the owner can change the owner’s match.';
    if (code === 'forbidden') return 'Only staff can match leaders.';
    return linkErrorWords(e);
  }

  /* After a change, refresh quietly from the server without jumping back to the top. */
  function refreshInPlace() {
    var y = window.scrollY;
    return load(true).then(function () { window.scrollTo(0, y); });
  }

  function sendMatch(l, chmsId, personName, btn, statusEl) {
    btn.disabled = true;
    statusEl.className = 'status-line small';
    statusEl.textContent = chmsId === null ? 'Clearing…' : 'Matching…';
    api('/api/leader-match', { method: 'POST', body: { leaderId: l.id, chmsId: chmsId } })
      .then(function (res) {
        l.matched = !!res.matched;
        if (chmsId !== null && Array.isArray(S.me.admin.leadPeople)) {
          S.me.admin.leadPeople = S.me.admin.leadPeople.filter(function (p) { return p.id !== chmsId; });
        }
        S.matchNote[l.id] = chmsId === null ? 'Match cleared. Their link still works.' : 'Matched to ' + personName + ' in Lead.';
        S.matchOpen = null;
        S.matchChoice = '';
        S.matchQuery = null;
        renderInPlace();
        refreshInPlace();
      })
      .catch(function (e) {
        if (e instanceof ApiError && e.status === 401) {
          S.view = 'invalid';
          return render();
        }
        btn.disabled = false;
        statusEl.className = 'status-line small err';
        statusEl.textContent = matchErrorWords(e);
      });
  }

  /* The chooser: pick who this leader is in Lead, then confirm. Clear sits here too.
     Up to 3 suggestions by name (public/name-match.js) sit at the top; one clear front-runner is tagged
     "Likely match", but nothing is ever preselected. Below, everyone else, filtered as staff type. */
  function matchPanel(l) {
    var people = Array.isArray(S.me.admin.leadPeople) ? S.me.admin.leadPeople : [];
    var NM = window.NameMatch;
    var statusEl = h('p', { class: 'status-line small', role: 'status' });
    var cancelBtn = h('button', { class: 'btn small-btn link', type: 'button', onclick: closeMatch }, 'Cancel');
    var clearBtn = null;
    if (l.matched) {
      clearBtn = h('button', { class: 'btn small-btn link', type: 'button' }, 'Clear match');
      clearBtn.addEventListener('click', function () {
        if (!window.confirm('Clear ' + l.name + '’s Lead match? Their link keeps working, but once real data is connected they won’t see any students until they’re matched again.')) return;
        sendMatch(l, null, '', clearBtn, statusEl);
      });
    }
    var head = h('p', { class: 'small' }, l.matched ? 'Match ' + firstName(l.name) + ' to someone else in Lead, or clear the match.' : 'Who is ' + l.name + ' in Lead? Once real data is connected, they’ll see the students assigned to that person.');
    var panelProps = { class: 'match-panel', id: 'match-panel-' + l.id, tabindex: '-1' };

    if (!people.length || !NM) {
      return h(
        'div',
        panelProps,
        head,
        h('p', { class: 'muted small' }, !NM ? 'The list of people didn’t load. Reload the page and try again.' : S.me.live === false ? 'Matching to Lead opens once real data is connected.' : 'Nobody in Lead is free to match right now. People show up here once they have a student assigned or manage a queue.'),
        h('div', { class: 'btns' }, clearBtn, cancelBtn),
        statusEl
      );
    }

    if (!people.some(function (p) { return p.id === S.matchChoice; })) S.matchChoice = '';

    var ranked = NM.rankPeople(l.name, people); // best first, ties by name
    var suggested = ranked.filter(function (p) { return p.score >= NM.SUGGEST_MIN; }).slice(0, 3);
    var others = ranked.filter(function (p) { return suggested.indexOf(p) === -1; }); // each person shows once

    if (S.matchQuery === null) {
      // Start on the leader's first name, unless that would open on an empty list: then show everyone.
      var first = String(l.name || '').trim().split(/\s+/)[0] || '';
      S.matchQuery = others.some(function (p) { return NM.matchQuery(first, p.name) > 0; }) ? first : '';
    }
    var radioName = 'lead-person-' + l.id;
    var saveBtn = h('button', { class: 'btn small-btn primary', type: 'submit' }, l.matched ? 'Change match' : 'Match');
    var chosenEl = h('p', { class: 'small chosen-line', 'aria-live': 'polite' });

    function showChoice() {
      var chosen = people.filter(function (p) { return p.id === S.matchChoice; })[0];
      saveBtn.disabled = !chosen;
      chosenEl.textContent = chosen ? 'Chosen: ' + chosen.name : '';
    }

    function personRow(p) {
      var radio = h('input', { type: 'radio', name: radioName, value: p.id, checked: S.matchChoice === p.id });
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        S.matchChoice = p.id;
        statusEl.className = 'status-line small';
        statusEl.textContent = '';
        showChoice();
      });
      return h(
        'label',
        { class: 'person-option' },
        radio,
        h('span', { class: 'person-name' }, p.name),
        p.likely ? h('span', { class: 'likely-tag' }, 'Likely match') : null
      );
    }

    var suggestBox = suggested.length
      ? h(
          'fieldset',
          { class: 'person-set' },
          h('legend', { class: 'field-label' }, 'Suggested'),
          h('div', { class: 'person-list' }, suggested.map(personRow))
        )
      : null;

    var searchId = 'match-search-' + l.id;
    var listId = 'match-results-' + l.id;
    var search = h('input', {
      class: 'text-input',
      id: searchId,
      name: 'lead-search',
      type: 'search',
      maxlength: '80',
      autocapitalize: 'words',
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
      enterkeyhint: 'search',
      'aria-controls': listId,
    });
    search.value = S.matchQuery;
    var countEl = h('p', { class: 'muted small', role: 'status' });
    var listEl = h('div', { class: 'person-list scroll', id: listId });

    // Typing refills only the list below, so the search box keeps focus and the caret.
    function fillResults() {
      var q = S.matchQuery;
      var hits = [];
      others.forEach(function (p) {
        var fit = NM.matchQuery(q, p.name);
        if (fit > 0) hits.push({ p: p, fit: fit });
      });
      hits.sort(function (a, b) { return b.fit - a.fit; }); // stable: equal fits keep the best-guess order
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      var typed = /\S/.test(q);
      if (hits.length) {
        countEl.textContent = typed
          ? hits.length + ' ' + plural(hits.length, 'match', 'matches')
          : (suggested.length ? 'Everyone else in Lead (' : 'Everyone in Lead (') + hits.length + ')';
        append(listEl, hits.map(function (x) { return personRow(x.p); }));
        return;
      }
      countEl.textContent = '';
      if (!typed) {
        append(listEl, h('p', { class: 'muted small empty-line' }, 'No one else in Lead right now.'));
        return;
      }
      var inSuggested = suggested.some(function (p) { return NM.matchQuery(q, p.name) > 0; });
      var clearSearch = h('button', { class: 'btn small-btn link', type: 'button', onclick: function () {
        search.value = '';
        S.matchQuery = '';
        fillResults();
        search.focus();
      } }, 'Clear search');
      append(
        listEl,
        h(
          'div',
          { class: 'empty-line' },
          h('p', { class: 'muted small' }, inSuggested ? 'No one else by that name in Lead. Clear the search to see everyone.' : 'No one by that name in Lead. Clear the search to see everyone.'),
          clearSearch
        )
      );
    }

    search.addEventListener('input', function () {
      S.matchQuery = search.value;
      fillResults();
    });
    search.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') ev.preventDefault(); // Enter here never confirms a match
    });

    var form = h(
      'form',
      { class: 'match-form', novalidate: true },
      suggestBox,
      h('label', { class: 'field-label', for: searchId }, 'Search people in Lead'),
      search,
      h(
        'fieldset',
        { class: 'person-set' },
        h('legend', { class: 'sr-only' }, suggested.length ? 'Everyone else in Lead' : 'People in Lead'),
        countEl,
        listEl
      ),
      chosenEl,
      h('div', { class: 'btns' }, saveBtn, clearBtn, cancelBtn),
      statusEl
    );
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var chosen = people.filter(function (p) { return p.id === S.matchChoice; })[0];
      if (!chosen) {
        statusEl.className = 'status-line small err';
        statusEl.textContent = 'Choose who they are in Lead first.';
        return;
      }
      if (!window.confirm('Match ' + l.name + ' to ' + chosen.name + ' in Lead? They’ll see the students assigned to ' + chosen.name + '.')) return;
      sendMatch(l, chosen.id, chosen.name, saveBtn, statusEl);
    });
    fillResults();
    showChoice();
    return h('div', panelProps, head, form);
  }

  function leaderRow(l) {
    var statusEl = h('p', { class: 'status-line small', role: 'status' });
    if (S.matchNote[l.id]) {
      statusEl.className = 'status-line small ok';
      statusEl.textContent = S.matchNote[l.id];
    }
    var minted = l.id === S.justAdded ? null : S.minted[l.id]; // the just-added person's link shows under the add form
    var choosing = S.matchOpen === l.id && l.canManage && l.hasLink;
    // Link actions live in a small menu by the bell; the match icon after the name opens the Lead chooser.
    var actions = [];
    if (l.canManage) {
      actions.push({ label: l.hasLink ? 'New link' : 'Make a link', run: function (trigger) { return mintLink(l, trigger, statusEl); } });
      if (l.hasLink && !l.isYou) actions.push({ label: 'Turn off link', run: function (trigger) { return revokeLink(l, trigger, statusEl); } });
    }
    var seen = lastSeenWords(l.lastSeenAt) + (l.canManage ? '' : ' · Only the owner can change this link.');
    return h(
      'li',
      { class: 'card leader-card' },
      h(
        'div',
        { class: 'row person' },
        h('span', { class: 'name' }, l.name, l.isYou ? h('span', { class: 'you' }, ' (you)') : null, matchIcon(l)),
        h(
          'span',
          { class: 'person-end' },
          h('span', { class: 'bell' + (l.notificationsOn ? '' : ' off'), role: 'img', 'aria-label': l.notificationsOn ? 'Notifications on' : 'Notifications off', title: l.notificationsOn ? 'Notifications on' : 'Notifications off' }),
          actions.length ? moreMenu(l, actions) : null
        )
      ),
      l.isStaff || !l.hasLink
        ? h(
            'div',
            { class: 'meta' },
            l.isStaff ? h('span', { class: 'chip staff' }, 'Staff') : null,
            l.hasLink ? null : h('span', { class: 'chip' }, 'no working link')
          )
        : null,
      coordinatesLine(l),
      h('p', { class: 'muted small' }, seen),
      minted ? mintedPanel(l, minted) : null,
      choosing ? matchPanel(l) : null,
      statusEl
    );
  }

  /* ---- the per-row link menu (staff): one open at a time; closes on outside tap, Escape, Tab and after a choice ---- */

  var closeOpenMenu = null;

  function moreMenu(l, actions) {
    var menuId = 'link-menu-' + l.id;
    var trigger = h(
      'button',
      { class: 'more-btn', type: 'button', 'aria-label': 'Link options for ' + l.name, 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId, 'data-leader': String(l.id) },
      h('span', { class: 'more-glyph', 'aria-hidden': 'true' })
    );
    var items = actions.map(function (a) {
      return h('button', { class: 'menu-item', type: 'button', role: 'menuitem', tabindex: '-1', onclick: function () { choose(a); } }, a.label);
    });
    var menu = h('div', { class: 'menu', id: menuId, role: 'menu', 'aria-label': 'Link options for ' + l.name, hidden: true }, items);
    var wrap = h('span', { class: 'more' }, trigger, menu);

    function onDocPointer(ev) {
      if (!wrap.contains(ev.target)) close(false);
    }
    function onKey(ev) {
      var i = items.indexOf(document.activeElement);
      if (ev.key === 'Escape') {
        ev.preventDefault();
        close(true);
      } else if (ev.key === 'Tab') {
        close(false);
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        var n = items.length;
        items[((i < 0 ? (ev.key === 'ArrowDown' ? -1 : 0) : i) + (ev.key === 'ArrowDown' ? 1 : -1) + n) % n].focus();
      } else if (ev.key === 'Home' || ev.key === 'End') {
        ev.preventDefault();
        items[ev.key === 'Home' ? 0 : items.length - 1].focus();
      }
    }
    function open() {
      if (closeOpenMenu) closeOpenMenu(false);
      menu.hidden = false;
      menu.classList.remove('up');
      trigger.setAttribute('aria-expanded', 'true');
      // Open upwards when there is no room below in the window but there is above; otherwise scroll it into view.
      var r = menu.getBoundingClientRect();
      var t = trigger.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 8 && t.top - r.height - 12 > 0) menu.classList.add('up');
      else if (r.bottom > window.innerHeight - 8 && menu.scrollIntoView) menu.scrollIntoView({ block: 'nearest' });
      document.addEventListener('pointerdown', onDocPointer, true);
      wrap.addEventListener('keydown', onKey);
      closeOpenMenu = close;
      items[0].focus();
    }
    function close(refocus) {
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      document.removeEventListener('pointerdown', onDocPointer, true);
      wrap.removeEventListener('keydown', onKey);
      if (closeOpenMenu === close) closeOpenMenu = null;
      if (refocus) trigger.focus();
    }
    function choose(a) {
      close(true);
      Promise.resolve(a.run(trigger)).then(function () { refocusMenuTrigger(l.id); });
    }
    trigger.addEventListener('click', function () {
      if (menu.hidden) open();
      else close(true);
    });
    trigger.addEventListener('keydown', function (ev) {
      if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && menu.hidden) {
        ev.preventDefault();
        open();
        if (ev.key === 'ArrowUp') items[items.length - 1].focus();
      }
    });
    return wrap;
  }

  /* After an action re-renders the list, put focus back on that row's menu button (if the row is still there). */
  function refocusMenuTrigger(id) {
    var t = document.querySelector('.more-btn[data-leader="' + id + '"]');
    if (t && document.activeElement !== t && (!document.activeElement || document.activeElement === document.body)) t.focus();
  }

  // Staff only (the leader list is): the queues this person coordinates, i.e. sees whole. Read-only, quiet text.
  function coordinatesLine(l) {
    var qs = Array.isArray(l.coordinates) ? l.coordinates : [];
    if (!qs.length) return null;
    return h('p', { class: 'muted small coordinates' }, 'Coordinates ' + listWords(qs));
  }

  function listWords(xs) {
    if (xs.length <= 2) return xs.join(' and ');
    return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  }

  // A small status icon after the name: matched (check in a circle) or not (dashed circle, question mark).
  // Staff who can manage the row get a button that opens the match chooser; everyone else sees the same look, not interactive.
  function matchIcon(l) {
    if (!l.hasLink || typeof l.matched !== 'boolean') return null;
    var ok = l.matched === true;
    var glyph = h('span', { class: 'match-glyph' });
    var joiner = document.createTextNode('\u2060'); // keeps the icon on the same line as the last word
    if (l.canManage) {
      var label = ok ? 'Matched to Lead. Change' : 'Not matched to Lead. Choose a person';
      return [joiner, h('button', { class: 'match-icon' + (ok ? '' : ' none'), type: 'button', 'aria-label': label, title: label, onclick: function () { openMatch(l); } }, glyph)];
    }
    var plain = ok ? 'Matched to Lead' : 'Not matched to Lead';
    return [joiner, h('span', { class: 'match-icon' + (ok ? '' : ' none'), role: 'img', 'aria-label': plain, title: plain }, glyph)];
  }

  function footer() {
    var kids = [];
    if (S.env.subscribed) {
      var statusEl = h('p', { class: 'status-line small', role: 'status' });
      kids.push(testButton(statusEl, 'small-btn'), statusEl);
    }
    kids.push(h('p', { class: 'muted small' }, 'Holy Nudge · a gentle push for Wildwood College'), wildwoodLogo());
    return h('div', { class: 'footer' }, kids);
  }

  /* ---------------------------------------------------------------- boot */

  function start() {
    if (mock) {
      token = 'mock-token';
      if (mock === 'prelaunch-off') S.skipped = true; // preview the "finish setting up" screen directly
    } else {
      pathToken = getPathToken();
      storedToken = store('get', TOKEN_KEY);
      token = pathToken || storedToken;
    }
    setUpServiceWorker();
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && S.me && S.view === 'main' && Date.now() - S.loadedAt > 60000) load(true);
    });
    if (!token) {
      S.view = 'notoken';
      return render();
    }
    load();
  }

  start();
})();
