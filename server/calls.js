'use strict';

/**
 * Converte linhas da tabela `cdr` do Issabel/Asterisk em chamadas (uma por uniqueid).
 *
 * Uma única ligação pode gerar várias linhas no CDR (grupos de toque, filas, pernas Local/).
 * Aqui elas são agrupadas e classificadas do ponto de vista da central:
 *  - in:       chegou por um tronco (canal de origem não é um ramal)
 *  - out:      saiu de um ramal para um número externo
 *  - internal: ramal para ramal (ou fila/serviço interno)
 */

// "Fulano" <1199999> -> Fulano
function clidName(clid) {
  const m = /^"?([^"<]*?)"?\s*<[^>]*>$/.exec(String(clid || '').trim());
  return m ? m[1].trim() : '';
}

/** Ramal de um canal: PJSIP/1001-0000001a, SIP/1001-..., Local/1001@from-queue-...;1 */
function extOfChannel(channel, extRe) {
  const ch = String(channel || '');
  let name = null;
  const local = /^Local\/([^@]+)@/i.exec(ch);
  if (local) name = local[1];
  else {
    const m = /^(?:PJSIP|SIP|IAX2)\/(.+)-[0-9a-f]+$/i.exec(ch);
    if (m) name = m[1];
  }
  return name && extRe.test(name) ? name : null;
}

/** Chave para comparar telefones com/sem DDD, 0, +55: últimos 8 dígitos. */
function numberKey(n) {
  const digits = String(n || '').replace(/\D/g, '');
  return digits.length > 8 ? digits.slice(-8) : digits;
}

function dateParts(calldate) {
  const s = String(calldate);
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return { date: s.slice(0, 10), hour: 0, weekday: 0 };
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    hour: Number(m[4]),
    weekday: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay(),
  };
}

const DISPO_RANK = { ANSWERED: 4, BUSY: 3, FAILED: 2, CONGESTION: 2, 'NO ANSWER': 1 };

function statusOf(direction, answered, disposition) {
  if (answered) return 'answered';
  if (direction === 'in') return 'missed';
  if (disposition === 'BUSY') return 'busy';
  if (disposition === 'FAILED' || disposition === 'CONGESTION') return 'failed';
  return 'noanswer';
}

/**
 * @param rows linhas do CDR em ordem cronológica
 * @param extRe expressão que reconhece um número de ramal
 */
function buildCalls(rows, extRe) {
  const groups = new Map();
  for (const r of rows) {
    // Pernas Local/...;2 são internas do Asterisk (fila/grupo discando o agente): a perna
    // principal já registra o atendimento, então elas só duplicariam a chamada.
    if (/^Local\//i.test(r.channel || '')) continue;
    const key = String(r.uniqueid || `${r.calldate}|${r.channel}`);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }

  const calls = [];
  for (const [id, list] of groups) {
    const first = list[0];
    const origin = extOfChannel(first.channel, extRe);
    const rang = [];
    let answeredRow = null;
    let queue = null;
    let duration = 0;
    let disposition = '';
    for (const r of list) {
      const ext = extOfChannel(r.dstchannel, extRe);
      if (ext && ext !== origin && !rang.includes(ext)) rang.push(ext);
      if (!queue && (r.lastapp === 'Queue' || r.dcontext === 'ext-queues')) queue = String(r.dst || '');
      duration = Math.max(duration, Number(r.duration) || 0);
      if ((DISPO_RANK[r.disposition] || 0) > (DISPO_RANK[disposition] || 0)) disposition = r.disposition;
      if (r.disposition === 'ANSWERED' && (!answeredRow || Number(r.billsec) > Number(answeredRow.billsec))) answeredRow = r;
    }

    const dst = String(first.dst || '');
    let direction = 'in';
    // Ramal que discou outro ramal, uma fila ou um código de serviço (*xx) é ligação interna
    if (origin) direction = extRe.test(dst) || /^[*#]/.test(dst) || rang.length || queue ? 'internal' : 'out';

    const answered = Boolean(answeredRow);
    const talk = answered ? Number(answeredRow.billsec) || 0 : 0;
    const wait = answered ? Math.max(0, (Number(answeredRow.duration) || 0) - talk) : duration;
    const agentExt = answered ? extOfChannel(answeredRow.dstchannel, extRe) : null;

    calls.push({
      id,
      calldate: String(first.calldate),
      ...dateParts(first.calldate),
      direction,
      number: direction === 'in' ? String(first.src || '') : dst,
      name: direction === 'in' && clidName(first.clid) !== String(first.src) ? clidName(first.clid) : '',
      origin,                                           // ramal que originou (out/internal)
      agent: direction === 'out' ? origin : agentExt,   // ramal responsável pela conversa
      rang,
      queue,
      answered,
      status: statusOf(direction, answered, disposition),
      wait,
      talk,
      duration,
      originName: origin ? clidName(first.clid) : '',
    });
  }
  return calls.sort((a, b) => (a.calldate < b.calldate ? -1 : a.calldate > b.calldate ? 1 : 0));
}

module.exports = { buildCalls, extOfChannel, clidName, numberKey, dateParts };
