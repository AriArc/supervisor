'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// admin: relatórios + cadastro de usuários; supervisor: relatórios
const ROLES = ['admin', 'supervisor'];
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Cadastro de usuários em arquivo JSON. */
class UserStore {
  constructor(file) {
    this.file = file;
    this.users = [];
    this.load();
  }

  load() {
    if (fs.existsSync(this.file)) {
      this.users = JSON.parse(fs.readFileSync(this.file, 'utf8')).users || [];
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  ensureAdmin({ username, password }) {
    if (this.users.length) return null;
    return this.create({ name: 'Administrador', username, password, role: 'admin' });
  }

  list() {
    return this.users.map(publicUser);
  }

  get(id) {
    return this.users.find((u) => u.id === id) || null;
  }

  authenticate(username, password) {
    const u = this.users.find((x) => x.username === String(username || '').toLowerCase());
    if (!u || !u.active || !verifyPassword(String(password || ''), u.passwordHash)) return null;
    return u;
  }

  validate(data, { partial = false, id = null } = {}) {
    const errors = [];
    const has = (k) => data[k] !== undefined;

    if (!partial || has('name')) {
      if (!String(data.name || '').trim()) errors.push('Nome é obrigatório');
    }
    if (!partial || has('username')) {
      const username = String(data.username || '').toLowerCase();
      if (!USERNAME_RE.test(username)) errors.push('Usuário deve ter 3–32 caracteres (letras, números, . _ -)');
      else if (this.users.some((u) => u.username === username && u.id !== id)) errors.push('Usuário já existe');
    }
    if (!partial || (has('password') && data.password)) {
      if (String(data.password || '').length < 6) errors.push('Senha deve ter pelo menos 6 caracteres');
    }
    if (!partial || has('role')) {
      if (!ROLES.includes(data.role)) errors.push('Perfil inválido');
    }
    return errors;
  }

  create(data) {
    const errors = this.validate(data);
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, errors });
    const user = {
      id: crypto.randomUUID(),
      name: String(data.name).trim(),
      username: String(data.username).toLowerCase(),
      passwordHash: hashPassword(String(data.password)),
      role: data.role,
      active: data.active !== false,
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    this.save();
    return publicUser(user);
  }

  update(id, data) {
    const user = this.get(id);
    if (!user) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    const errors = this.validate(data, { partial: true, id });
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, errors });
    const before = { ...user };
    if (data.name !== undefined) user.name = String(data.name).trim();
    if (data.username !== undefined) user.username = String(data.username).toLowerCase();
    if (data.password) user.passwordHash = hashPassword(String(data.password));
    if (data.role !== undefined) user.role = data.role;
    if (data.active !== undefined) user.active = Boolean(data.active);
    if (!this._hasActiveAdmin()) {
      Object.assign(user, before);
      throw Object.assign(new Error('É necessário manter ao menos um administrador ativo'), { status: 400 });
    }
    this.save();
    return publicUser(user);
  }

  remove(id) {
    const idx = this.users.findIndex((u) => u.id === id);
    if (idx === -1) throw Object.assign(new Error('Usuário não encontrado'), { status: 404 });
    const [removed] = this.users.splice(idx, 1);
    if (!this._hasActiveAdmin()) {
      this.users.splice(idx, 0, removed);
      throw Object.assign(new Error('É necessário manter ao menos um administrador ativo'), { status: 400 });
    }
    this.save();
  }

  _hasActiveAdmin() {
    return this.users.some((u) => u.role === 'admin' && u.active);
  }
}

function publicUser(u) {
  const { passwordHash, ...rest } = u;
  return rest;
}

module.exports = { UserStore, ROLES, hashPassword, verifyPassword, publicUser };
