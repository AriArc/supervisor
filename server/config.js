'use strict';

const fs = require('fs');
const path = require('path');

// Carrega um arquivo .env simples (CHAVE=valor), sem sobrescrever variáveis já definidas.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

const env = process.env;

module.exports = {
  port: Number(env.PORT || 8444),
  host: env.HOST || '0.0.0.0',
  sessionSecret: env.SESSION_SECRET || 'dev-secret-change-me',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS || 12),
  dataFile: env.DATA_FILE || path.join(__dirname, '..', 'data', 'users.json'),

  mock: env.MOCK_CDR === '1' || env.MOCK_CDR === 'true',

  // Banco de CDR do Issabel. Sem CDR_DB_HOST, os relatórios ficam indisponíveis.
  cdrDb: env.CDR_DB_HOST
    ? {
        host: env.CDR_DB_HOST,
        port: Number(env.CDR_DB_PORT || 3306),
        user: env.CDR_DB_USER || 'supervisor',
        password: env.CDR_DB_PASSWORD || '',
        database: env.CDR_DB_NAME || 'asteriskcdrdb',
        table: env.CDR_DB_TABLE || 'cdr',
        socketPath: env.CDR_DB_SOCKET || undefined,
      }
    : null,

  reports: {
    // Formato do número de ramal (canais PJSIP/1001-..., SIP/1001-...). Troncos com outros nomes ficam de fora.
    extensionPattern: env.EXTENSION_PATTERN || '^\\d{2,6}$',
    // Nível de serviço padrão: % de chamadas atendidas em até N segundos
    slaSeconds: Number(env.SLA_SECONDS || 20),
    maxDays: Number(env.REPORT_MAX_DAYS || 366),
    maxRows: Number(env.REPORT_MAX_ROWS || 500000),
  },

  admin: {
    username: env.ADMIN_USER || 'admin',
    password: env.ADMIN_PASSWORD || 'admin123',
  },
};
