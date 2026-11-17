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
  var mock = isLocal ? query.get('mock') : null; // leader | admin | invalid | empty (localhost only)
  var sim = isLocal ? query.get('sim') : null; // onboarding situation overrides, localhost only
  var fakeEnable = isLocal && query.get('fake') === '1'; // pretend the permission + subscribe step works

  function store(op, key, value) {
    try {
      if (op === 'get') return window.localStorage.getItem(key);
      if (op === 'set') window.localStorage.setItem(key, value);
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

  function getToken() {
    if (mock) return 'mock-token';
    var m = location.pathname.match(/^\/l\/([^/]+)\/?$/);
    if (m) {
      var t;
      try {
        t = decodeURIComponent(m[1]);
      } catch (_) {
        t = m[1];
      }
      store('set', TOKEN_KEY, t);
      return t;
    }
    return store('get', TOKEN_KEY);
  }

  var token = null;

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
      individual: { name: name, phone: phone, email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com' },
    };
    if (!phone) delete item.individual.phone;
    if (extra) Object.keys(extra).forEach(function (k) { item[k] = extra[k]; });
    return item;
  }

  function mockMe() {
    var admin = mock === 'admin';
    var items = [
      mockItem('e1', 'q3', 'Outreach Team', 'NOT_STARTED', '2026-11-10', 7, 'Pat Example', '405-555-0101'),
      mockItem('e2', 'q4', 'Bible Study Hosts & Events Team', 'IN_PROCESS', '2026-11-14', 3, 'Rowan Placeholder', '405-555-0102'),
      mockItem('e3', 'q3', 'Outreach Team', 'NOT_STARTED', '2026-11-25', null, 'Maple Sample-Longname-Hyphenated', null),
    ];
    var me = {
      leader: { name: admin ? 'Quinn Adminson' : 'Sam Fakename', isAdmin: admin, notificationsOn: false },
      behind: mock === 'empty' ? [] : items,
      generatedAt: new Date().toISOString(),
    };
    if (admin) {
      var stale = [
        mockItem('e10', 'q1', 'Connect Card Coordinators', 'NOT_STARTED', '2026-11-02', 15, 'Jules Nobody', '405-555-0110', { hoursWaiting: 360 }),
        mockItem('e11', 'q1', 'Connect Card Coordinators', 'NOT_STARTED', '2026-11-09', 8, 'Indigo Testperson', null, { hoursWaiting: 60 }),
        mockItem('e12', 'q2', 'Staff', 'NOT_STARTED', '2026-11-16', 1, 'Corey Sampleton', '405-555-0112', { hoursWaiting: 26 }),
      ];
      me.admin = {
        staleUnassigned: stale,
        byLeader: [
          { leader: null, notificationsOn: false, items: stale },
          { leader: { name: 'Sam Fakename' }, notificationsOn: true, items: items.slice(0, 2) },
          { leader: { name: 'Devon Mockford' }, notificationsOn: false, items: [mockItem('e20', 'q5', 'Service Team', 'WAITING', '2026-11-12', 5, 'Ash Fictional', '405-555-0120')] },
        ],
        leadersWithoutNotifications: [{ name: 'Devon Mockford' }, { name: 'Lee Madeup' }],
        leaderLinks: [
          { name: 'Sam Fakename', url: 'https://holynudge.cameronbristol.xyz/l/mock-link-sam' },
          { name: 'Devon Mockford', url: 'https://holynudge.cameronbristol.xyz/l/mock-link-devon' },
          { name: 'Lee Madeup', url: 'https://holynudge.cameronbristol.xyz/l/mock-link-lee' },
        ],
      };
    }
    return me;
  }

  function mockApi(path, method) {
    return new Promise(function (resolve, reject) {
      setTimeout(function () {
        if (mock === 'invalid') return reject(new ApiError(401, 'invalid_token'));
        if (path === '/api/me') return resolve(mockMe());
        if (path === '/api/vapid-public-key') return resolve({ key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' });
        if (path === '/api/subscribe' && method === 'POST') return resolve({ ok: true });
        if (path === '/api/test-push' && method === 'POST') return resolve({ ok: true, sent: 1 });
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
    if (mock) return mockApi(path, method);
    var headers = { Authorization: 'Bearer ' + token };
    if (o.body) headers['Content-Type'] = 'application/json';
    return fetch(path, {
      method: method,
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      cache: 'no-store',
    }).then(function (res) {
      if (res.status === 401) throw new ApiError(401, 'invalid_token');
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
    if (!token || !('serviceWorker' in navigator)) return;
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
  };

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
        if (e instanceof ApiError && e.status === 401) {
          S.view = 'invalid';
        } else if (!silent || !S.me) {
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

  function markImg() {
    return h('img', { class: 'mark', src: '/icon-192.png', alt: '', width: '72', height: '72' });
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
      h('p', { class: 'muted small' }, 'Can’t find it? Just ask Cameron and he’ll send it again.')
    );
  }

  function invalidScreen() {
    return h(
      'div',
      { class: 'screen center' },
      markImg(),
      h('h1', {}, 'This link isn’t working any more'),
      h('p', { class: 'lead' }, 'This link is not valid any more. Please ask Cameron for a new one and we’ll get you sorted.')
    );
  }

  function errorScreen() {
    return h(
      'div',
      { class: 'screen center' },
      markImg(),
      h('h1', {}, 'Hmm, we couldn’t load your list'),
      h('p', { class: 'lead' }, 'Check your connection and try again. It’s not you, it’s us.'),
      h('button', { class: 'btn primary', type: 'button', onclick: function () { load(); } }, 'Try again')
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
      'Not now, just show my list'
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
          h('li', {}, h('div', {}, h('strong', {}, 'Open this link in Safari. '), 'It looks like you’re in another browser or inside an app. Tap its menu and choose “Open in Safari”, or copy the link and paste it into Safari.', h('div', { style: 'margin-top:8px' }, copyLinkButton())))
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
          h('p', { class: 'muted' }, 'You can still use this page to see who’s waiting on you. For notifications, try Safari on an iPhone (added to the Home Screen), or Chrome, Edge or Firefox on a computer or Android phone.')
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
      h('div', {}, h('h1', {}, title), env.ios && !env.standalone ? h('p', { class: 'lead', style: 'margin-top:8px' }, 'Just a minute of setup and then you’re done.') : null),
      body,
      skipButton()
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
          S.view = 'success';
          render();
        });
      })
      .catch(function (e) {
        btn.disabled = false;
        if (e instanceof ApiError && e.status === 401) {
          S.view = 'invalid';
          return render();
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
      h('div', {}, h('h1', {}, 'You’re all set'), h('p', { class: 'lead', style: 'margin-top:8px' }, 'Nudges are on. Want to see what one looks like?')),
      test,
      statusEl,
      h('button', { class: 'btn', type: 'button', onclick: function () { S.view = 'main'; render(); } }, 'Show my list')
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
        .catch(function () {
          statusEl.className = 'status-line err';
          statusEl.textContent = 'That didn’t go through. Please try again in a moment.';
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
    var ta = h('textarea', { readonly: true, 'aria-hidden': 'true', style: 'position:fixed;top:0;left:0;opacity:0;font-size:16px' });
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

  function mailtoFor(link) {
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
      kids.push(h('a', { class: 'btn primary', href: item.queueUrl, target: '_blank', rel: 'noopener', 'aria-label': 'Open ' + (ind.name || 'this person') + ' in ChMS' }, 'Open in ChMS'));
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

  function emptyState(big, title, text) {
    return h('div', { class: 'panel empty' }, h('div', { class: 'big-emoji', 'aria-hidden': 'true' }, big), h('h2', {}, title), h('p', { class: 'muted' }, text));
  }

  /* ---------------------------------------------------------------- main view */

  function greeting() {
    var hr = new Date().getHours();
    var part = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
    return part + ', ' + firstName(S.me.leader.name);
  }

  function mainScreen() {
    var me = S.me;
    var parts = [];

    parts.push(
      h(
        'div',
        { class: 'top' },
        h('div', { class: 'brand' }, h('img', { src: '/icon-192.png', alt: '', width: '32', height: '32' }), 'Holy Nudge'),
        h('button', { class: 'btn small-btn', type: 'button', onclick: function () { load(true); } }, 'Refresh')
      )
    );

    if (me.admin) parts.push(tabBar());

    var tab = me.admin ? S.tab : 'mine';
    if (tab === 'mine') parts.push(mineView());
    else if (tab === 'unassigned') parts.push(unassignedView());
    else if (tab === 'behind') parts.push(behindView());
    else parts.push(teamView());

    parts.push(footer());
    return h('div', {}, parts);
  }

  function tabBar() {
    var a = S.me.admin;
    var tabs = [
      { id: 'mine', label: 'Mine', n: S.me.behind.length },
      { id: 'unassigned', label: 'Unassigned', n: a.staleUnassigned.length },
      { id: 'behind', label: 'Behind', n: null },
      { id: 'team', label: 'Team', n: a.leadersWithoutNotifications.length },
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
      { class: 'panel notice', style: 'margin-bottom:16px' },
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
      return h('div', {}, head, banner, emptyState('🎉', 'You’re all caught up', 'Nobody is waiting on you right now. Thank you for caring for these students so well.'));
    }
    return h('div', {}, head, banner, h('ul', { class: 'list' }, behind.map(function (i) { return personCard(i); })));
  }

  function unassignedView() {
    var items = S.me.admin.staleUnassigned;
    var head = h('div', { class: 'hello' }, h('h2', {}, 'Waiting for a leader'), h('p', { class: 'muted' }, 'These students have been in a queue for more than a day with nobody looking after them yet.'));
    if (!items.length) return h('div', {}, head, emptyState('✨', 'Everyone has a leader', 'Nobody has been waiting for more than a day. Nice work.'));
    return h('div', {}, head, h('ul', { class: 'list' }, items.map(function (i) { return personCard(i, { waiting: true }); })));
  }

  function behindView() {
    var groups = S.me.admin.byLeader.slice().sort(function (a, b) {
      if (!a.leader && b.leader) return 1; // unassigned group last
      if (a.leader && !b.leader) return -1;
      return 0;
    });
    var head = h('div', { class: 'hello' }, h('h2', {}, 'Everyone who’s behind'), h('p', { class: 'muted' }, 'Grouped by leader, so you know who to cheer on.'));
    if (!groups.length) return h('div', {}, head, emptyState('🎉', 'Nobody is behind', 'Every queue is on track. Lovely.'));
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

  function teamView() {
    var a = S.me.admin;
    var off = a.leadersWithoutNotifications;

    var offSection = h(
      'section',
      { class: 'section' },
      h('h2', {}, 'Haven’t turned on notifications'),
      off.length ? h('p', { class: 'muted' }, 'A friendly reminder to these folks (their link is below) will help.') : null,
      off.length
        ? h('ul', { class: 'list' }, off.map(function (l) { return h('li', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'name' }, l.name))); }))
        : emptyState('🔔', 'Everyone is set up', 'All your leaders have notifications on.')
    );

    var links = a.leaderLinks || [];
    var linkSection = h(
      'section',
      { class: 'section' },
      h('h2', {}, 'Leader links'),
      h('p', { class: 'muted' }, 'Each link is personal. Send it once; please don’t post it anywhere public.'),
      links.length
        ? h('ul', { class: 'list' }, links.map(linkRow))
        : h('p', { class: 'muted' }, 'No links yet. They appear after the first morning run.')
    );
    return h('div', {}, offSection, linkSection);
  }

  function linkRow(link) {
    var label = h('span', {}, 'Copy');
    return h(
      'li',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'name' }, link.name),
        h(
          'div',
          { class: 'btns' },
          h('button', { class: 'btn small-btn', type: 'button', 'aria-label': 'Copy link for ' + link.name, onclick: function () {
            copyText(link.url).then(function (ok) {
              label.textContent = ok ? 'Copied' : 'Hold to copy';
              setTimeout(function () { label.textContent = 'Copy'; }, 2000);
            });
          } }, label),
          h('a', { class: 'btn small-btn primary', href: mailtoFor(link), 'aria-label': 'Email link to ' + link.name }, 'Email')
        )
      )
    );
  }

  function footer() {
    var kids = [];
    if (S.env.subscribed) {
      var statusEl = h('p', { class: 'status-line small', role: 'status' });
      kids.push(testButton(statusEl, 'small-btn'), statusEl);
    }
    kids.push(h('p', { class: 'muted small' }, 'Holy Nudge · a gentle push for Wildwood college ministry'));
    return h('div', { class: 'footer' }, kids);
  }

  /* ---------------------------------------------------------------- boot */

  function start() {
    token = getToken();
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
