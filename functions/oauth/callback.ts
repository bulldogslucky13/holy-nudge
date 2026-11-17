// GET /oauth/callback — the redirect URI registered with Pushpay, exactly
// https://holynudge.cameronbristol.xyz/oauth/callback
// Validates and consumes the CSRF state, exchanges the one-time code, stores the tokens.
// Pages never show error details; logs carry error codes only (no codes, tokens or secrets).
import { consumeState, exchangeCode, htmlPage, OAuthTokenError, type OAuthEnv } from '../../src/chms/oauth';
import { saveAuthorizedTokens } from '../../src/chms/tokens';

const FAILED = 'Holy Nudge could not connect';
const RETRY_HINT = 'Nothing was changed. Ask the Holy Nudge owner for a fresh setup link and try again.';

export const onRequestGet: PagesFunction<OAuthEnv> = async ({ request, env }) => {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length === 0) {
    // Lets anyone confirm the route is live before credentials exist.
    return htmlPage(200, 'Holy Nudge OAuth callback is ready', 'Holy Nudge OAuth callback is ready.');
  }

  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  const now = Date.now();
  const stateOk = state !== '' && (await consumeState(env.DB, state, now));

  if (params.has('error')) {
    // The admin declined, or Pushpay refused the request (e.g. access_denied).
    console.warn(`oauth callback: authorization returned an error (state ${stateOk ? 'valid' : 'invalid'})`);
    return htmlPage(400, FAILED, `The approval was not completed. ${RETRY_HINT}`);
  }
  if (!stateOk) {
    return htmlPage(400, FAILED, `This approval link has expired or was already used. ${RETRY_HINT}`);
  }
  if (code === '') {
    return htmlPage(400, FAILED, `Pushpay did not send an approval code. ${RETRY_HINT}`);
  }

  let tokens;
  try {
    tokens = await exchangeCode(env, code);
  } catch (e) {
    const detail = e instanceof OAuthTokenError ? `${e.code}, HTTP ${e.status || 'n/a'}` : 'unexpected error';
    console.error(`oauth callback: code exchange failed (${detail})`);
    return htmlPage(502, FAILED, `Pushpay did not accept the connection. ${RETRY_HINT}`);
  }

  try {
    await saveAuthorizedTokens(env.DB, tokens, Date.now());
  } catch {
    console.error('oauth callback: tokens were issued but could not be saved');
    return htmlPage(500, FAILED, 'Pushpay approved Holy Nudge, but saving the connection failed. Ask the Holy Nudge owner to try again.');
  }
  console.log('oauth callback: connected');
  return htmlPage(200, 'Holy Nudge is connected', 'Holy Nudge is connected. You can close this tab.');
};
