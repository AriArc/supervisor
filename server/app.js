'use strict';

const path = require('path');
const express = require('express');
const { sign, userFromRequest, sessionCookie, COOKIE } = require('./auth');
const { publicUser } = require('./users');
const { describeCdrError } = require('./cdr');

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function createApp({ config, users, reports = null, cdrDb = null }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '32kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  const auth = (req, res, next) => {
    req.user = userFromRequest(req, { secret: config.sessionSecret, users });
    if (!req.user) return next(httpError(401, 'Sessão expirada. Entre novamente.'));
    next();
  };
  const requireRole = (...roles) => (req, res, next) =>
    roles.includes(req.user.role) ? next() : next(httpError(403, 'Acesso negado'));

  // Proteção simples contra força bruta no login
  const attempts = new Map();
  const tooMany = (ip) => {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter((t) => now - t < 5 * 60000);
    attempts.set(ip, list);
    return list.length >= 10;
  };

  app.post('/api/login', (req, res, next) => {
    if (tooMany(req.ip)) return next(httpError(429, 'Muitas tentativas. Aguarde alguns minutos.'));
    const user = users.authenticate(req.body.username, req.body.password);
    if (!user) {
      attempts.get(req.ip).push(Date.now());
      return next(httpError(401, 'Usuário ou senha inválidos'));
    }
    const maxAgeSec = config.sessionTtlHours * 3600;
    const token = sign({ uid: user.id, exp: Date.now() + maxAgeSec * 1000 }, config.sessionSecret);
    res.set('Set-Cookie', sessionCookie(token, { maxAgeSec, secure: req.secure }));
    res.json({ user: publicUser(user) });
  });

  app.post('/api/logout', (req, res) => {
    res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

  // Relatórios de chamadas: supervisores e administradores
  app.get('/api/reports/:type', auth, requireRole('supervisor', 'admin'), async (req, res, next) => {
    try {
      if (!reports) throw httpError(503, 'Relatórios indisponíveis: banco de CDR não configurado (CDR_DB_HOST).');
      res.json(await reports.run(req.params.type, req.query));
    } catch (err) {
      if (!err.status) {
        const reason = describeCdrError(err, cdrDb || {});
        console.error('[cdr]', reason);
        return next(httpError(502, `Não foi possível consultar o CDR: ${reason}.`));
      }
      next(err);
    }
  });

  // Administração de usuários
  app.get('/api/users', auth, requireRole('admin'), (req, res) => res.json({ users: users.list() }));
  app.post('/api/users', auth, requireRole('admin'), (req, res, next) => {
    try {
      res.status(201).json({ user: users.create(req.body) });
    } catch (err) {
      next(err);
    }
  });
  app.put('/api/users/:id', auth, requireRole('admin'), (req, res, next) => {
    try {
      res.json({ user: users.update(req.params.id, req.body) });
    } catch (err) {
      next(err);
    }
  });
  app.delete('/api/users/:id', auth, requireRole('admin'), (req, res, next) => {
    try {
      if (req.params.id === req.user.id) throw httpError(400, 'Você não pode excluir o próprio usuário');
      users.remove(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.use('/api', (req, res, next) => next(httpError(404, 'Rota não encontrada')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Erro interno' });
  });

  return app;
}

module.exports = { createApp };
