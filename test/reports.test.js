'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCalls, extOfChannel } = require('../server/calls');
const R = require('../server/reports');
const { parsePeriod, ReportService, MockCdr } = require('../server/cdr');

const EXT = /^\d{2,6}$/;
const row = (o) => ({ clid: '', dcontext: 'from-internal', lastapp: 'Dial', dstchannel: '', duration: 0, billsec: 0, ...o });

// Cenário: fila atendida, fila abandonada + retorno, ramal→externo, ramal→ramal, DDR não atendido
const rows = [
  // 1) entrada pela fila 600, esperou 15s, atendida pelo 1001 (perna Local;2 deve ser ignorada)
  row({ calldate: '2026-09-28 09:10:00', clid: '"Cliente X" <11988887777>', src: '11988887777', dst: '600', dcontext: 'ext-queues', lastapp: 'Queue', channel: 'PJSIP/operadora-0000000a', dstchannel: 'Local/1001@from-queue-00000001;1', disposition: 'ANSWERED', duration: 135, billsec: 120, uniqueid: 'u1' }),
  row({ calldate: '2026-09-28 09:10:13', src: '11988887777', dst: '1001', channel: 'Local/1001@from-queue-00000001;2', dstchannel: 'PJSIP/1001-0000000b', disposition: 'ANSWERED', duration: 122, billsec: 120, uniqueid: 'u1b' }),
  // 2) entrada pela fila 600, desistiu após 40s
  row({ calldate: '2026-09-28 10:00:00', src: '1133334444', dst: '600', dcontext: 'ext-queues', lastapp: 'Queue', channel: 'PJSIP/operadora-0000000c', disposition: 'NO ANSWER', duration: 40, uniqueid: 'u2' }),
  // 3) retorno do 1002 para o número perdido (com 0 + DDD diferente de formatação), atendido
  row({ calldate: '2026-09-28 10:30:00', clid: '"Bruno" <1002>', src: '1002', dst: '01133334444', channel: 'PJSIP/1002-0000000d', dstchannel: 'PJSIP/operadora-0000000e', disposition: 'ANSWERED', duration: 70, billsec: 60, uniqueid: 'u3' }),
  // 4) interna 1001 -> 1002
  row({ calldate: '2026-09-28 11:00:00', clid: '"Ana" <1001>', src: '1001', dst: '1002', channel: 'PJSIP/1001-0000000f', dstchannel: 'PJSIP/1002-00000010', disposition: 'ANSWERED', duration: 30, billsec: 25, uniqueid: 'u4' }),
  // 5) DDR para grupo: tocou em 1001 e 1002, ninguém atendeu
  row({ calldate: '2026-09-29 14:05:00', src: '11977776666', dst: '1001', channel: 'SIP/operadora-00000011', dstchannel: 'PJSIP/1001-00000012', disposition: 'NO ANSWER', duration: 20, uniqueid: 'u5' }),
  row({ calldate: '2026-09-29 14:05:00', src: '11977776666', dst: '1001', channel: 'SIP/operadora-00000011', dstchannel: 'PJSIP/1002-00000013', disposition: 'NO ANSWER', duration: 20, uniqueid: 'u5' }),
];

test('ramal do canal: PJSIP/SIP/Local; troncos com nome ou número longo ficam de fora', () => {
  assert.equal(extOfChannel('PJSIP/1001-0000000b', EXT), '1001');
  assert.equal(extOfChannel('SIP/2005-00ab', EXT), '2005');
  assert.equal(extOfChannel('Local/1003@from-queue-00000001;1', EXT), '1003');
  assert.equal(extOfChannel('PJSIP/operadora-trunk-0000000a', EXT), null);
  assert.equal(extOfChannel('PJSIP/1133334444-0000000a', EXT), null);
  assert.equal(extOfChannel('', EXT), null);
});

test('linhas do CDR viram uma chamada por uniqueid, classificadas', () => {
  const calls = buildCalls(rows, EXT);
  assert.equal(calls.length, 5);
  const [q1, q2, back, internal, ddr] = calls;
  assert.deepEqual([q1.direction, q1.queue, q1.agent, q1.wait, q1.talk, q1.name], ['in', '600', '1001', 15, 120, 'Cliente X']);
  assert.deepEqual([q2.direction, q2.status, q2.wait], ['in', 'missed', 40]);
  assert.deepEqual([back.direction, back.origin, back.agent, back.number], ['out', '1002', '1002', '01133334444']);
  assert.deepEqual([internal.direction, internal.agent], ['internal', '1002']);
  assert.deepEqual([ddr.direction, ddr.status, ddr.rang], ['in', 'missed', ['1001', '1002']]);
  assert.equal(ddr.weekday, 2); // terça-feira
  assert.equal(ddr.hour, 14);
});

test('visão geral: totais, nível de serviço e distribuição por dia/hora', () => {
  const calls = buildCalls(rows, EXT);
  const o = R.overview(calls, { from: '2026-09-27', to: '2026-09-29', sla: 20 });
  assert.equal(o.totals.in, 3);
  assert.equal(o.totals.inAnswered, 1);
  assert.equal(o.totals.inMissed, 2);
  assert.equal(o.totals.answerRate, 33.3);
  assert.equal(o.totals.serviceLevel, 33.3);
  assert.equal(o.totals.out, 1);
  assert.equal(o.totals.internal, 1);
  assert.equal(o.totals.avgTalk, 90); // (120 + 60) / 2, internas fora
  assert.deepEqual(o.byDay.map((d) => d.date), ['2026-09-27', '2026-09-28', '2026-09-29']);
  assert.equal(o.byDay[0].in, 0);
  assert.equal(o.byDay[1].missed, 1);
  assert.equal(o.byHour[14].missed, 1);
});

test('perdidas: identifica retorno pelo mesmo número e respeita a janela', () => {
  const calls = buildCalls(rows, EXT);
  const m = R.missed(calls, { window: 24 });
  assert.equal(m.summary.total, 2);
  const lost = m.records.find((r) => r.number === '1133334444');
  assert.equal(lost.returned, 'returned');
  assert.equal(lost.callback.ext, '1002');
  assert.equal(lost.returnSeconds, 30 * 60);
  assert.equal(m.records.find((r) => r.number === '11977776666').returned, 'pending');
  assert.equal(m.summary.pending, 1);
  // Janela mínima de 1h (o retorno veio em 30 min)
  const tight = R.missed(calls, { window: 0.1 }); // mínimo 1h
  assert.equal(tight.window, 1);
  assert.equal(tight.records.find((r) => r.number === '1133334444').returned, 'returned');
});

test('ramais, filas e principais números', () => {
  const calls = buildCalls(rows, EXT);
  const a = R.agents(calls, { sla: 20 });
  const r1001 = a.agents.find((x) => x.ext === '1001');
  const r1002 = a.agents.find((x) => x.ext === '1002');
  assert.deepEqual([r1001.inAnswered, r1001.inNotAnswered, r1001.internal, r1001.name], [1, 1, 1, 'Ana']);
  assert.deepEqual([r1002.out, r1002.outAnswered, r1002.inNotAnswered, r1002.name], [1, 1, 1, 'Bruno']);
  assert.equal(R.agents(calls, { sla: 20, ext: '1002' }).agents.length, 1);

  const q = R.queues(calls, { sla: 20 });
  assert.equal(q.queues.length, 1);
  assert.deepEqual([q.queues[0].offered, q.queues[0].answered, q.queues[0].abandoned, q.queues[0].abandonRate, q.queues[0].serviceLevel],
    [2, 1, 1, 50, 50]);
  assert.equal(q.queues[0].agents[0].ext, '1001');

  const t = R.topNumbers(calls);
  assert.equal(t.callers.length, 3);
  assert.equal(t.dialed[0].number, '01133334444');

  const f = R.filterCalls(calls, { ext: '1001' });
  assert.equal(f.length, 3); // atendeu na fila, interna, tocou no DDR
});

test('detalhado: filtros e paginação', () => {
  const calls = buildCalls(rows, EXT);
  assert.equal(R.detail(calls, { direction: 'in' }).total, 3);
  assert.equal(R.detail(calls, { status: 'notanswered' }).total, 2);
  assert.equal(R.detail(calls, { search: '(11) 97777-6666' }).total, 1);
  const page = R.detail(calls, { limit: 2, offset: 0 });
  assert.equal(page.records.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.records[0].calldate, '2026-09-29 14:05:00'); // mais recente primeiro
});

test('período é validado', () => {
  assert.deepEqual(parsePeriod({ from: '2026-09-01', to: '2026-09-30' }, 366), { from: '2026-09-01', to: '2026-09-30' });
  assert.throws(() => parsePeriod({ from: '2026-09-30', to: '2026-09-01' }, 366), /posterior/);
  assert.throws(() => parsePeriod({ from: '2025-01-01', to: '2026-09-30' }, 366), /máximo/);
});

test('todos os relatórios rodam sobre o CDR simulado', async () => {
  const svc = new ReportService(new MockCdr());
  for (const type of Object.keys(R.REPORTS)) {
    const res = await svc.run(type, { from: '2026-09-01', to: '2026-09-07' });
    assert.equal(res.report, type);
  }
  const o = await svc.run('overview', { from: '2026-09-01', to: '2026-09-07' });
  assert.ok(o.totals.in > 100);
  assert.ok(o.extensions.includes('1001'));
  assert.deepEqual(o.queues, ['600', '601']);
  await assert.rejects(svc.run('nope', {}), /não encontrado/);
});
