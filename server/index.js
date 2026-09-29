'use strict';

const http = require('http');
const config = require('./config');
const { UserStore } = require('./users');
const { createApp } = require('./app');
const { MysqlCdr, MockCdr, ReportService } = require('./cdr');

const users = new UserStore(config.dataFile);
const admin = users.ensureAdmin(config.admin);
if (admin) console.log(`[users] administrador inicial criado: ${admin.username}`);
if (config.sessionSecret === 'dev-secret-change-me') {
  console.warn('[config] SESSION_SECRET não definido — use um valor próprio em produção');
}

let source = null;
if (config.mock) source = new MockCdr();
else if (config.cdrDb) source = new MysqlCdr(config.cdrDb, { maxRows: config.reports.maxRows });
else console.warn('[cdr] CDR_DB_HOST não definido — os relatórios ficarão indisponíveis');

const reports = source ? new ReportService(source, config.reports) : null;
const app = createApp({ config, users, reports, cdrDb: source && source.dbConfig });
const server = http.createServer(app);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[http] a porta ${config.port} já está em uso por outro programa (veja: ss -ltnp | grep ${config.port})`);
  } else {
    console.error('[http]', err.message);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`Supervisor Intek em http://${config.host}:${config.port} ${config.mock ? '(CDR simulado)' : ''}`);
});
