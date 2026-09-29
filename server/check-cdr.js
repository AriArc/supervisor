'use strict';

// Diagnóstico da conexão com o banco de CDR do Issabel.
// Uso: npm run check-cdr
const config = require('./config');
const { MysqlCdr, ReportService, describeCdrError, localToday } = require('./cdr');

(async () => {
  const db = config.cdrDb;
  if (!db) {
    console.error('✗ CDR_DB_HOST não está definido no .env — os relatórios ficam desativados.');
    process.exit(1);
  }
  console.log(`Conectando em ${db.socketPath ? `socket ${db.socketPath}` : `${db.host}:${db.port}`} ` +
    `como '${db.user}' (senha ${db.password ? 'definida' : 'VAZIA'}), banco ${db.database}.${db.table}…`);

  let cdr;
  try {
    cdr = new MysqlCdr(db);
    const [[info]] = await cdr.pool.query(
      `SELECT COUNT(*) AS total, MAX(calldate) AS ultima FROM \`${db.table}\``);
    console.log(`✓ Conexão OK — ${info.total} registros no CDR, último em ${info.ultima || '—'}`);
    const [grants] = await cdr.pool.query('SHOW GRANTS');
    for (const g of grants) console.log(`  ${String(Object.values(g)[0]).replace(/ IDENTIFIED BY PASSWORD '[^']*'/, '')}`);

    // Resumo dos últimos 7 dias usando o mesmo cálculo da tela de relatórios
    const to = localToday();
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 6);
    const res = await new ReportService(cdr, config.reports).run('overview', { from: d.toISOString().slice(0, 10), to });
    const t = res.totals;
    console.log(`✓ Últimos 7 dias: ${t.total} ligações — ${t.in} recebidas (${t.inMissed} perdidas), ` +
      `${t.out} realizadas, ${t.internal} internas; ramais: ${res.extensions.join(', ') || 'nenhum'}; ` +
      `filas: ${res.queues.join(', ') || 'nenhuma'}`);
    if (t.total && !res.extensions.length) {
      console.log('  Nenhum ramal reconhecido. Confira EXTENSION_PATTERN e os canais das últimas ligações:');
      const [rows] = await cdr.pool.query(
        `SELECT calldate, src, dst, channel, dstchannel FROM \`${db.table}\` ORDER BY calldate DESC LIMIT 5`);
      for (const r of rows) console.log(`  ${r.calldate}  ${r.src} → ${r.dst}  [${r.channel} → ${r.dstchannel}]`);
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(`✗ Falhou: ${describeCdrError(err, db)}`);
    process.exitCode = 1;
  } finally {
    if (cdr) await cdr.pool.end().catch(() => {});
  }
})();
