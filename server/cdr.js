'use strict';

/**
 * Fontes de dados do CDR e serviço de relatórios.
 *
 * - MysqlCdr: lê a tabela `cdr` do banco `asteriskcdrdb` do Issabel.
 * - MockCdr:  gera um CDR fictício e determinístico de uma central (MOCK_CDR=1).
 *
 * Ambas expõem fetch(from, to) -> linhas do CDR (YYYY-MM-DD, inclusive) em ordem cronológica.
 */

const { buildCalls } = require('./calls');
const { REPORTS, filterCalls } = require('./reports');

const COLUMNS = 'calldate, clid, src, dst, dcontext, channel, dstchannel, lastapp, disposition, duration, billsec, uniqueid';

class MysqlCdr {
  constructor(dbConfig, { maxRows = 500000 } = {}) {
    // Carregado sob demanda para não exigir o driver em modo simulado
    const mysql = require('mysql2/promise');
    this.pool = mysql.createPool({
      host: dbConfig.host,
      port: dbConfig.port,
      socketPath: dbConfig.socketPath,
      user: dbConfig.user,
      password: dbConfig.password,
      database: dbConfig.database,
      connectionLimit: 4,
      dateStrings: true,
    });
    if (!/^\w+$/.test(dbConfig.table)) throw new Error('CDR_DB_TABLE inválido');
    this.table = dbConfig.table;
    this.maxRows = maxRows;
    this.dbConfig = { ...dbConfig, password: undefined };
  }

  async fetch(from, to) {
    const sql = `SELECT ${COLUMNS} FROM \`${this.table}\`
      WHERE calldate >= ? AND calldate < DATE_ADD(?, INTERVAL 1 DAY)
      ORDER BY calldate, uniqueid LIMIT ?`;
    const [rows] = await this.pool.query(sql, [`${from} 00:00:00`, to, this.maxRows + 1]);
    if (rows.length > this.maxRows) {
      throw Object.assign(new Error('Período com ligações demais para um único relatório. Escolha um período menor.'), { status: 413 });
    }
    return rows;
  }
}

/** CDR fictício de uma central com 2 filas e 12 ramais, gerado por dia (determinístico). */
class MockCdr {
  constructor() {
    this.agents = [
      ['1001', 'Ana Paula'], ['1002', 'Bruno Lima'], ['1003', 'Carla Souza'], ['1004', 'Diego Alves'],
      ['1005', 'Elaine Rocha'], ['1006', 'Fábio Nunes'], ['1007', 'Gabriela Reis'], ['1008', 'Henrique Dias'],
      ['1009', 'Isabela Martins'], ['1010', 'João Pedro'], ['1011', 'Karina Lopes'], ['1012', 'Recepção'],
    ];
    this.queues = { 600: ['1001', '1002', '1003', '1004', '1005', '1006'], 601: ['1007', '1008', '1009', '1010'] };
    this.names = ['Mercado Bom Preço', 'Clínica Vida', 'Auto Peças Silva', 'Construtora Horizonte', 'Padaria Real', 'Escritório Moura'];
    this.cache = new Map();
  }

  _day(date) {
    if (this.cache.has(date)) return this.cache.get(date);
    let seed = 7;
    for (const ch of date) seed = (seed * 31 + ch.charCodeAt(0)) % 2147483647;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 5; i++) rand();
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const pad = (n) => String(n).padStart(2, '0');
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const volume = weekday === 0 ? 6 : weekday === 6 ? 70 : 240 + Math.floor(rand() * 80);
    // Curva de chegada: picos às 10h e às 14h–15h
    const weights = [0, 0, 0, 0, 0, 0, 0, 1, 6, 11, 14, 12, 7, 8, 13, 12, 10, 7, 3, 1, 0.5, 0.3, 0, 0];
    const wsum = weights.reduce((a, b) => a + b, 0);
    const time = () => {
      let x = rand() * wsum;
      let h = 0;
      while (x > weights[h]) x -= weights[h++];
      return h * 3600 + Math.floor(rand() * 3600);
    };
    const stamp = (sec) => `${date} ${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
    const client = () => {
      const n = Math.floor(rand() * 4000);
      return n % 3 ? `119${80000000 + n * 1777}` : `1133${100000 + n * 97}`;
    };
    const hex = () => Math.floor(rand() * 0xffffffff).toString(16).padStart(8, '0');
    const agentName = (ext) => (this.agents.find((a) => a[0] === ext) || [])[1] || ext;
    const rows = [];
    const missedToday = [];
    let seq = 0;
    const uid = (sec) => `${Date.parse(`${date}T00:00:00Z`) / 1000 + sec}.${seq++}`;

    for (let i = 0; i < volume; i++) {
      const t = time();
      const src = client();
      const clid = rand() < 0.3 ? `"${pick(this.names)}" <${src}>` : `"${src}" <${src}>`;
      const trunk = `PJSIP/operadora-${hex()}`;
      const id = uid(t);
      if (rand() < 0.8) {
        // Entrada pela fila
        const queue = rand() < 0.65 ? '600' : '601';
        const busyHour = [10, 14, 15].includes(Math.floor(t / 3600));
        const answered = rand() > (busyHour ? 0.2 : 0.08);
        const wait = Math.floor(3 + rand() ** 2 * (busyHour ? 120 : 45));
        const base = { calldate: stamp(t), clid, src, dst: queue, dcontext: 'ext-queues', channel: trunk, lastapp: 'Queue', uniqueid: id };
        if (answered) {
          const agent = pick(this.queues[queue]);
          const talk = Math.floor(40 + rand() * 420);
          rows.push({ ...base, dstchannel: `Local/${agent}@from-queue-${hex()};1`, disposition: 'ANSWERED', duration: wait + talk, billsec: talk });
          rows.push({ calldate: stamp(t + wait - 2), clid, src, dst: agent, dcontext: 'from-queue', channel: `Local/${agent}@from-queue-${hex()};2`, dstchannel: `PJSIP/${agent}-${hex()}`, lastapp: 'Dial', disposition: 'ANSWERED', duration: talk + 2, billsec: talk, uniqueid: `${id}9` });
        } else {
          rows.push({ ...base, dstchannel: '', disposition: 'NO ANSWER', duration: wait, billsec: 0 });
          missedToday.push({ t, src });
        }
      } else {
        // Ligação direta para um ramal (DDR)
        const agent = pick(this.agents)[0];
        const answered = rand() > 0.25;
        const ring = Math.floor(4 + rand() * 20);
        const talk = answered ? Math.floor(20 + rand() * 300) : 0;
        rows.push({ calldate: stamp(t), clid, src, dst: agent, dcontext: 'from-did-direct', channel: trunk, dstchannel: `PJSIP/${agent}-${hex()}`, lastapp: 'Dial', disposition: answered ? 'ANSWERED' : 'NO ANSWER', duration: ring + talk, billsec: talk, uniqueid: id });
        if (!answered) missedToday.push({ t, src });
      }
    }

    // Ligações realizadas: parte delas retorna perdidas do dia
    const outCount = Math.floor(volume * 0.45);
    for (let i = 0; i < outCount; i++) {
      const [ext] = pick(this.agents.slice(0, 11));
      let t = time();
      let dst = client();
      if (missedToday.length && rand() < 0.35) {
        const m = missedToday.splice(Math.floor(rand() * missedToday.length), 1)[0];
        t = Math.min(m.t + Math.floor(120 + rand() * 5400), 86399);
        dst = m.src;
      }
      const r = rand();
      const disposition = r < 0.68 ? 'ANSWERED' : r < 0.9 ? 'NO ANSWER' : r < 0.97 ? 'BUSY' : 'FAILED';
      const talk = disposition === 'ANSWERED' ? Math.floor(15 + rand() * 360) : 0;
      rows.push({ calldate: stamp(t), clid: `"${agentName(ext)}" <${ext}>`, src: ext, dst, dcontext: 'from-internal', channel: `PJSIP/${ext}-${hex()}`, dstchannel: `PJSIP/operadora-${hex()}`, lastapp: 'Dial', disposition, duration: talk + Math.floor(5 + rand() * 20), billsec: talk, uniqueid: uid(t) });
    }

    // Ligações internas
    for (let i = 0; i < Math.floor(volume * 0.12); i++) {
      const [a] = pick(this.agents);
      let [b] = pick(this.agents);
      if (b === a) b = a === '1012' ? '1001' : '1012';
      const t = time();
      const talk = rand() < 0.85 ? Math.floor(10 + rand() * 180) : 0;
      rows.push({ calldate: stamp(t), clid: `"${agentName(a)}" <${a}>`, src: a, dst: b, dcontext: 'from-internal', channel: `PJSIP/${a}-${hex()}`, dstchannel: `PJSIP/${b}-${hex()}`, lastapp: 'Dial', disposition: talk ? 'ANSWERED' : 'NO ANSWER', duration: talk + 6, billsec: talk, uniqueid: uid(t) });
    }

    rows.sort((x, y) => (x.calldate < y.calldate ? -1 : x.calldate > y.calldate ? 1 : 0));
    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(date, rows);
    return rows;
  }

  async fetch(from, to) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const nowStamp = `${today} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const rows = [];
    const d = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      if (date > today) break;
      for (const r of this._day(date)) if (r.calldate <= nowStamp) rows.push(r);
    }
    return rows;
  }
}

/** Calcula relatórios sobre uma fonte de CDR, com cache curto por período. */
class ReportService {
  constructor(source, { extensionPattern = '^\\d{2,6}$', slaSeconds = 20, maxDays = 366 } = {}) {
    this.source = source;
    this.extRe = new RegExp(extensionPattern);
    this.slaSeconds = slaSeconds;
    this.maxDays = maxDays;
    this.cache = new Map();
  }

  async calls(from, to) {
    const key = `${from}|${to}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.promise;
    // Períodos que incluem hoje mudam a todo momento; períodos passados podem ficar mais tempo
    const includesToday = to >= localToday();
    const promise = this.source.fetch(from, to).then((rows) => buildCalls(rows, this.extRe));
    this.cache.set(key, { promise, expires: Date.now() + (includesToday ? 30000 : 600000) });
    promise.catch(() => this.cache.delete(key));
    if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    return promise;
  }

  /** Valida o período (YYYY-MM-DD) e executa o relatório. */
  async run(type, query = {}) {
    const report = REPORTS[type];
    if (!report) throw Object.assign(new Error('Relatório não encontrado'), { status: 404 });
    const { from, to } = parsePeriod(query, this.maxDays);
    const sla = Math.min(Math.max(parseInt(query.sla, 10) || this.slaSeconds, 1), 600);
    const ext = /^\d{2,8}$/.test(query.ext || '') ? query.ext : '';
    const queue = /^\w{1,20}$/.test(query.queue || '') ? query.queue : '';
    const all = await this.calls(from, to);
    const calls = filterCalls(all, { ext, queue });
    const data = report(calls, { ...query, from, to, sla, ext, queue });
    // Ramais e filas do período, para os filtros da tela
    const extensions = new Set();
    const queues = new Set();
    for (const c of all) {
      if (c.origin) extensions.add(c.origin);
      if (c.agent) extensions.add(c.agent);
      if (c.queue) queues.add(c.queue);
    }
    return {
      report: type, from, to, sla, ext, queue,
      extensions: [...extensions].sort(), queues: [...queues].sort(),
      generatedAt: new Date().toISOString(),
      ...data,
    };
  }
}

function localToday() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parsePeriod(query, maxDays) {
  const today = localToday();
  const from = DATE_RE.test(query.from || '') ? query.from : today;
  const to = DATE_RE.test(query.to || '') ? query.to : from;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw Object.assign(new Error('Data inválida'), { status: 400 });
  if (toMs < fromMs) throw Object.assign(new Error('A data final deve ser igual ou posterior à inicial'), { status: 400 });
  if ((toMs - fromMs) / 86400000 + 1 > maxDays) {
    throw Object.assign(new Error(`O período máximo é de ${maxDays} dias`), { status: 400 });
  }
  return { from, to };
}

/** Traduz erros de conexão/consulta ao MariaDB em uma causa legível (sem expor senhas). */
function describeCdrError(err, db = {}) {
  const where = db.socketPath ? `socket ${db.socketPath}` : `${db.host}:${db.port}`;
  const user = `'${db.user}'`;
  switch (err && err.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return `acesso negado para o usuário ${user} — confira CDR_DB_USER/CDR_DB_PASSWORD e o host do usuário no MariaDB ('127.0.0.1' via TCP ou 'localhost' via socket)`;
    case 'ER_HOST_NOT_PRIVILEGED':
      return `o MariaDB não aceita o usuário ${user} a partir deste host — crie o usuário para '127.0.0.1'`;
    case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_COLUMNACCESS_DENIED_ERROR':
      return `o usuário ${user} não tem permissão de leitura — falta: GRANT SELECT ON ${db.database}.${db.table} TO ...`;
    case 'ER_BAD_DB_ERROR':
      return `o banco '${db.database}' não existe — confira CDR_DB_NAME`;
    case 'ER_NO_SUCH_TABLE':
      return `a tabela '${db.database}.${db.table}' não existe — confira CDR_DB_TABLE`;
    case 'ER_BAD_FIELD_ERROR':
      return `a tabela de CDR não tem uma coluna esperada (${err.sqlMessage || err.message})`;
    case 'ECONNREFUSED':
      return `o MariaDB recusou a conexão em ${where} — ele pode estar sem TCP (skip-networking); use CDR_DB_SOCKET=/var/lib/mysql/mysql.sock`;
    case 'ENOENT':
      return `socket do MariaDB não encontrado em ${db.socketPath} — confira CDR_DB_SOCKET`;
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
      return `não foi possível alcançar o MariaDB em ${where} (${err.code})`;
    default:
      return `${(err && err.code) || 'erro'}: ${(err && (err.sqlMessage || err.message)) || 'desconhecido'}`;
  }
}

module.exports = { MysqlCdr, MockCdr, ReportService, parsePeriod, describeCdrError, localToday };
