# Supervisor Intek — Issabel

Tela de **relatórios de chamadas** para supervisores de central de atendimento com PABX **Issabel/Asterisk**,
com a mesma identidade visual do [Switchboard Intek](https://github.com/AriArc/switchboard_issabel)
(cores Intek, menu lateral verde-petróleo, tema claro/escuro).

Ao entrar com um usuário do perfil **Supervisor**, o sistema abre direto na tela de relatórios.

## Relatórios

Todos os relatórios têm filtro de período (Hoje, Ontem, 7 dias, 30 dias, Este mês, Mês anterior ou datas livres),
filtro por **ramal** e por **fila**, exportação **CSV** (abre direto no Excel) e **Imprimir / PDF** com cabeçalho
Intek, período, filtros e quem emitiu.

| Relatório | O que mostra |
|---|---|
| **Visão geral** | Recebidas, taxa de atendimento, nível de serviço, TME (espera média), TMA (conversa média), realizadas, internas; gráficos por dia e por hora; resultado das ligações; resumo por dia |
| **Por horário** | Mapa de calor dia da semana × hora das chamadas recebidas (total ou média por dia), pico de movimento e taxa de perda por hora: base para montar a escala da equipe |
| **Por ramal** | Por ramal: atendidas, recebidas que tocaram e ninguém atendeu, realizadas, internas, tempo falado, TMA, TME, nível de serviço e participação |
| **Filas** | Por fila: oferecidas, atendidas, abandonadas, % de abandono, nível de serviço, TME, tempo até abandonar, espera máxima, TMA e distribuição por ramal |
| **Perdidas e retorno** | Cada chamada perdida e se houve retorno (a equipe retornou e o cliente atendeu, o cliente ligou de novo e foi atendido, tentativa sem sucesso ou pendente), com o tempo até o retorno |
| **Principais números** | Os 20 números que mais ligam para a central e os 20 mais discados |
| **Detalhado** | Todas as ligações do período com filtros de tipo, status e número/ramal; exportação completa |

Definições usadas:

- **Nível de serviço (NS)**: % das chamadas recebidas atendidas em até N segundos (padrão 20s, ajustável na tela).
- **TME**: tempo médio de espera até o atendimento (inclui o tempo na fila e o toque).
- **TMA**: tempo médio de conversa das chamadas atendidas.
- **Perdida / abandonada**: chamada recebida que ninguém atendeu.
- **Retorno**: contato com o mesmo número (comparado pelos últimos 8 dígitos) em até N horas depois da perda
  (padrão 24h, ajustável), dentro do período do relatório.

## De onde vêm os dados

Os relatórios são calculados a partir da tabela `cdr` do banco `asteriskcdrdb` do Issabel (somente leitura).
As várias linhas que o Asterisk grava para uma mesma ligação (grupos de toque, filas, pernas `Local/`) são
agrupadas pelo `uniqueid`, e cada ligação é classificada como:

- **Recebida**: começou em um tronco (o canal de origem não é um ramal);
- **Realizada**: saiu de um ramal para um número externo;
- **Interna**: ramal para ramal, fila ou código de serviço.

Ramais são reconhecidos pelos canais `PJSIP/<ramal>-…`, `SIP/<ramal>-…` e `Local/<ramal>@…`, com o número no
formato de `EXTENSION_PATTERN` (padrão: 2 a 6 dígitos). Filas são identificadas pela aplicação `Queue`
(contexto `ext-queues`) no CDR.

## Instalação (Issabel 5, mesma VPS do Switchboard)

Todos os comandos como `root` na VPS. Se o Switchboard já está instalado, o Node.js já está pronto.

### 1. Instalar

```bash
dnf module reset -y nodejs && dnf module enable -y nodejs:20 && dnf install -y nodejs git   # se ainda não tiver

useradd --system --home-dir /opt/supervisor --shell /sbin/nologin supervisor-intek
git clone https://github.com/AriArc/supervisor.git /opt/supervisor
cd /opt/supervisor
npm install --omit=dev
cp .env.example .env
chown -R supervisor-intek:supervisor-intek /opt/supervisor
chmod 600 .env
```

### 2. Usuário somente leitura do CDR

A senha de `root` do MariaDB fica em `/etc/issabel.conf` (`grep mysqlrootpwd /etc/issabel.conf`).

```sql
CREATE USER 'supervisor'@'127.0.0.1' IDENTIFIED BY 'uma-senha-forte-cdr';
CREATE USER 'supervisor'@'localhost' IDENTIFIED BY 'uma-senha-forte-cdr';
GRANT SELECT ON asteriskcdrdb.cdr TO 'supervisor'@'127.0.0.1';
GRANT SELECT ON asteriskcdrdb.cdr TO 'supervisor'@'localhost';
FLUSH PRIVILEGES;
```

Também dá para reaproveitar o usuário `switchboard` do Switchboard (ele já tem `SELECT` na mesma tabela):
basta usar `CDR_DB_USER=switchboard` e a mesma senha.

Relatórios de períodos longos leem muitas linhas. Em centrais grandes, um índice em `calldate` deixa tudo mais rápido
(o Issabel normalmente já cria; confira com `SHOW INDEX FROM asteriskcdrdb.cdr`):

```sql
CREATE INDEX calldate ON asteriskcdrdb.cdr (calldate);
```

### 3. Configurar o `.env`

```ini
PORT=8444
SESSION_SECRET=<saída de: openssl rand -hex 32>
CDR_DB_HOST=127.0.0.1
CDR_DB_USER=supervisor
CDR_DB_PASSWORD=uma-senha-forte-cdr
ADMIN_USER=admin
ADMIN_PASSWORD=<senha inicial do administrador>
```

Teste a conexão e veja um resumo dos últimos 7 dias:

```bash
cd /opt/supervisor
sudo -u supervisor-intek npm run check-cdr
```

### 4. Rodar como serviço

```bash
cp /opt/supervisor/deploy/supervisor-intek.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now supervisor-intek
systemctl status supervisor-intek
```

### 5. Firewall

Libere a porta **8444/TCP** do mesmo jeito que a 8443 do Switchboard (Firewall do Issabel, `firewalld`
e firewall do provedor). A porta 3306 continua fechada para a internet.

```bash
firewall-cmd --permanent --add-port=8444/tcp && firewall-cmd --reload   # se o firewalld estiver ativo
```

### 6. Primeiro acesso

Acesse `http://<IP-publico-da-VPS>:8444` e entre com `ADMIN_USER` / `ADMIN_PASSWORD`. Troque a senha do administrador.
Em **Usuários → Novo usuário**, cadastre os supervisores com o perfil **Supervisor**. Eles entram direto nos relatórios.

| Perfil | Acesso |
|---|---|
| **Supervisor** | Todos os relatórios |
| **Administrador** | Relatórios + cadastro de usuários |

O acesso é HTTP, sem certificado, como no Switchboard. Veja as recomendações de
[Segurança sem HTTPS](https://github.com/AriArc/switchboard_issabel#segurança-sem-https) (restringir a porta ao IP do escritório, senhas exclusivas).

## Atualizar

```bash
cd /opt/supervisor
sudo -u supervisor-intek git pull
sudo -u supervisor-intek npm install --omit=dev
systemctl restart supervisor-intek
```

O cadastro de usuários fica em `data/users.json` (inclua no backup).

## Solução de problemas

| Sintoma | Verifique |
|---|---|
| "Relatórios indisponíveis: banco de CDR não configurado" | `CDR_DB_HOST` no `.env` e `systemctl restart supervisor-intek` |
| "Não foi possível consultar o CDR: …" | A mensagem mostra a causa; rode `sudo -u supervisor-intek npm run check-cdr` |
| Tudo aparece como "Recebida" / nenhum ramal nos filtros | Os canais do CDR não batem com `EXTENSION_PATTERN` (ex.: ramais de 7+ dígitos). O `check-cdr` mostra os canais das últimas ligações |
| Relatório "Filas" vazio | O período não tem ligações que passaram pela aplicação `Queue` |
| "Período com ligações demais" | Escolha um período menor ou aumente `REPORT_MAX_ROWS` |

### Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` / `HOST` | `8444` / `0.0.0.0` | Endereço HTTP |
| `SESSION_SECRET` | — | Segredo das sessões (obrigatório em produção) |
| `SESSION_TTL_HOURS` | `12` | Duração da sessão |
| `CDR_DB_HOST` / `CDR_DB_PORT` | — / `3306` | MariaDB do Issabel |
| `CDR_DB_SOCKET` | — | Socket local do MariaDB (alternativa ao TCP) |
| `CDR_DB_USER` / `CDR_DB_PASSWORD` | — | Usuário somente leitura do CDR |
| `CDR_DB_NAME` / `CDR_DB_TABLE` | `asteriskcdrdb` / `cdr` | Banco e tabela do CDR |
| `EXTENSION_PATTERN` | `^\d{2,6}$` | Formato do número de ramal |
| `SLA_SECONDS` | `20` | Nível de serviço padrão |
| `REPORT_MAX_DAYS` | `366` | Período máximo de um relatório |
| `REPORT_MAX_ROWS` | `500000` | Máximo de linhas do CDR lidas por relatório |
| `DATA_FILE` | `data/users.json` | Cadastro de usuários |
| `MOCK_CDR` | `0` | `1` usa um CDR simulado (demonstração) |

## Demonstração sem Issabel

```bash
npm install
npm run dev     # CDR simulado: 2 filas, 12 ramais, ~300 ligações por dia útil
```

Acesse `http://localhost:8444` com `admin` / `admin123`.

## Testes

```bash
npm test
```

## Estrutura

```
server/
  index.js      servidor HTTP
  app.js        rotas da API (login, relatórios, usuários)
  cdr.js        leitura do CDR (MariaDB ou simulado), cache e validação do período
  calls.js      agrupa as linhas do CDR em ligações e classifica (recebida/realizada/interna)
  reports.js    cálculo de cada relatório
  users.js      cadastro de usuários (JSON) com hash scrypt
  auth.js       sessão por cookie assinado (HMAC)
public/         interface web (HTML/CSS/JS, sem build), mesma identidade visual do Switchboard
deploy/         serviço systemd
test/           testes (node:test)
```
