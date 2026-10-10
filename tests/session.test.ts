import request from 'supertest';
import { createDatabase, type DB } from '../server/db.js';
import { seedDatabase, demoMode } from '../server/seed.js';
import { createApp } from '../server/app.js';
import { cookieSecure, verifyPassword } from '../server/auth.js';

/**
 * How the process behaves when it is not a demo: the cookie flags decide
 * whether a deployment works at all (`Secure` is correct behind https and fatal
 * on the plain-http LAN box in the gym), and the demo switch decides whether it
 * is safe to put in front of strangers.
 */
describe('deployment switches', () => {
  let db: DB;

  beforeAll(() => {
    // The fixture below is the development shape; pin it rather than trust the runner's NODE_ENV.
    process.env.NODE_ENV = 'test';
    delete process.env.DEMO_MODE;
    db = createDatabase(':memory:');
    seedDatabase(db);
  });
  afterAll(() => db.close());

  const touched = ['NODE_ENV', 'COOKIE_SECURE', 'DEMO_MODE', 'OWNER_EMAIL', 'OWNER_PASSWORD', 'OWNER_NAME'];
  const saved: Record<string, string | undefined> = {};
  for (const key of touched) saved[key] = process.env[key];
  afterEach(() => {
    for (const key of touched) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const use = (values: Record<string, string>) => {
    for (const key of touched) delete process.env[key];
    Object.assign(process.env, values);
  };

  const login = () => request(createApp(db))
    .post('/api/auth/login')
    .send({ email: 'owner@krsk.local', password: 'krsk-demo' })
    .expect(200);
  const setCookie = async () => {
    const response = await login();
    const raw = response.headers['set-cookie'] as unknown as string[] | string | undefined;
    return (Array.isArray(raw) ? raw : raw ? [raw] : []).join('; ');
  };

  it('is Secure by default in production and never in development', async () => {
    use({ NODE_ENV: 'production' });
    expect(await setCookie()).toMatch(/krsk_session=[^;]+;.*Secure/);

    use({ NODE_ENV: 'test' });
    expect(await setCookie()).not.toContain('Secure');
  });

  it('lets a plain-http deployment turn Secure off', async () => {
    use({ NODE_ENV: 'production', COOKIE_SECURE: '0' });
    expect(await setCookie()).not.toContain('Secure');
    for (const off of ['false', 'no', 'off']) {
      process.env.COOKIE_SECURE = off;
      expect(cookieSecure()).toBe(false);
    }
    // Any other value keeps the safe behaviour rather than silently disabling it.
    process.env.COOKIE_SECURE = '1';
    expect(await setCookie()).toContain('Secure');
  });

  it('keeps the session usable with Secure off', async () => {
    use({ NODE_ENV: 'production', COOKIE_SECURE: '0' });
    const agent = request.agent(createApp(db));
    await agent.post('/api/auth/login').send({ email: 'owner@krsk.local', password: 'krsk-demo' }).expect(200);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.data.role).toBe('OWNER');
  });

  it('carries demo content only where a demo is wanted', () => {
    use({ NODE_ENV: 'test' });
    expect(demoMode()).toBe(true);
    use({ NODE_ENV: 'test', DEMO_MODE: '0' });
    expect(demoMode()).toBe(false);
    use({ NODE_ENV: 'production' });
    expect(demoMode()).toBe(false);
    use({ NODE_ENV: 'production', DEMO_MODE: '1' });
    expect(demoMode()).toBe(true);
  });

  it('stops publishing the README passwords once the demo is off', async () => {
    await request(createApp(db)).get('/api/demo/accounts').expect(200);

    use({ DEMO_MODE: '0' });
    const blocked = await request(createApp(db)).get('/api/demo/accounts').expect(404);
    expect(blocked.body.error.code).toBe('DEMO_DISABLED');
  });

  it('opens a production database with one owner and no demo crowd', async () => {
    use({ NODE_ENV: 'production', OWNER_EMAIL: 'owner@krsk-jr.jp', OWNER_PASSWORD: 'shuttle-2026', OWNER_NAME: '唐崎 運営' });
    const fresh = createDatabase(':memory:');
    seedDatabase(fresh);
    const users = fresh.prepare('SELECT email, role, display_name FROM users').all() as Array<{ email: string; role: string; display_name: string }>;
    expect(users).toEqual([{ email: 'owner@krsk-jr.jp', role: 'OWNER', display_name: '唐崎 運営' }]);
    expect(fresh.prepare('SELECT COUNT(*) AS count FROM events').get()).toEqual({ count: 0 });

    const signedIn = await request(createApp(fresh)).post('/api/auth/login')
      .send({ email: 'owner@krsk-jr.jp', password: 'shuttle-2026' }).expect(200);
    expect(signedIn.body.data.role).toBe('OWNER');

    // Without a password in the environment, a random one is set rather than reused.
    use({ NODE_ENV: 'production' });
    const random = createDatabase(':memory:');
    seedDatabase(random);
    const stored = random.prepare('SELECT password_hash FROM users').get() as { password_hash: string };
    expect(verifyPassword('krsk-demo', stored.password_hash)).toBe(false);
    random.close();
    fresh.close();
  });
});
