// GET /oauth/start?key=<OAUTH_SETUP_KEY>
// Owner-only entry to the Pushpay approval flow: stores a one-time CSRF state and sends the
// browser (the Master Admin's) to Pushpay's authorize page. The redirect URI is a constant.
import { authorizeUrl, constantTimeEqual, htmlPage, randomToken, saveState, type OAuthEnv } from '../../src/chms/oauth';

export const onRequestGet: PagesFunction<OAuthEnv> = async ({ request, env }) => {
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!env.OAUTH_SETUP_KEY || !(await constantTimeEqual(key, env.OAUTH_SETUP_KEY))) {
    return htmlPage(403, 'Not allowed', 'This setup link is not valid. Ask the Holy Nudge owner for the current one.');
  }
  if (!env.CHMS_CLIENT_ID || !env.CHMS_CLIENT_SECRET) {
    return htmlPage(503, 'Not ready yet', 'Holy Nudge does not have its Pushpay credentials yet. Try again once they are set up.');
  }
  const state = randomToken(32);
  await saveState(env.DB, state, Date.now());
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl(env, state),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
};
