'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { UserStore } = require('../server/users');
const { createApp } = require('../server/app');

async function setup(t, reports) {
  const users = new UserStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sv-')), 'users.json'));
  users.ensureAdmin({ username: 'admin', password: 'admin123' });
  users.create({ name: 'Marina', username: 'marina', password: 'secret1', role: 'supervisor' });
  const config = { sessionSecret: 'test', sessionTtlHours: 1 };
  const server = createApp({ config, users, reports }).listen(0);
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
    });
    return { status: res.status, cookie: (res.headers.get('set-cookie') || '').split(';')[0], body: await res.json() };
  };
  return { base, login, users };
}

test('supervisor acessa os relatórios, mas não o cadastro de usuários', async (t) => {
  const calls = [];
  const reports = { run: async (type, q) => { calls.push({ type, q }); return { report: type }; } };
  const { base, login } = await setup(t, reports);

  const sup = await login('marina', 'secret1');
  assert.equal(sup.status, 200);
  assert.equal(sup.body.user.role, 'supervisor');
  assert.equal(sup.body.user.passwordHash, undefined);

  const res = await fetch(`${base}/api/reports/overview?from=2026-09-01&to=2026-09-29`, { headers: { Cookie: sup.cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], { type: 'overview', q: { from: '2026-09-01', to: '2026-09-29' } });

  assert.equal((await fetch(`${base}/api/users`, { headers: { Cookie: sup.cookie } })).status, 403);
  assert.equal((await fetch(`${base}/api/reports/overview`)).status, 401);

  const admin = await login('admin', 'admin123');
  assert.equal((await fetch(`${base}/api/users`, { headers: { Cookie: admin.cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/reports/agents`, { headers: { Cookie: admin.cookie } })).status, 200);
});

test('relatórios indisponíveis sem banco de CDR', async (t) => {
  const { base, login } = await setup(t, null);
  const { cookie } = await login('marina', 'secret1');
  const res = await fetch(`${base}/api/reports/overview`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /CDR_DB_HOST/);
});

test('erro do banco vira mensagem legível', async (t) => {
  const reports = { run: async () => { throw Object.assign(new Error('denied'), { code: 'ER_ACCESS_DENIED_ERROR' }); } };
  const { base, login } = await setup(t, reports);
  const { cookie } = await login('marina', 'secret1');
  const res = await fetch(`${base}/api/reports/overview`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /acesso negado/);
});

test('usuário desativado perde o acesso; sempre resta um administrador', async (t) => {
  const { base, login, users } = await setup(t, { run: async () => ({}) });
  const sup = await login('marina', 'secret1');
  const marina = users.list().find((u) => u.username === 'marina');
  users.update(marina.id, { active: false });
  assert.equal((await fetch(`${base}/api/reports/overview`, { headers: { Cookie: sup.cookie } })).status, 401);
  assert.equal((await login('marina', 'secret1')).status, 401);

  const admin = users.list().find((u) => u.role === 'admin');
  assert.throws(() => users.update(admin.id, { role: 'supervisor' }), /administrador/);
  assert.equal(users.get(admin.id).role, 'admin');
  assert.throws(() => users.create({ name: 'X', username: 'xx', password: 'secret1', role: 'user' }), /Perfil/);
});
