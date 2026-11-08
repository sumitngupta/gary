import { randomBytes } from 'node:crypto';
import { registerApiRoute } from '@mastra/core/server';
import type { WebUser } from '@chat-adapter/web';
import { serverName } from '../config/branding';
import { garyConfig } from '../config/gary-config';
import { enroll, identify, unlink, webSubject } from './people';
import { webChatPage } from './web-chat-page';

const COOKIE = 'gary_session';
const MAX_AGE_SECONDS = 30 * 86_400;
const FAILED_LOGIN_LIMIT = 10;
const failedLogins: number[] = [];

function sessionToken(request: Request) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=') || undefined;
  }
  return undefined;
}

function cookie(token: string, maxAge: number) {
  const secure = garyConfig().publicUrl?.startsWith('https://') ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

/** Web adapter `getUser`: the session cookie is the browser's channel identity. */
export async function webUserFromRequest(request: Request): Promise<WebUser | null> {
  const token = sessionToken(request);
  if (!token) return null;
  const externalId = webSubject(token);
  const person = await identify({ channel: 'web', externalId });
  return person ? { id: externalId, name: person.displayName } : null;
}

function tooManyFailures(now = Date.now()) {
  while (failedLogins.length && failedLogins[0] < now - 3_600_000) failedLogins.shift();
  return failedLogins.length >= FAILED_LOGIN_LIMIT;
}

export const webChatPageRoute = registerApiRoute('/', {
  method: 'GET',
  requiresAuth: false,
  handler: (c) => c.html(webChatPage({ serverName: serverName(), chatPath: '/api/agents/gary/channels/web/webhook' })),
});

export const webSessionStatusRoute = registerApiRoute('/gary/web/session', {
  method: 'GET',
  requiresAuth: false,
  handler: async (c) => {
    const user = await webUserFromRequest(c.req.raw);
    return user ? c.json({ name: user.name }) : c.json({ error: 'Not signed in' }, 401);
  },
});

export const webSignInRoute = registerApiRoute('/gary/web/session', {
  method: 'POST',
  requiresAuth: false,
  handler: async (c) => {
    if (tooManyFailures()) return c.json({ error: 'Too many failed sign-ins. Try again in an hour.' }, 429);
    const body = await c.req.json().catch(() => ({})) as { secret?: unknown };
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    const token = randomBytes(32).toString('base64url');
    const key = { channel: 'web' as const, externalId: webSubject(token) };
    const outcome = /^GARY-/i.test(secret)
      ? await enroll(key, { kind: 'code', text: secret })
      : await enroll(key, { kind: 'owner-password', password: secret });
    if (outcome.status === 'refused') {
      failedLogins.push(Date.now());
      return c.json({ error: 'That password or invite code did not work.' }, 401);
    }
    c.header('Set-Cookie', cookie(token, MAX_AGE_SECONDS));
    return c.json({ name: outcome.person.displayName, welcome: `You are signed in as ${outcome.person.displayName}. Ask me about anything to watch on ${serverName()}.` });
  },
});

export const webSignOutRoute = registerApiRoute('/gary/web/session', {
  method: 'DELETE',
  requiresAuth: false,
  handler: async (c) => {
    const token = sessionToken(c.req.raw);
    if (token) await unlink({ channel: 'web', externalId: webSubject(token) });
    c.header('Set-Cookie', cookie('', 0));
    return c.json({ ok: true });
  },
});

export const webRoutes = [webChatPageRoute, webSessionStatusRoute, webSignInRoute, webSignOutRoute];
