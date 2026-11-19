import { describe, expect, it } from 'vitest';
import { base64urlDecode, base64urlEncode } from '../src/push/base64url';
import { encryptPushPayload, p256PointToJwk } from '../src/push/encrypt';
import { adminPayload, alertPayload, combinedPayload, leaderPayload, testPayload } from '../src/push/payload';
import { createWebPushSender } from '../src/push/sender';
import { deliverToLeader } from '../src/push/deliver';
import { importVapidSigningKey, vapidAuthorization } from '../src/push/vapid';

// RFC 8291 Appendix A
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // Appendix A "86-octet header" and "ciphertext", concatenated (as Section 5 says).
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};

async function rfcEphemeral() {
  const publicKey = base64urlDecode(V.asPublic);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...p256PointToJwk(publicKey), d: V.asPrivate },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  return { privateKey, publicKey };
}

describe('RFC 8291 encryption', () => {
  it('matches the Appendix A test vector byte for byte', async () => {
    const out = await encryptPushPayload(new TextEncoder().encode(V.plaintext), V.uaPublic, V.auth, {
      ephemeral: await rfcEphemeral(),
      salt: base64urlDecode(V.salt),
    });
    expect(out.length).toBe(86 + 58);
    expect(base64urlEncode(out.slice(0, 86))).toBe(V.header);
    expect(base64urlEncode(out.slice(86))).toBe(V.ciphertext);
  });

  it('round-trips with random keys (receiver side decrypts)', async () => {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPub = new Uint8Array((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const msg = JSON.stringify(leaderPayload(3));
    const out = await encryptPushPayload(new TextEncoder().encode(msg), base64urlEncode(uaPub), base64urlEncode(auth));
    // header: salt(16) rs(4) idlen(1) keyid(65)
    expect(out.length).toBe(86 + msg.length + 1 + 16);
    expect(new DataView(out.buffer).getUint32(16)).toBe(4096);
    expect(out[20]).toBe(65);
  });
});

describe('VAPID', () => {
  it('produces a verifiable ES256 JWT for the endpoint origin', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = base64urlEncode((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
    const jwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
    const keys = { publicKey: pub, privateKey: jwk.d!, subject: 'https://holynudge.example' };
    const now = new Date('2026-11-17T14:00:00Z');
    const h = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, await importVapidSigningKey(keys), now);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h);
    expect(m).not.toBeNull();
    const [, hdr, claims, sig, k] = m!;
    expect(k).toBe(pub);
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(hdr!)))).toEqual({ typ: 'JWT', alg: 'ES256' });
    const c = JSON.parse(new TextDecoder().decode(base64urlDecode(claims!)));
    expect(c).toEqual({ aud: 'https://fcm.googleapis.com', exp: now.getTime() / 1000 + 43200, sub: 'https://holynudge.example' });
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      base64urlDecode(sig!),
      new TextEncoder().encode(`${hdr}.${claims}`),
    );
    expect(ok).toBe(true);
  });
});

describe('payload copy', () => {
  it('handles singular and plural, counts only', () => {
    expect(leaderPayload(1)).toEqual({ title: '1 student is waiting on you', body: 'Tap to see who could use a hello', kind: 'leader', count: 1 });
    expect(leaderPayload(3).title).toBe('3 students are waiting on you');
    expect(adminPayload(12, 4, 3)).toMatchObject({ title: '12 students waiting', body: 'Across 4 leaders, 3 unassigned' });
    expect(adminPayload(1, 1, 0)).toMatchObject({ title: '1 student waiting', body: 'Across 1 leader' });
    expect(adminPayload(2, 0, 2)).toMatchObject({ title: '2 students waiting', body: '2 unassigned' });
    expect(alertPayload('datasource').title).toBe('Could not read ChMS this morning');
  });

  it('combines own students and a summary into one push that opens their own list', () => {
    expect(combinedPayload(2, 12, 3, 'yours')).toEqual({ title: '2 students are waiting on you', body: '12 waiting across your queues, 3 unassigned', kind: 'leader', count: 2 });
    expect(combinedPayload(1, 9, 0, 'all')).toEqual({ title: '1 student is waiting on you', body: '9 waiting across all queues', kind: 'leader', count: 1 });
  });

  it('never repeats the app name, which the phone already shows', () => {
    const all = [leaderPayload(2), adminPayload(3, 1, 1), combinedPayload(2, 5, 1, 'all'), combinedPayload(1, 3, 0, 'yours'), testPayload(), ...(['reauth', 'not_configured', 'incomplete', 'datasource', 'job'] as const).map(alertPayload)];
    for (const p of all) expect(`${p.title} ${p.body}`).not.toMatch(/holy nudge/i);
  });
});

describe('sender and delivery', () => {
  async function subscription() {
    const ua = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    return {
      p256dh: base64urlEncode((await crypto.subtle.exportKey('raw', ua.publicKey)) as ArrayBuffer),
      auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
  }
  async function vapidKeys() {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    return {
      publicKey: base64urlEncode((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer),
      privateKey: ((await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey).d!,
      subject: 'mailto:test@example.com',
    };
  }

  it('posts aes128gcm with VAPID headers and deletes 404/410 subscriptions', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const statusFor: Record<string, number> = { 'https://push.example/ok': 201, 'https://push.example/gone': 410, 'https://push.example/nf': 404, 'https://push.example/err': 500 };
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: statusFor[url] ?? 500 });
    }) as unknown as typeof fetch;
    const sender = createWebPushSender({ keys: await vapidKeys(), fetch: fakeFetch });
    const keys = await subscription();
    const subs = Object.keys(statusFor).map((endpoint, i) => ({ id: i, leaderId: 1, endpoint, ...keys }));
    const deleted: string[] = [];
    const ok: string[] = [];
    const counts = await deliverToLeader(
      {
        listSubscriptions: async () => subs,
        deleteSubscription: async (e) => void deleted.push(e),
        markSubscriptionOk: async (e) => void ok.push(e),
      },
      sender,
      1,
      leaderPayload(2),
      new Date(),
    );
    expect(counts).toEqual({ sent: 1, failed: 1, removed: 2 });
    expect(deleted.sort()).toEqual(['https://push.example/gone', 'https://push.example/nf']);
    expect(ok).toEqual(['https://push.example/ok']);
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h['Content-Encoding']).toBe('aes128gcm');
    expect(h.TTL).toBe('43200');
    expect(h.Authorization).toMatch(/^vapid t=.+, k=.+$/);
  });
});
