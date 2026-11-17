// GET /oauth/start?key=<OAUTH_SETUP_KEY>
// Owner-only entry to the Pushpay approval flow: stores a one-time CSRF state and sends the
// browser (the Master Admin's) to Pushpay's authorize page. The redirect URI is a constant.
import {
  authorizeUrl,
  constantTimeEqual,
  htmlPage,
  missingSettings,
  randomToken,
  saveState,
  type OAuthEnvInput,
} from '../../src/chms/oauth';

export const onRequestGet: PagesFunction<OAuthEnvInput> = async ({ request, env }) => {
  const missing = missingSettings(env, ['CHMS_CLIENT_ID', 'CHMS_CLIENT_SECRET', 'OAUTH_SETUP_KEY']);
  if (missing.length > 0 || !env.CHMS_CLIENT_ID || !env.CHMS_CLIENT_SECRET || !env.OAUTH_SETUP_KEY) {
    // Names only, to the log; the page stays plain.
    console.warn(`oauth start: not configured (${missing.join(', ')} missing)`);
    return htmlPage(503, 'Not set up yet', 'Holy Nudge\'s Pushpay credentials are not configured yet. Try again once they are set up.');
  }
  const key = new URL(request.url).searchParams.get('key') ?? '';
  if (!(await constantTimeEqual(key, env.OAUTH_SETUP_KEY))) {
    return htmlPage(403, 'Not allowed', 'This setup link is not valid. Ask the Holy Nudge owner for the current one.');
  }
  const state = randomToken(32);
  await saveState(env.DB, state, Date.now());
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizeUrl({ ...env, CHMS_CLIENT_ID: env.CHMS_CLIENT_ID }, state),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
};
