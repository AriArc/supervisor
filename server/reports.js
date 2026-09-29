'use strict';

/**
 * Relatórios de central de atendimento calculados a partir das chamadas (ver calls.js).
 * Todas as funções são puras: recebem a lista de chamadas do período e devolvem JSON.
 */

const { numberKey } = require('./calls');

const avg = (sum, n) => (n ? Math.round(sum / n) : 0);
const pct = (part, total) => (total ? Math.round((part / total) * 1000) / 10 : 0);

/** Datas YYYY-MM-DD de from até to (inclusive). */
function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Filtros comuns: ramal (atendeu, originou ou tocou) e fila. */
function filterCalls(calls, { ext, queue } = {}) {
  return calls.filter((c) =>
    (!ext || c.agent === ext || c.origin === ext || c.rang.includes(ext)) &&
    (!queue || c.queue === queue));
}

function totalsOf(calls, sla) {
  const inc = calls.filter((c) => c.direction === 'in');
  const inAns = inc.filter((c) => c.answered);
  const out = calls.filter((c) => c.direction === 'out');
  const outAns = out.filter((c) => c.answered);
  const talked = calls.filter((c) => c.answered && c.direction !== 'internal');
  const talkSum = talked.reduce((s, c) => s + c.talk, 0);
  return {
    total: calls.length,
    in: inc.length,
    inAnswered: inAns.length,
    inMissed: inc.length - inAns.length,
    answerRate: pct(inAns.length, inc.length),
    serviceLevel: pct(inAns.filter((c) => c.wait <= sla).length, inc.length),
    out: out.length,
    outAnswered: outAns.length,
    internal: calls.length - inc.length - out.length,
    talkTotal: talkSum,
    avgTalk: avg(talkSum, talked.length),
    avgWait: avg(inAns.reduce((s, c) => s + c.wait, 0), inAns.length),
    maxWait: inc.reduce((m, c) => Math.max(m, c.wait), 0),
  };
}

// ---------- Visão geral ----------
function overview(calls, { from, to, sla }) {
  const byDay = new Map(daysBetween(from, to).map((d) => [d, { date: d, in: 0, inAnswered: 0, missed: 0, out: 0, internal: 0 }]));
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, in: 0, missed: 0, out: 0 }));
  for (const c of calls) {
    const d = byDay.get(c.date);
    const h = byHour[c.hour];
    if (c.direction === 'in') {
      if (d) { d.in++; if (c.answered) d.inAnswered++; else d.missed++; }
      h.in++;
      if (!c.answered) h.missed++;
    } else if (c.direction === 'out') {
      if (d) d.out++;
      h.out++;
    } else if (d) d.internal++;
  }
  const status = {};
  for (const c of calls) {
    if (c.direction === 'internal') continue;
    status[c.status] = (status[c.status] || 0) + 1;
  }
  return { totals: totalsOf(calls, sla), byDay: [...byDay.values()], byHour, status };
}

// ---------- Volume por dia da semana × hora (chamadas recebidas) ----------
function hourly(calls, { from, to }) {
  const matrix = Array.from({ length: 7 }, () => Array(24).fill(0));
  const missed = Array.from({ length: 7 }, () => Array(24).fill(0));
  // Quantas vezes cada dia da semana aparece no período, para calcular a média por dia
  const occurrences = Array(7).fill(0);
  for (const d of daysBetween(from, to)) occurrences[new Date(`${d}T00:00:00Z`).getUTCDay()]++;
  for (const c of calls) {
    if (c.direction !== 'in') continue;
    matrix[c.weekday][c.hour]++;
    if (!c.answered) missed[c.weekday][c.hour]++;
  }
  let peak = { weekday: 0, hour: 0, count: 0 };
  matrix.forEach((row, w) => row.forEach((n, h) => { if (n > peak.count) peak = { weekday: w, hour: h, count: n }; }));
  const hours = Array.from({ length: 24 }, (_, h) => {
    const total = matrix.reduce((s, row) => s + row[h], 0);
    const lost = missed.reduce((s, row) => s + row[h], 0);
    return { hour: h, total, missed: lost, missRate: pct(lost, total) };
  });
  return { matrix, missed, occurrences, peak, hours };
}

// ---------- Desempenho por ramal ----------
function agents(calls, { sla, ext: onlyExt = '' }) {
  const map = new Map();
  const row = (ext) => {
    if (!map.has(ext)) {
      map.set(ext, {
        ext, name: '', inAnswered: 0, inNotAnswered: 0, out: 0, outAnswered: 0, internal: 0,
        talkIn: 0, talkOut: 0, waitSum: 0, withinSla: 0, lastCall: '',
      });
    }
    return map.get(ext);
  };
  for (const c of calls) {
    if (c.origin && c.originName && c.originName !== c.origin) row(c.origin).name = c.originName;
    if (c.direction === 'in') {
      if (c.answered && c.agent) {
        const r = row(c.agent);
        r.inAnswered++;
        r.talkIn += c.talk;
        r.waitSum += c.wait;
        if (c.wait <= sla) r.withinSla++;
        r.lastCall = c.calldate;
      }
      // Tocou no ramal e ninguém atendeu
      if (!c.answered) for (const e of c.rang) row(e).inNotAnswered++;
    } else if (c.direction === 'out') {
      const r = row(c.origin);
      r.out++;
      if (c.answered) { r.outAnswered++; r.talkOut += c.talk; }
      r.lastCall = c.calldate;
    } else {
      if (c.origin) row(c.origin).internal++;
      if (c.agent && c.agent !== c.origin) row(c.agent).internal++;
    }
  }
  const totalInAnswered = [...map.values()].reduce((s, r) => s + r.inAnswered, 0);
  const list = [...map.values()].filter((r) => !onlyExt || r.ext === onlyExt).map((r) => {
    const talkCount = r.inAnswered + r.outAnswered;
    const talk = r.talkIn + r.talkOut;
    const { waitSum, withinSla, ...rest } = r;
    return {
      ...rest,
      talkTotal: talk,
      avgTalk: avg(talk, talkCount),
      avgWait: avg(waitSum, r.inAnswered),
      serviceLevel: pct(withinSla, r.inAnswered),
      share: pct(r.inAnswered, totalInAnswered),
    };
  });
  list.sort((a, b) => b.inAnswered + b.out - (a.inAnswered + a.out) || a.ext.localeCompare(b.ext));
  return { agents: list };
}

// ---------- Chamadas perdidas e retorno ----------
function missed(calls, { window: windowHours } = {}) {
  // Só conta como retorno o contato feito até N horas depois da perda (padrão: 24h)
  const hours = Number(windowHours) > 0 ? Number(windowHours) : 24;
  const windowSec = Math.round(Math.min(Math.max(hours, 1), 720) * 3600);
  const secondsBetween = (a, b) => Math.round((Date.parse(b.replace(' ', 'T')) - Date.parse(a.replace(' ', 'T'))) / 1000);
  // Próximos contatos com cada número (em ordem cronológica)
  const later = new Map();
  for (const c of calls) {
    if (c.direction === 'internal') continue;
    const k = numberKey(c.number);
    if (!k) continue;
    if (!later.has(k)) later.set(k, []);
    later.get(k).push(c);
  }
  const list = [];
  for (const c of calls) {
    if (c.direction !== 'in' || c.answered) continue;
    const k = numberKey(c.number);
    const after = (later.get(k) || []).filter((x) => x.calldate > c.calldate && secondsBetween(c.calldate, x.calldate) <= windowSec);
    const callback = after.find((x) => x.direction === 'out' && x.answered)
      || after.find((x) => x.direction === 'in' && x.answered)
      || after.find((x) => x.direction === 'out');
    let returned = 'pending';
    if (callback) {
      if (callback.direction === 'in') returned = 'recalled';       // cliente ligou de novo e foi atendido
      else returned = callback.answered ? 'returned' : 'attempted'; // central retornou / tentou retornar
    }
    list.push({
      id: c.id,
      calldate: c.calldate,
      number: c.number,
      name: c.name,
      wait: c.wait,
      queue: c.queue,
      rang: c.rang,
      returned,
      callback: callback ? { calldate: callback.calldate, ext: callback.agent || callback.origin, answered: callback.answered, direction: callback.direction } : null,
      returnSeconds: callback ? secondsBetween(c.calldate, callback.calldate) : null,
    });
  }
  list.reverse();
  const solved = list.filter((m) => m.returned === 'returned' || m.returned === 'recalled');
  const times = solved.map((m) => m.returnSeconds).filter((s) => s != null);
  return {
    window: windowSec / 3600,
    summary: {
      total: list.length,
      uniqueNumbers: new Set(list.map((m) => numberKey(m.number))).size,
      returned: list.filter((m) => m.returned === 'returned').length,
      recalled: list.filter((m) => m.returned === 'recalled').length,
      attempted: list.filter((m) => m.returned === 'attempted').length,
      pending: list.filter((m) => m.returned === 'pending').length,
      avgReturn: avg(times.reduce((s, t) => s + t, 0), times.length),
      avgWait: avg(list.reduce((s, m) => s + m.wait, 0), list.length),
    },
    records: list,
  };
}

// ---------- Filas ----------
function queues(calls, { sla }) {
  const map = new Map();
  for (const c of calls) {
    if (!c.queue) continue;
    if (!map.has(c.queue)) {
      map.set(c.queue, { queue: c.queue, offered: 0, answered: 0, abandoned: 0, withinSla: 0, waitAns: 0, waitAband: 0, maxWait: 0, talk: 0, agents: new Map() });
    }
    const q = map.get(c.queue);
    q.offered++;
    q.maxWait = Math.max(q.maxWait, c.wait);
    if (c.answered) {
      q.answered++;
      q.waitAns += c.wait;
      q.talk += c.talk;
      if (c.wait <= sla) q.withinSla++;
      if (c.agent) {
        const a = q.agents.get(c.agent) || { ext: c.agent, answered: 0, talk: 0 };
        a.answered++;
        a.talk += c.talk;
        q.agents.set(c.agent, a);
      }
    } else {
      q.abandoned++;
      q.waitAband += c.wait;
    }
  }
  const list = [...map.values()].map((q) => ({
    queue: q.queue,
    offered: q.offered,
    answered: q.answered,
    abandoned: q.abandoned,
    answerRate: pct(q.answered, q.offered),
    abandonRate: pct(q.abandoned, q.offered),
    serviceLevel: pct(q.withinSla, q.offered),
    avgWait: avg(q.waitAns, q.answered),
    avgAbandonWait: avg(q.waitAband, q.abandoned),
    maxWait: q.maxWait,
    avgTalk: avg(q.talk, q.answered),
    agents: [...q.agents.values()]
      .map((a) => ({ ...a, avgTalk: avg(a.talk, a.answered), share: pct(a.answered, q.answered) }))
      .sort((a, b) => b.answered - a.answered),
  })).sort((a, b) => b.offered - a.offered);
  const sum = (k) => list.reduce((s, q) => s + q[k], 0);
  const offered = sum('offered');
  const queued = calls.filter((c) => c.queue);
  return {
    totals: {
      offered,
      answered: sum('answered'),
      abandoned: sum('abandoned'),
      abandonRate: pct(sum('abandoned'), offered),
      serviceLevel: pct(queued.filter((c) => c.answered && c.wait <= sla).length, offered),
      avgWait: avg(queued.filter((c) => c.answered).reduce((s, c) => s + c.wait, 0), sum('answered')),
    },
    queues: list,
  };
}

// ---------- Principais números ----------
function topNumbers(calls, { limit = 20 } = {}) {
  const build = (direction) => {
    const map = new Map();
    for (const c of calls) {
      if (c.direction !== direction) continue;
      const k = numberKey(c.number);
      if (!k) continue;
      const r = map.get(k) || { number: c.number, name: '', calls: 0, answered: 0, missed: 0, talk: 0, lastCall: '' };
      r.calls++;
      if (c.answered) { r.answered++; r.talk += c.talk; } else r.missed++;
      if (c.name) r.name = c.name;
      r.lastCall = c.calldate;
      map.set(k, r);
    }
    return [...map.values()].sort((a, b) => b.calls - a.calls || b.talk - a.talk).slice(0, limit);
  };
  return { callers: build('in'), dialed: build('out') };
}

// ---------- Detalhado ----------
const DIRECTIONS = ['all', 'in', 'out', 'internal'];
const STATUSES = ['all', 'answered', 'missed', 'noanswer', 'busy', 'failed', 'notanswered'];

function detail(calls, q = {}) {
  const direction = DIRECTIONS.includes(q.direction) ? q.direction : 'all';
  const status = STATUSES.includes(q.status) ? q.status : 'all';
  const search = String(q.search || '').replace(/[^\d*#+]/g, '').slice(0, 32);
  const limit = q.limit === 'all' ? 50000 : Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);
  const list = calls.filter((c) =>
    (direction === 'all' || c.direction === direction) &&
    (status === 'all' || (status === 'notanswered' ? !c.answered : c.status === status)) &&
    (!search || c.number.includes(search) || (c.origin || '').includes(search) || (c.agent || '').includes(search))
  ).reverse();
  return {
    total: list.length,
    records: list.slice(offset, offset + limit).map((c) => ({
      id: c.id, calldate: c.calldate, direction: c.direction, number: c.number, name: c.name,
      origin: c.origin, agent: c.agent, queue: c.queue, rang: c.rang, status: c.status, wait: c.wait, talk: c.talk,
    })),
    hasMore: list.length > offset + limit,
  };
}

const REPORTS = { overview, hourly, agents, missed, queues, top: topNumbers, detail };

module.exports = { REPORTS, filterCalls, totalsOf, daysBetween, overview, hourly, agents, missed, queues, topNumbers, detail };
