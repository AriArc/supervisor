'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = (id) => `<svg class="icon"><use href="#i-${id}"/></svg>`;

  const ROLE_LABEL = { admin: 'Administrador', supervisor: 'Supervisor' };
  const DIR_LABEL = { in: 'Recebida', out: 'Realizada', internal: 'Interna' };
  const STATUS_LABEL = { answered: 'Atendida', missed: 'Perdida', noanswer: 'Não atendida', busy: 'Ocupado', failed: 'Falhou' };
  const STATUS_CLASS = { answered: 'good', missed: 'bad', noanswer: 'neutral', busy: 'warn', failed: 'bad' };
  const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

  const state = { me: null, users: [], editingUser: null, view: 'overview', data: null, seq: 0 };

  // ---------- Formatação ----------
  const nf = new Intl.NumberFormat('pt-BR');
  const fmtInt = (n) => nf.format(n || 0);
  const fmtPct = (n) => `${(n || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  const pad = (n) => String(n).padStart(2, '0');
  const fmtSec = (sec) => {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
  };
  const fmtLong = (sec) => {
    const s = Math.max(0, Math.round(sec || 0));
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
    return h ? `${h}h ${pad(m)}min` : `${m}min`;
  };
  const fmtDateTime = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : esc(s || '—');
  };
  const fmtDay = (d) => { const m = d.split('-'); return `${m[2]}/${m[1]}`; };
  const fmtDateBR = (d) => { const m = d.split('-'); return `${m[2]}/${m[1]}/${m[0]}`; };
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && url !== '/api/login') showLogin();
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }

  function toast(message, type = 'ok') {
    const el = document.createElement('div');
    el.className = `toast ${type === 'err' ? 'err' : ''}`;
    el.innerHTML = `${icon(type === 'err' ? 'x' : 'check')}<span>${esc(message)}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  const initials = (name) => {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return esc((parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase());
  };

  // ---------- Sessão ----------
  function showLogin() {
    state.me = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-user').focus();
  }

  function showApp() {
    const me = state.me;
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#me-name').textContent = me.name;
    $('#me-role').textContent = ROLE_LABEL[me.role] || me.role;
    $('#me-avatar').innerHTML = initials(me.name);
    $$('[data-admin]').forEach((el) => { el.hidden = me.role !== 'admin'; });
    route();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const { user } = await api('POST', '/api/login', {
        username: $('#login-user').value.trim(),
        password: $('#login-pass').value,
      });
      $('#login-pass').value = '';
      state.me = user;
      // Supervisores entram sempre na tela de relatórios
      if (user.role === 'supervisor' || !location.hash) history.replaceState(null, '', `${location.pathname}#overview`);
      showApp();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#logout-btn').addEventListener('click', async () => {
    await api('POST', '/api/logout').catch(() => {});
    showLogin();
  });

  // ---------- Filtros ----------
  const filters = { preset: 'today', from: '', to: '', ext: '', queue: '', sla: 20, window: 24 };

  function presetRange(p) {
    const today = new Date();
    const d = (offset) => { const x = new Date(today); x.setDate(x.getDate() + offset); return isoDate(x); };
    switch (p) {
      case 'yesterday': return [d(-1), d(-1)];
      case '7d': return [d(-6), d(0)];
      case '30d': return [d(-29), d(0)];
      case 'month': return [isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), d(0)];
      case 'lastmonth': return [
        isoDate(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        isoDate(new Date(today.getFullYear(), today.getMonth(), 0)),
      ];
      default: return [d(0), d(0)];
    }
  }

  function applyPreset(p) {
    filters.preset = p;
    [filters.from, filters.to] = presetRange(p);
    $('#f-from').value = filters.from;
    $('#f-to').value = filters.to;
    $$('#presets .chip').forEach((c) => c.classList.toggle('active', c.dataset.preset === p));
  }

  function readFilters() {
    filters.from = $('#f-from').value;
    filters.to = $('#f-to').value || filters.from;
    filters.ext = $('#f-ext').value;
    filters.queue = $('#f-queue').value;
    filters.sla = Number($('#f-sla').value) || 20;
    filters.window = Number($('#f-window').value) || 24;
  }

  $('#presets').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-preset]');
    if (!chip) return;
    applyPreset(chip.dataset.preset);
    runReport();
  });
  ['#f-from', '#f-to'].forEach((sel) => $(sel).addEventListener('change', () => {
    filters.preset = '';
    $$('#presets .chip').forEach((c) => c.classList.remove('active'));
    if ($('#f-to').value && $('#f-from').value > $('#f-to').value) $('#f-to').value = $('#f-from').value;
    runReport();
  }));
  ['#f-ext', '#f-queue'].forEach((sel) => $(sel).addEventListener('change', () => runReport()));
  ['#f-sla', '#f-window'].forEach((sel) => $(sel).addEventListener('change', () => runReport()));
  $('#run-btn').addEventListener('click', () => runReport());

  function fillSelect(sel, values, current, allLabel, label) {
    const el = $(sel);
    const list = [...new Set([...values, ...(current ? [current] : [])])].sort();
    el.innerHTML = `<option value="">${allLabel}</option>` +
      list.map((v) => `<option value="${esc(v)}">${esc(label(v))}</option>`).join('');
    el.value = current || '';
  }

  // ---------- Relatórios ----------
  const REPORTS = {
    overview: { title: 'Visão geral', desc: 'Indicadores principais, volume por dia e por hora', opts: ['sla'] },
    hourly: { title: 'Volume por horário', desc: 'Chamadas recebidas por dia da semana e hora — para dimensionar a equipe', opts: [] },
    agents: { title: 'Desempenho por ramal', desc: 'Atendidas, realizadas, tempo falado, TMA e TME de cada ramal', opts: ['sla'] },
    queues: { title: 'Filas de atendimento', desc: 'Nível de serviço, abandono e tempos de espera por fila', opts: ['sla'] },
    missed: { title: 'Perdidas e retorno', desc: 'Chamadas recebidas não atendidas e se o cliente teve retorno', opts: ['window'] },
    top: { title: 'Principais números', desc: 'Quem mais liga para a central e os números mais discados', opts: [] },
    detail: { title: 'Relatório detalhado', desc: 'Todas as ligações do período, com filtros e exportação', opts: [] },
  };

  const detail = { direction: 'all', status: 'all', search: '', offset: 0, records: [], total: 0, hasMore: false };
  const missedView = { filter: 'all', shown: 50 };
  const hourlyView = { mode: 'total' };

  function queryString(type, extra = {}) {
    const q = { from: filters.from, to: filters.to };
    if (filters.ext) q.ext = filters.ext;
    if (filters.queue) q.queue = filters.queue;
    if (REPORTS[type].opts.includes('sla')) q.sla = filters.sla;
    if (REPORTS[type].opts.includes('window')) q.window = filters.window;
    if (type === 'detail') Object.assign(q, { direction: detail.direction, status: detail.status, search: detail.search, offset: detail.offset });
    return new URLSearchParams({ ...q, ...extra }).toString();
  }

  async function runReport({ append = false } = {}) {
    const type = state.view;
    if (!REPORTS[type]) return;
    readFilters();
    if (!filters.from) return;
    if (type === 'detail' && !append) detail.offset = 0;
    if (type === 'missed' && !append) missedView.shown = 50;
    const seq = ++state.seq;
    const el = $('#report');
    el.classList.add('loading');
    if (!state.data || state.data.report !== type) el.innerHTML = `<div class="card empty">${icon('chart')}<div>Gerando relatório…</div></div>`;
    try {
      const data = await api('GET', `/api/reports/${type}?${queryString(type)}`);
      if (seq !== state.seq) return;
      fillSelect('#f-ext', data.extensions, filters.ext, 'Todos', (v) => `Ramal ${v}`);
      fillSelect('#f-queue', data.queues, filters.queue, 'Todas', (v) => `Fila ${v}`);
      if (type === 'detail') {
        detail.records = append ? detail.records.concat(data.records) : data.records;
        detail.total = data.total;
        detail.hasMore = data.hasMore;
      }
      state.data = data;
      render();
    } catch (err) {
      if (seq !== state.seq) return;
      state.data = null;
      el.innerHTML = `<div class="card empty">${icon('x')}<div>${esc(err.message)}</div></div>`;
    } finally {
      if (seq === state.seq) el.classList.remove('loading');
    }
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const html = RENDER[d.report](d);
    $('#report').innerHTML = html;
    charts.forEach((c) => drawChart(c));
  }

  // ---------- Componentes ----------
  const kpi = (cls, ic, val, lbl, sub = '') =>
    `<div class="card kpi ${cls}"><div class="ic">${icon(ic)}</div><div><div class="val num">${val}</div><div class="lbl">${esc(lbl)}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div></div>`;

  const card = (title, body, { hint = '', head = '' } = {}) =>
    `<section class="card"><div class="card-head"><h3>${title}</h3>${head}${hint ? `<span class="hint">${hint}</span>` : ''}</div><div class="card-body">${body}</div></section>`;

  const emptyBox = (msg, ic = 'search') => `<div class="empty">${icon(ic)}<div>${esc(msg)}</div></div>`;

  const legend = (items) => `<div class="legend">${items.map(([cls, label]) => `<span><i class="${cls}"></i>${esc(label)}</span>`).join('')}</div>`;

  const shareBar = (p) => `<div class="share"><span class="num">${fmtPct(p)}</span><div class="track"><div class="fill" style="width:${Math.min(100, p)}%"></div></div></div>`;

  const slaBadge = (p, good = 80, warn = 60) => `<span class="badge ${p >= good ? 'good' : p >= warn ? 'warn' : 'bad'}">${fmtPct(p)}</span>`;

  // Tabelas ordenáveis: colunas { key, label, num, fmt(row), sort(row) }
  const tables = {};
  function table(id, columns, rows, { sortKey = null, desc = true, foot = null, limit = null } = {}) {
    const t = tables[id] || (tables[id] = { sortKey, desc });
    let list = rows.slice();
    const col = columns.find((c) => c.key === t.sortKey);
    if (col) {
      const val = col.sort || ((r) => r[col.key]);
      list.sort((a, b) => {
        const x = val(a); const y = val(b);
        const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), 'pt-BR', { numeric: true });
        return t.desc ? -cmp : cmp;
      });
    }
    if (limit) list = list.slice(0, limit);
    const th = columns.map((c) => {
      const cls = [c.num ? 'n' : '', c.nosort ? '' : 'sortable', c.key === t.sortKey ? `sorted${t.desc ? '' : ' asc'}` : ''].join(' ');
      return `<th class="${cls}" ${c.nosort ? '' : `data-sort="${id}:${c.key}"`}>${esc(c.label)}</th>`;
    }).join('');
    const body = list.map((r, i) => `<tr>${columns.map((c) => `<td class="${c.num ? 'n' : ''}">${c.fmt ? c.fmt(r, i) : esc(r[c.key])}</td>`).join('')}</tr>`).join('');
    const tf = foot ? `<tfoot><tr>${columns.map((c) => `<td class="${c.num ? 'n' : ''}">${foot[c.key] ?? ''}</td>`).join('')}</tr></tfoot>` : '';
    return `<div class="table-wrap"><table class="rtable"><thead><tr>${th}</tr></thead><tbody>${body}</tbody>${tf}</table></div>`;
  }

  $('#report').addEventListener('click', (e) => {
    const th = e.target.closest('[data-sort]');
    if (th) {
      const [id, key] = th.dataset.sort.split(':');
      const t = tables[id];
      if (t.sortKey === key) t.desc = !t.desc;
      else { t.sortKey = key; t.desc = true; }
      render();
    }
  });

  // ---------- Gráfico de barras (SVG) ----------
  // spec: { id, labels[], titles[], series: [{ key, label, color, stack }], rows[], extra(row) }
  let charts = [];
  const chartBox = (spec) => { charts.push(spec); return `<div class="chart" id="${spec.id}"></div>`; };

  // Topo do eixo com 4 intervalos inteiros e "redondos"
  function niceMax(v) {
    const raw = Math.max(1, v / 4);
    const p = 10 ** Math.floor(Math.log10(raw));
    const n = raw / p;
    const mult = [1, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => n <= m && (m !== 2.5 || p >= 10));
    const step = mult * p;
    return step * 4;
  }

  function drawChart(spec) {
    const el = document.getElementById(spec.id);
    if (!el) return;
    const W = Math.max(el.clientWidth, 280);
    const H = W < 520 ? 220 : 260;
    const m = { t: 10, r: 8, b: 26, l: 40 };
    const iw = W - m.l - m.r;
    const ih = H - m.t - m.b;
    const stacks = [...new Set(spec.series.map((s) => s.stack))];
    const totals = spec.rows.map((r) => stacks.map((st) => spec.series.filter((s) => s.stack === st).reduce((a, s) => a + (r[s.key] || 0), 0)));
    const max = niceMax(Math.max(1, ...totals.flat()));
    const n = spec.rows.length;
    const band = iw / n;
    const groupW = Math.min(band * 0.78, stacks.length * 28);
    const barW = Math.max(2, (groupW - (stacks.length - 1) * 2) / stacks.length);
    const y = (v) => m.t + ih - (v / max) * ih;
    let svg = '';
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i;
      svg += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
      svg += `<text class="axis-label" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmtInt(v)}</text>`;
    }
    const every = Math.ceil(n / Math.floor(iw / 44));
    spec.rows.forEach((r, i) => {
      const x0 = m.l + band * i + (band - groupW) / 2;
      stacks.forEach((st, si) => {
        const x = x0 + si * (barW + 2);
        let base = 0;
        const segs = spec.series.filter((s) => s.stack === st && r[s.key] > 0);
        segs.forEach((s, k) => {
          const top = base + r[s.key];
          const y1 = y(top);
          const y0 = y(base) - (k ? 2 : 0); // 2px de espaço entre segmentos empilhados
          const h = Math.max(0, y0 - y1);
          const rad = k === segs.length - 1 ? Math.min(4, barW / 2, h) : 0;
          svg += `<path class="bar" fill="${s.color}" d="M${x},${y0}V${y1 + rad}Q${x},${y1} ${x + rad},${y1}H${x + barW - rad}Q${x + barW},${y1} ${x + barW},${y1 + rad}V${y0}Z"/>`;
          base = top;
        });
      });
      if (i % every === 0) svg += `<text class="axis-label" x="${m.l + band * i + band / 2}" y="${H - 8}" text-anchor="middle">${esc(spec.labels[i])}</text>`;
      svg += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}"/>`;
    });
    svg += `<line class="grid-line" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--muted)"/>`;
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="${esc(spec.aria || '')}">${svg}</svg>`;
    el.onmousemove = (e) => {
      const hit = e.target.closest('.hit');
      if (!hit) return hideTip();
      const r = spec.rows[hit.dataset.i];
      const lines = spec.series.map((s) => `<div class="row"><span><i style="background:${s.color}"></i>${esc(s.label)}</span><b>${fmtInt(r[s.key])}</b></div>`).join('');
      showTip(e, `<b>${esc(spec.titles[hit.dataset.i])}</b>${lines}${spec.extra ? spec.extra(r) : ''}`);
    };
    el.onmouseleave = hideTip;
  }

  const tip = $('#tooltip');
  function showTip(e, html) {
    tip.innerHTML = html;
    tip.hidden = false;
    const { innerWidth: vw, innerHeight: vh } = window;
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14;
    let y = e.clientY + 14;
    if (x + r.width > vw - 8) x = e.clientX - r.width - 14;
    if (y + r.height > vh - 8) y = e.clientY - r.height - 14;
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { tip.hidden = true; }

  // Na impressão a área útil muda: redesenha os gráficos na largura do papel
  window.addEventListener('beforeprint', () => charts.forEach((c) => drawChart(c)));
  window.addEventListener('afterprint', () => charts.forEach((c) => drawChart(c)));

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => charts.forEach((c) => drawChart(c)), 150);
  });

  const COLORS = { in: 'var(--c-in)', out: 'var(--c-out)', missed: 'var(--c-missed)' };
  const callSeries = [
    { key: 'inAnswered', label: 'Recebidas atendidas', color: COLORS.in, stack: 'in' },
    { key: 'missed', label: 'Recebidas perdidas', color: COLORS.missed, stack: 'in' },
    { key: 'out', label: 'Realizadas', color: COLORS.out, stack: 'out' },
  ];
  const callLegend = legend([['sw-in', 'Recebidas atendidas'], ['sw-missed', 'Recebidas perdidas'], ['sw-out', 'Realizadas']]);

  // ---------- Renderização de cada relatório ----------
  const RENDER = {
    overview(d) {
      charts = [];
      const t = d.totals;
      const kpis = `<div class="kpis">
        ${kpi('k4', 'in', fmtInt(t.in), 'Recebidas', `${fmtInt(t.inAnswered)} atendidas`)}
        ${kpi(t.answerRate >= 90 ? 'k1' : 'k2', 'target', fmtPct(t.answerRate), 'Taxa de atendimento', `${fmtInt(t.inMissed)} perdidas`)}
        ${kpi('k1', 'check', fmtPct(t.serviceLevel), 'Nível de serviço', `atendidas em até ${d.sla}s`)}
        ${kpi('k3', 'hourglass', fmtSec(t.avgWait), 'TME — espera média', `máxima ${fmtSec(t.maxWait)}`)}
        ${kpi('k4', 'clock', fmtSec(t.avgTalk), 'TMA — conversa média', `total ${fmtLong(t.talkTotal)}`)}
        ${kpi('k5', 'out', fmtInt(t.out), 'Realizadas', `${fmtInt(t.outAnswered)} atendidas`)}
        ${kpi('k5', 'internal', fmtInt(t.internal), 'Internas', 'entre ramais')}
        ${kpi('k4', 'phone', fmtInt(t.total), 'Total de ligações', `${esc(fmtDateBR(d.from))}${d.from !== d.to ? ` a ${esc(fmtDateBR(d.to))}` : ''}`)}
      </div>`;
      if (!t.total) return kpis + card('Sem ligações', emptyBox('Nenhuma ligação encontrada no período selecionado.'));
      const tipExtra = (r) => {
        const rate = r.in ? (100 * (r.in - r.missed)) / r.in : 0;
        return `<div class="row"><span>Taxa de atendimento</span><b>${fmtPct(Math.round(rate * 10) / 10)}</b></div>`;
      };
      const days = d.byDay.length > 1 ? card('Ligações por dia', chartBox({
        id: 'ch-days', labels: d.byDay.map((r) => fmtDay(r.date)),
        titles: d.byDay.map((r) => `${WEEKDAYS[new Date(`${r.date}T12:00:00`).getDay()]}, ${fmtDateBR(r.date)}`),
        series: callSeries, rows: d.byDay, extra: tipExtra, aria: 'Ligações por dia',
      }), { head: `<div class="grow"></div>${callLegend}` }) : '';
      const hoursUsed = d.byHour.filter((h) => h.in || h.out);
      const hMin = hoursUsed.length ? hoursUsed[0].hour : 8;
      const hMax = hoursUsed.length ? hoursUsed[hoursUsed.length - 1].hour : 18;
      const hours = d.byHour.slice(hMin, hMax + 1).map((h) => ({ ...h, inAnswered: h.in - h.missed }));
      const hoursCard = card('Ligações por hora do dia', chartBox({
        id: 'ch-hours', labels: hours.map((h) => `${h.hour}h`), titles: hours.map((h) => `${pad(h.hour)}:00 – ${pad(h.hour)}:59`),
        series: callSeries, rows: hours, extra: tipExtra, aria: 'Ligações por hora do dia',
      }), { head: `<div class="grow"></div>${callLegend}` });

      const statusRows = Object.entries(d.status).map(([k, v]) => ({ status: k, count: v }));
      const statusTotal = statusRows.reduce((s, r) => s + r.count, 0);
      const statusTable = table('ov-status', [
        { key: 'status', label: 'Resultado', fmt: (r) => `<span class="badge ${STATUS_CLASS[r.status]}">${esc(STATUS_LABEL[r.status] || r.status)}</span>` },
        { key: 'count', label: 'Ligações', num: true, fmt: (r) => fmtInt(r.count) },
        { key: 'pct', label: '% do total', num: true, sort: (r) => r.count, fmt: (r) => shareBar(Math.round((1000 * r.count) / statusTotal) / 10) },
      ], statusRows, { sortKey: 'count', foot: { status: 'Total', count: fmtInt(statusTotal) } });

      const dayTable = d.byDay.length > 1 ? card('Resumo por dia', table('ov-days', [
        { key: 'date', label: 'Dia', fmt: (r) => `${WEEKDAYS[new Date(`${r.date}T12:00:00`).getDay()]} ${fmtDateBR(r.date)}` },
        { key: 'in', label: 'Recebidas', num: true, fmt: (r) => fmtInt(r.in) },
        { key: 'missed', label: 'Perdidas', num: true, fmt: (r) => fmtInt(r.missed) },
        { key: 'rate', label: '% atend.', num: true, sort: (r) => (r.in ? r.inAnswered / r.in : 0), fmt: (r) => (r.in ? fmtPct(Math.round((1000 * r.inAnswered) / r.in) / 10) : '—') },
        { key: 'out', label: 'Realizadas', num: true, fmt: (r) => fmtInt(r.out) },
        { key: 'internal', label: 'Internas', num: true, fmt: (r) => fmtInt(r.internal) },
      ], d.byDay, { sortKey: 'date', desc: false })) : '';
      return `${kpis}${days}${hoursCard}<div class="grid2 wide-right">${card('Resultado das ligações', statusTable, { hint: 'Recebidas e realizadas (sem internas)' })}${dayTable}</div>`;
    },

    hourly(d) {
      charts = [];
      const totalIn = d.hours.reduce((s, h) => s + h.total, 0);
      if (!totalIn) return card('Sem ligações recebidas', emptyBox('Nenhuma ligação recebida no período selecionado.'));
      const used = d.hours.filter((h) => h.total);
      const hMin = used[0].hour;
      const hMax = used[used.length - 1].hour;
      const avgMode = hourlyView.mode === 'avg';
      const value = (w, h) => (avgMode ? (d.occurrences[w] ? d.matrix[w][h] / d.occurrences[w] : 0) : d.matrix[w][h]);
      let max = 0;
      for (const w of WEEK_ORDER) for (let h = hMin; h <= hMax; h++) max = Math.max(max, value(w, h));
      const cols = hMax - hMin + 1;
      let grid = `<div class="hl"></div>`;
      for (let h = hMin; h <= hMax; h++) grid += `<div class="hh">${h}h</div>`;
      for (const w of WEEK_ORDER) {
        grid += `<div class="hl">${WEEKDAYS[w]}</div>`;
        for (let h = hMin; h <= hMax; h++) {
          const v = value(w, h);
          const ratio = max ? v / max : 0;
          const shown = avgMode ? (v ? v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '0') : fmtInt(v);
          const miss = d.missed[w][h];
          grid += `<div class="cell${ratio > 0.55 ? ' dark' : ''}${v ? '' : ' zero'}" style="--v:${Math.round(ratio * 100)}%"
            data-tip="${esc(`${WEEKDAYS[w]} ${pad(h)}:00–${pad(h)}:59|${avgMode ? 'Média por dia' : 'Recebidas'}: ${shown}|Perdidas (total): ${fmtInt(miss)}|Dias no período: ${d.occurrences[w]}`)}">${shown}</div>`;
        }
      }
      const pk = d.peak;
      const days = d.occurrences.reduce((a, b) => a + b, 0);
      // Ignora horas com pouco movimento, onde 1 perdida já vira uma taxa alta
      const relevant = used.filter((h) => h.total >= Math.max(10, totalIn * 0.02));
      const worst = (relevant.length ? relevant : used).slice().sort((a, b) => b.missRate - a.missRate || b.total - a.total)[0];
      const head = `<div class="grow"></div><div class="chips no-print" id="hourly-mode">
          <button class="chip ${avgMode ? '' : 'active'}" type="button" data-mode="total">Total</button>
          <button class="chip ${avgMode ? 'active' : ''}" type="button" data-mode="avg">Média por dia</button></div>`;
      const heat = card('Chamadas recebidas: dia da semana × hora',
        `<div class="table-wrap"><div class="heat" style="grid-template-columns:44px repeat(${cols}, minmax(0, 1fr))">${grid}</div></div>
         <div class="heat-scale" style="margin-top:10px">0<span class="ramp"></span>${avgMode ? max.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : fmtInt(max)} ${avgMode ? 'por dia' : 'ligações'}</div>`,
        { head });
      const callout = `<div class="callout">${icon('clock')}<span>Pico: <b>${WEEKDAYS[pk.weekday]} das ${pad(pk.hour)}h às ${pad(pk.hour)}h59</b> (${fmtInt(pk.count)} recebidas no período). Maior taxa de perda: <b>${pad(worst.hour)}h</b> (${fmtPct(worst.missRate)}).</span></div>`;
      const rows = used.map((h) => ({ ...h, avg: h.total / Math.max(days, 1) }));
      const hourTable = card('Recebidas por hora', table('hr-hours', [
        { key: 'hour', label: 'Hora', fmt: (r) => `${pad(r.hour)}:00 – ${pad(r.hour)}:59` },
        { key: 'total', label: 'Recebidas', num: true, fmt: (r) => fmtInt(r.total) },
        { key: 'avg', label: 'Média por dia', num: true, fmt: (r) => r.avg.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) },
        { key: 'missed', label: 'Perdidas', num: true, fmt: (r) => fmtInt(r.missed) },
        { key: 'missRate', label: '% perdidas', num: true, fmt: (r) => `<span class="badge ${r.missRate <= 5 ? 'good' : r.missRate <= 15 ? 'warn' : 'bad'}">${fmtPct(r.missRate)}</span>` },
        { key: 'share', label: '% do dia', num: true, sort: (r) => r.total, fmt: (r) => shareBar(Math.round((1000 * r.total) / totalIn) / 10) },
      ], rows, { sortKey: 'hour', desc: false }));
      return `${callout}${heat}${hourTable}`;
    },

    agents(d) {
      charts = [];
      const list = d.agents;
      if (!list.length) return card('Sem dados', emptyBox('Nenhuma ligação de ramal no período selecionado.'));
      const sum = (k) => list.reduce((s, r) => s + r[k], 0);
      const top = list.slice(0, 20);
      const chart = card('Atendidas e realizadas por ramal', chartBox({
        id: 'ch-agents', labels: top.map((r) => r.ext), titles: top.map((r) => (r.name ? `${r.name} (${r.ext})` : `Ramal ${r.ext}`)),
        series: [
          { key: 'inAnswered', label: 'Recebidas atendidas', color: COLORS.in, stack: 'in' },
          { key: 'out', label: 'Realizadas', color: COLORS.out, stack: 'out' },
        ],
        rows: top, aria: 'Atendidas e realizadas por ramal',
        extra: (r) => `<div class="row"><span>TMA</span><b>${fmtSec(r.avgTalk)}</b></div>`,
      }), { head: `<div class="grow"></div>${legend([['sw-in', 'Recebidas atendidas'], ['sw-out', 'Realizadas']])}`, hint: list.length > 20 ? 'Os 20 ramais com mais ligações' : '' });
      const inAns = sum('inAnswered');
      const talkCount = inAns + sum('outAnswered');
      const tbl = table('ag', [
        { key: 'ext', label: 'Ramal', fmt: (r) => `<div class="who"><b>${esc(r.name || `Ramal ${r.ext}`)}</b><span>${r.name ? `Ramal ${esc(r.ext)}` : ''}</span></div>` },
        { key: 'inAnswered', label: 'Atendidas', num: true, fmt: (r) => fmtInt(r.inAnswered) },
        { key: 'inNotAnswered', label: 'Não atendeu', num: true, fmt: (r) => fmtInt(r.inNotAnswered) },
        { key: 'out', label: 'Realizadas', num: true, fmt: (r) => fmtInt(r.out) },
        { key: 'outAnswered', label: 'Realiz. atend.', num: true, fmt: (r) => fmtInt(r.outAnswered) },
        { key: 'internal', label: 'Internas', num: true, fmt: (r) => fmtInt(r.internal) },
        { key: 'talkTotal', label: 'Tempo falado', num: true, fmt: (r) => fmtSec(r.talkTotal) },
        { key: 'avgTalk', label: 'TMA', num: true, fmt: (r) => fmtSec(r.avgTalk) },
        { key: 'avgWait', label: 'TME', num: true, fmt: (r) => (r.inAnswered ? fmtSec(r.avgWait) : '—') },
        { key: 'serviceLevel', label: `NS ${d.sla}s`, num: true, fmt: (r) => (r.inAnswered ? slaBadge(r.serviceLevel) : '—') },
        { key: 'share', label: 'Participação', num: true, fmt: (r) => shareBar(r.share) },
      ], list, {
        sortKey: 'inAnswered',
        foot: {
          ext: `Total (${list.length} ramais)`, inAnswered: fmtInt(inAns), inNotAnswered: fmtInt(sum('inNotAnswered')),
          out: fmtInt(sum('out')), outAnswered: fmtInt(sum('outAnswered')), internal: fmtInt(sum('internal')),
          talkTotal: fmtSec(sum('talkTotal')), avgTalk: fmtSec(talkCount ? sum('talkTotal') / talkCount : 0),
        },
      });
      return chart + card('Desempenho por ramal', tbl, {
        hint: 'Não atendeu: recebidas que tocaram no ramal e ninguém atendeu. TMA: tempo médio de conversa (recebidas + realizadas atendidas). TME: espera média até o ramal atender. NS: % das atendidas pelo ramal dentro do tempo de nível de serviço. Clique nos títulos para ordenar.',
      });
    },

    queues(d) {
      charts = [];
      const t = d.totals;
      if (!d.queues.length) {
        return card('Nenhuma fila no período', emptyBox('Não há ligações que passaram por filas (aplicação Queue do Issabel) no período selecionado.', 'layers'));
      }
      const kpis = `<div class="kpis auto">
        ${kpi('k4', 'in', fmtInt(t.offered), 'Oferecidas às filas')}
        ${kpi('k1', 'check', fmtInt(t.answered), 'Atendidas', fmtPct(t.offered ? (1000 * t.answered / t.offered | 0) / 10 : 0))}
        ${kpi('k2', 'missed', fmtInt(t.abandoned), 'Abandonadas', fmtPct(t.abandonRate))}
        ${kpi('k1', 'target', fmtPct(t.serviceLevel), 'Nível de serviço', `atendidas em até ${d.sla}s`)}
        ${kpi('k3', 'hourglass', fmtSec(t.avgWait), 'TME — espera média')}
      </div>`;
      const tbl = table('qs', [
        { key: 'queue', label: 'Fila', fmt: (r) => `<b>Fila ${esc(r.queue)}</b>` },
        { key: 'offered', label: 'Oferecidas', num: true, fmt: (r) => fmtInt(r.offered) },
        { key: 'answered', label: 'Atendidas', num: true, fmt: (r) => fmtInt(r.answered) },
        { key: 'abandoned', label: 'Abandonadas', num: true, fmt: (r) => fmtInt(r.abandoned) },
        { key: 'answerRate', label: '% atend.', num: true, fmt: (r) => fmtPct(r.answerRate) },
        { key: 'abandonRate', label: '% aband.', num: true, fmt: (r) => `<span class="badge ${r.abandonRate <= 5 ? 'good' : r.abandonRate <= 10 ? 'warn' : 'bad'}">${fmtPct(r.abandonRate)}</span>` },
        { key: 'serviceLevel', label: `NS ${d.sla}s`, num: true, fmt: (r) => slaBadge(r.serviceLevel) },
        { key: 'avgWait', label: 'TME', num: true, fmt: (r) => fmtSec(r.avgWait) },
        { key: 'avgAbandonWait', label: 'Espera até abandonar', num: true, fmt: (r) => fmtSec(r.avgAbandonWait) },
        { key: 'maxWait', label: 'Espera máx.', num: true, fmt: (r) => fmtSec(r.maxWait) },
        { key: 'avgTalk', label: 'TMA', num: true, fmt: (r) => fmtSec(r.avgTalk) },
      ], d.queues, { sortKey: 'offered' });
      const perQueue = d.queues.map((q) => card(`<span class="qhead">Fila ${esc(q.queue)} <span class="badge">${fmtInt(q.answered)} atendidas</span></span>`,
        q.agents.length ? table(`qa-${q.queue}`, [
          { key: 'ext', label: 'Ramal', fmt: (r) => `Ramal ${esc(r.ext)}` },
          { key: 'answered', label: 'Atendidas', num: true, fmt: (r) => fmtInt(r.answered) },
          { key: 'share', label: 'Participação', num: true, fmt: (r) => shareBar(r.share) },
          { key: 'talk', label: 'Tempo falado', num: true, fmt: (r) => fmtSec(r.talk) },
          { key: 'avgTalk', label: 'TMA', num: true, fmt: (r) => fmtSec(r.avgTalk) },
        ], q.agents, { sortKey: 'answered' }) : emptyBox('Nenhuma ligação atendida nesta fila.'))).join('');
      return `${kpis}${card('Resumo por fila', tbl, { hint: 'NS: % das ligações oferecidas atendidas dentro do tempo de nível de serviço. Abandonadas: o cliente desligou antes de ser atendido.' })}<div class="grid2">${perQueue}</div>`;
    },

    missed(d) {
      charts = [];
      const s = d.summary;
      const kpis = `<div class="kpis cols3">
        ${kpi('k2', 'missed', fmtInt(s.total), 'Chamadas perdidas', `${fmtInt(s.uniqueNumbers)} números diferentes`)}
        ${kpi('k1', 'callback', fmtInt(s.returned), 'Retornadas pela equipe', 'retorno atendido')}
        ${kpi('k4', 'in', fmtInt(s.recalled), 'Cliente ligou de novo', 'e foi atendido')}
        ${kpi('k3', 'out', fmtInt(s.attempted), 'Tentativa sem sucesso', 'retorno não atendido')}
        ${kpi('k2', 'hourglass', fmtInt(s.pending), 'Pendentes', 'sem nenhum retorno')}
        ${kpi('k5', 'clock', s.returned + s.recalled ? fmtLong(s.avgReturn) : '—', 'Tempo médio de retorno', `espera antes de desligar ${fmtSec(s.avgWait)}`)}
      </div>`;
      if (!s.total) return kpis + card('Nenhuma chamada perdida', emptyBox('Nenhuma chamada recebida deixou de ser atendida no período.', 'check'));
      const RET = {
        returned: ['good', 'Retornada'], recalled: ['good', 'Cliente religou'], attempted: ['warn', 'Tentativa sem sucesso'], pending: ['bad', 'Pendente'],
      };
      const f = missedView.filter;
      const list = d.records.filter((r) => f === 'all' || r.returned === f);
      const chips = `<div class="grow"></div><div class="chips no-print" id="missed-filter">${[['all', 'Todas'], ['pending', 'Pendentes'], ['attempted', 'Tentativa sem sucesso'], ['returned', 'Retornadas'], ['recalled', 'Cliente religou']]
        .map(([k, l]) => `<button class="chip ${f === k ? 'active' : ''}" type="button" data-missed="${k}">${l}</button>`).join('')}</div>`;
      const tbl = table('ms', [
        { key: 'calldate', label: 'Data e hora', fmt: (r) => fmtDateTime(r.calldate) },
        { key: 'number', label: 'Cliente', fmt: (r) => `<div class="who"><b class="num">${esc(r.name || r.number || 'Desconhecido')}</b><span>${r.name ? esc(r.number) : ''}</span></div>` },
        { key: 'dest', label: 'Destino', sort: (r) => r.queue || r.rang.join(','), fmt: (r) => (r.queue ? `Fila ${esc(r.queue)}` : r.rang.length ? `Ramal ${esc(r.rang.join(', '))}` : '—') },
        { key: 'wait', label: 'Esperou', num: true, fmt: (r) => fmtSec(r.wait) },
        { key: 'returned', label: 'Situação', fmt: (r) => `<span class="badge ${RET[r.returned][0]}">${RET[r.returned][1]}</span>` },
        { key: 'callback', label: 'Retorno', sort: (r) => (r.callback ? r.callback.calldate : ''), fmt: (r) => (r.callback
          ? `<div class="who"><b>${fmtDateTime(r.callback.calldate)}</b><span>${r.callback.ext ? `ramal ${esc(r.callback.ext)} · ` : ''}após ${fmtLong(r.returnSeconds)}</span></div>` : '—') },
      ], list, { sortKey: 'calldate', limit: missedView.shown });
      const more = list.length > missedView.shown
        ? `<div class="more-row"><button class="btn" type="button" id="missed-more">Mostrar mais (${fmtInt(list.length - missedView.shown)} restantes)</button></div>` : '';
      return kpis + card(`Chamadas perdidas <span class="badge">${fmtInt(list.length)}</span>`, tbl + more, {
        head: chips,
        hint: `Considera retorno o contato com o mesmo número em até ${d.window}h depois da perda, dentro do período do relatório. A exportação CSV inclui todas as linhas.`,
      });
    },

    top(d) {
      charts = [];
      const callers = table('tp-in', [
        { key: 'rank', label: '#', nosort: true, fmt: (r, i) => i + 1 },
        { key: 'number', label: 'Número', fmt: (r) => `<div class="who"><b class="num">${esc(r.name || r.number)}</b><span>${r.name ? esc(r.number) : ''}</span></div>` },
        { key: 'calls', label: 'Ligações', num: true, fmt: (r) => fmtInt(r.calls) },
        { key: 'answered', label: 'Atendidas', num: true, fmt: (r) => fmtInt(r.answered) },
        { key: 'missed', label: 'Perdidas', num: true, fmt: (r) => (r.missed ? `<span class="badge bad">${fmtInt(r.missed)}</span>` : '0') },
        { key: 'talk', label: 'Tempo falado', num: true, fmt: (r) => fmtSec(r.talk) },
        { key: 'lastCall', label: 'Última', fmt: (r) => fmtDateTime(r.lastCall) },
      ], d.callers, { sortKey: 'calls' });
      const dialed = table('tp-out', [
        { key: 'rank', label: '#', nosort: true, fmt: (r, i) => i + 1 },
        { key: 'number', label: 'Número', fmt: (r) => `<b class="num">${esc(r.number)}</b>` },
        { key: 'calls', label: 'Ligações', num: true, fmt: (r) => fmtInt(r.calls) },
        { key: 'answered', label: 'Atendidas', num: true, fmt: (r) => fmtInt(r.answered) },
        { key: 'talk', label: 'Tempo falado', num: true, fmt: (r) => fmtSec(r.talk) },
        { key: 'lastCall', label: 'Última', fmt: (r) => fmtDateTime(r.lastCall) },
      ], d.dialed, { sortKey: 'calls' });
      return `<div class="grid2">
        ${card('Quem mais liga para a central', d.callers.length ? callers : emptyBox('Nenhuma ligação recebida no período.'), { hint: 'Os 20 números com mais ligações recebidas' })}
        ${card('Números mais discados', d.dialed.length ? dialed : emptyBox('Nenhuma ligação realizada no período.'), { hint: 'Os 20 números mais chamados pelos ramais' })}
      </div>`;
    },

    detail(d) {
      charts = [];
      const chips = `<div class="chips no-print" id="detail-dir">${[['all', 'Todas'], ['in', 'Recebidas'], ['out', 'Realizadas'], ['internal', 'Internas']]
        .map(([k, l]) => `<button class="chip ${detail.direction === k ? 'active' : ''}" type="button" data-dir="${k}">${l}</button>`).join('')}</div>
        <select class="input no-print" id="detail-status" aria-label="Status" style="width:auto;height:34px">
          ${[['all', 'Todos os status'], ['answered', 'Atendidas'], ['notanswered', 'Não atendidas (todas)'], ['missed', 'Perdidas (recebidas)'], ['noanswer', 'Não atendidas (realizadas)'], ['busy', 'Ocupado'], ['failed', 'Falhou']]
            .map(([k, l]) => `<option value="${k}" ${detail.status === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <div class="grow"></div>
        <label class="search no-print">${icon('search')}<input class="input" id="detail-search" type="search" inputmode="tel" placeholder="Número ou ramal" value="${esc(detail.search)}"></label>`;
      const rows = detail.records;
      const kind = (r) => (r.status === 'missed' ? 'missed' : r.direction);
      const body = rows.length ? `<div class="table-wrap"><table class="rtable"><thead><tr>
          <th>Tipo</th><th>Data e hora</th><th>Origem</th><th>Destino</th><th>Atendido por</th><th class="n">Espera</th><th class="n">Conversa</th><th>Status</th>
        </tr></thead><tbody>${rows.map((r) => {
          const from = r.direction === 'in' ? `<div class="who"><b class="num">${esc(r.name || r.number || 'Desconhecido')}</b><span>${r.name ? esc(r.number) : ''}</span></div>` : `Ramal ${esc(r.origin || '—')}`;
          const to = r.direction === 'in' ? (r.queue ? `Fila ${esc(r.queue)}` : r.rang.length ? `Ramal ${esc(r.rang.join(', '))}` : '—') : `<span class="num">${esc(r.number)}</span>${r.queue && r.direction === 'internal' ? ' (fila)' : ''}`;
          const by = r.agent && r.status === 'answered' ? `Ramal ${esc(r.agent)}` : '—';
          return `<tr>
            <td><div class="dir ${kind(r)}" title="${esc(DIR_LABEL[r.direction])}">${icon(kind(r))}</div></td>
            <td class="num">${fmtDateTime(r.calldate)}</td><td>${from}</td><td>${to}</td><td>${by}</td>
            <td class="n">${fmtSec(r.wait)}</td><td class="n">${r.talk ? fmtSec(r.talk) : '—'}</td>
            <td><span class="badge ${STATUS_CLASS[r.status]}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td></tr>`;
        }).join('')}</tbody></table></div>` : emptyBox('Nenhuma ligação encontrada com esses filtros.');
      const more = detail.hasMore ? `<div class="more-row"><button class="btn" type="button" id="detail-more">Carregar mais</button></div>` : '';
      return card(`Ligações <span class="badge">${fmtInt(detail.total)}</span>`, `${body}${more}<div class="table-note">Mostrando ${fmtInt(rows.length)} de ${fmtInt(detail.total)}. Use “Exportar CSV” para baixar todas.</div>`, { head: chips });
    },
  };

  // Interações dentro dos relatórios
  $('#report').addEventListener('click', (e) => {
    const mode = e.target.closest('#hourly-mode [data-mode]');
    if (mode) { hourlyView.mode = mode.dataset.mode; render(); return; }
    const mf = e.target.closest('[data-missed]');
    if (mf) { missedView.filter = mf.dataset.missed; missedView.shown = 50; render(); return; }
    if (e.target.closest('#missed-more')) { missedView.shown += 100; render(); return; }
    const dir = e.target.closest('[data-dir]');
    if (dir) { detail.direction = dir.dataset.dir; runReport(); return; }
    if (e.target.closest('#detail-more')) { detail.offset += 100; runReport({ append: true }); }
  });
  $('#report').addEventListener('change', (e) => {
    if (e.target.id === 'detail-status') { detail.status = e.target.value; runReport(); }
  });
  let searchTimer;
  $('#report').addEventListener('input', (e) => {
    if (e.target.id !== 'detail-search') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      detail.search = e.target.value.trim();
      await runReport();
      const input = $('#detail-search');
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }, 400);
  });
  // Dica do mapa de calor
  $('#report').addEventListener('mousemove', (e) => {
    const cell = e.target.closest('[data-tip]');
    if (!cell) { if (!e.target.closest('.chart')) hideTip(); return; }
    const [title, ...lines] = cell.dataset.tip.split('|');
    showTip(e, `<b>${esc(title)}</b>${lines.map((l) => { const [k, v] = l.split(': '); return `<div class="row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`; }).join('')}`);
  });
  $('#report').addEventListener('mouseleave', hideTip);

  // ---------- Exportação CSV ----------
  const CSV = {
    overview: (d) => [['Dia', 'Recebidas', 'Recebidas atendidas', 'Perdidas', 'Realizadas', 'Internas'],
      ...d.byDay.map((r) => [fmtDateBR(r.date), r.in, r.inAnswered, r.missed, r.out, r.internal])],
    hourly: (d) => [['Dia da semana', ...Array.from({ length: 24 }, (_, h) => `${pad(h)}h`)],
      ...WEEK_ORDER.map((w) => [WEEKDAYS[w], ...d.matrix[w]])],
    agents: (d) => [['Ramal', 'Nome', 'Atendidas', 'Tocou e não atendeu', 'Realizadas', 'Realizadas atendidas', 'Internas', 'Tempo falado', 'TMA', 'TME', 'Nível de serviço (%)', 'Participação (%)', 'Última ligação'],
      ...d.agents.map((r) => [r.ext, r.name, r.inAnswered, r.inNotAnswered, r.out, r.outAnswered, r.internal, fmtSec(r.talkTotal), fmtSec(r.avgTalk), fmtSec(r.avgWait), r.serviceLevel, r.share, r.lastCall])],
    queues: (d) => [['Fila', 'Oferecidas', 'Atendidas', 'Abandonadas', '% atendidas', '% abandonadas', 'Nível de serviço (%)', 'TME', 'Espera até abandonar', 'Espera máxima', 'TMA'],
      ...d.queues.map((q) => [q.queue, q.offered, q.answered, q.abandoned, q.answerRate, q.abandonRate, q.serviceLevel, fmtSec(q.avgWait), fmtSec(q.avgAbandonWait), fmtSec(q.maxWait), fmtSec(q.avgTalk)])],
    missed: (d) => [['Data e hora', 'Número', 'Nome', 'Fila', 'Ramais que tocaram', 'Esperou', 'Situação', 'Retorno em', 'Ramal do retorno', 'Tempo até o retorno'],
      ...d.records.map((r) => [r.calldate, r.number, r.name, r.queue || '', r.rang.join(' '), fmtSec(r.wait),
        { returned: 'Retornada', recalled: 'Cliente religou', attempted: 'Tentativa sem sucesso', pending: 'Pendente' }[r.returned],
        r.callback ? r.callback.calldate : '', r.callback ? r.callback.ext || '' : '', r.returnSeconds != null ? fmtSec(r.returnSeconds) : ''])],
    top: (d) => [['Tipo', 'Número', 'Nome', 'Ligações', 'Atendidas', 'Perdidas', 'Tempo falado', 'Última'],
      ...d.callers.map((r) => ['Recebida', r.number, r.name, r.calls, r.answered, r.missed, fmtSec(r.talk), r.lastCall]),
      ...d.dialed.map((r) => ['Realizada', r.number, '', r.calls, r.answered, r.missed, fmtSec(r.talk), r.lastCall])],
    detail: (d) => [['Data e hora', 'Tipo', 'Número', 'Nome', 'Ramal de origem', 'Atendido por', 'Fila', 'Status', 'Espera', 'Conversa'],
      ...d.records.map((r) => [r.calldate, DIR_LABEL[r.direction], r.number, r.name, r.origin || '', r.status === 'answered' ? r.agent || '' : '', r.queue || '', STATUS_LABEL[r.status], fmtSec(r.wait), fmtSec(r.talk)])],
  };

  $('#export-btn').addEventListener('click', async () => {
    const type = state.view;
    let d = state.data;
    if (!d || d.report !== type) return toast('Gere o relatório antes de exportar', 'err');
    try {
      if (type === 'detail') d = await api('GET', `/api/reports/detail?${queryString('detail', { offset: 0, limit: 'all' })}`);
      const rows = CSV[type](d);
      const cell = (v) => {
        const s = String(v ?? '');
        return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      // Separador ";" e BOM: abre direto no Excel em português
      const csv = `﻿${rows.map((r) => r.map((v) => cell(typeof v === 'number' ? String(v).replace('.', ',') : v)).join(';')).join('\r\n')}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = `relatorio-${type}-${d.from}${d.to !== d.from ? `_${d.to}` : ''}.csv`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  $('#print-btn').addEventListener('click', () => {
    const d = state.data;
    if (!d || d.report !== state.view) return toast('Gere o relatório antes de imprimir', 'err');
    $('#p-title').textContent = REPORTS[state.view].title;
    const parts = [`Período: ${fmtDateBR(d.from)}${d.to !== d.from ? ` a ${fmtDateBR(d.to)}` : ''}`];
    if (d.ext) parts.push(`Ramal ${d.ext}`);
    if (d.queue) parts.push(`Fila ${d.queue}`);
    if (REPORTS[state.view].opts.includes('sla')) parts.push(`Nível de serviço: ${d.sla}s`);
    parts.push(`Emitido em ${new Date().toLocaleString('pt-BR')} por ${state.me.name}`);
    $('#p-meta').textContent = parts.join(' · ');
    window.print();
  });

  // ---------- Usuários ----------
  async function loadUsers() {
    try {
      state.users = (await api('GET', '/api/users')).users;
      renderUsers();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function renderUsers() {
    $('#users-body').innerHTML = state.users.map((u) => `<tr>
      <td><div class="me-row"><div class="avatar">${initials(u.name)}</div><b>${esc(u.name)}</b></div></td>
      <td>${esc(u.username)}</td>
      <td><span class="badge ${esc(u.role)}">${esc(ROLE_LABEL[u.role] || u.role)}</span></td>
      <td>${u.active ? '<span class="badge">Ativo</span>' : '<span class="badge inactive">Inativo</span>'}</td>
      <td style="text-align:right">
        <button class="btn btn-icon btn-ghost" type="button" data-edit-user="${esc(u.id)}" title="Editar">${icon('edit')}</button>
        ${u.id === state.me.id ? '' : `<button class="btn btn-icon btn-ghost" type="button" data-del-user="${esc(u.id)}" title="Excluir">${icon('trash')}</button>`}
      </td>
    </tr>`).join('');
  }

  function openUserModal(user) {
    state.editingUser = user || null;
    $('#user-form').reset();
    $('#user-error').textContent = '';
    $('#user-modal-title').textContent = user ? 'Editar usuário' : 'Novo usuário';
    $('#u-password').required = !user;
    $('#u-password').placeholder = user ? 'Deixe em branco para manter' : '';
    if (user) {
      $('#u-name').value = user.name;
      $('#u-username').value = user.username;
      $('#u-role').value = user.role;
      $('#u-active').checked = user.active;
    }
    $('#user-modal').hidden = false;
    $('#u-name').focus();
  }

  $('#new-user-btn').addEventListener('click', () => openUserModal());
  $('#users-body').addEventListener('click', async (e) => {
    const edit = e.target.closest('[data-edit-user]');
    if (edit) return openUserModal(state.users.find((u) => u.id === edit.dataset.editUser));
    const del = e.target.closest('[data-del-user]');
    if (del) {
      const u = state.users.find((x) => x.id === del.dataset.delUser);
      if (!confirm(`Excluir o usuário ${u.name}?`)) return;
      try {
        await api('DELETE', `/api/users/${encodeURIComponent(u.id)}`);
        toast('Usuário excluído');
        loadUsers();
      } catch (err) {
        toast(err.message, 'err');
      }
    }
  });

  $('#user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      name: $('#u-name').value.trim(),
      username: $('#u-username').value.trim().toLowerCase(),
      role: $('#u-role').value,
      active: $('#u-active').checked,
    };
    const pwd = $('#u-password').value;
    if (pwd) body.password = pwd;
    try {
      const editing = state.editingUser;
      const { user } = editing
        ? await api('PUT', `/api/users/${encodeURIComponent(editing.id)}`, body)
        : await api('POST', '/api/users', body);
      $('#user-modal').hidden = true;
      toast(editing ? 'Usuário atualizado' : 'Usuário criado');
      if (user.id === state.me.id) { state.me = user; showApp(); }
      loadUsers();
    } catch (err) {
      $('#user-error').textContent = err.message;
    }
  });

  $$('.modal-backdrop').forEach((m) => {
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) m.hidden = true;
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $$('.modal-backdrop').forEach((m) => { m.hidden = true; });
  });

  // ---------- Navegação ----------
  function route() {
    let view = (location.hash || '#overview').slice(1);
    if (view === 'usuarios' && state.me.role !== 'admin') view = 'overview';
    if (view !== 'usuarios' && !REPORTS[view]) view = 'overview';
    const changed = state.view !== view;
    state.view = view;
    const isReport = view !== 'usuarios';
    $('#view-reports').hidden = !isReport;
    $('#view-usuarios').hidden = isReport;
    $('#view-title').textContent = isReport ? REPORTS[view].title : 'Usuários';
    $('#view-desc').textContent = isReport ? REPORTS[view].desc : 'Acesso ao sistema de relatórios';
    document.title = `${isReport ? REPORTS[view].title : 'Usuários'} · Supervisor Intek`;
    $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    $('.shell').classList.remove('nav-open');
    if (!isReport) return loadUsers();
    $$('[data-opt]').forEach((el) => { el.hidden = !REPORTS[view].opts.includes(el.dataset.opt); });
    if (changed || !state.data) { state.data = null; charts = []; }
    runReport();
  }
  window.addEventListener('hashchange', () => state.me && route());
  $('#menu-btn').addEventListener('click', () => $('.shell').classList.toggle('nav-open'));

  // ---------- Tema ----------
  const savedTheme = (() => { try { return localStorage.getItem('sv-theme'); } catch { return null; } })();
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#theme-btn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('sv-theme', next); } catch { /* ignora */ }
  });

  // ---------- Início ----------
  applyPreset('today');
  state.view = '';
  api('GET', '/api/me')
    .then(({ user }) => { state.me = user; showApp(); })
    .catch(() => showLogin());
})();
