// DDL aditivo e idempotente (Auditor diário, 25/11/2026). Só cria tabelas NOVAS, não altera nenhuma existente.
// O auditor nunca escreve em tabela de negócio: só nestas duas.
// Rodar UMA vez em produção, junto com o deploy:
//   node scripts/create-auditor-tables.js
require("dotenv").config({ quiet: true });
const { sequelize } = require("../src/database");

const sql = `
CREATE TABLE IF NOT EXISTS bmax_auditoria_achados (
  id BIGSERIAL PRIMARY KEY,
  chave TEXT NOT NULL UNIQUE,              -- estável: checagem + entidade (ex.: saldo_vs_razao:revenda:Luitex)
  grupo TEXT NOT NULL,                     -- dinheiro | cards | prazos | pessoas | robos
  checagem TEXT NOT NULL,
  severidade TEXT NOT NULL DEFAULT 'media' CHECK (severidade IN ('alta','media','baixa')),
  titulo TEXT NOT NULL,
  detalhe JSONB,
  link TEXT,
  acao_sugerida TEXT,
  primeira_vez TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_vez TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolvido_em TIMESTAMPTZ,
  ultimo_aviso_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auditoria_achados_abertos ON bmax_auditoria_achados (grupo) WHERE resolvido_em IS NULL;

CREATE TABLE IF NOT EXISTS bmax_auditoria_execucoes (
  id BIGSERIAL PRIMARY KEY,
  iniciado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  rodada TEXT NOT NULL DEFAULT 'manual',   -- manha | tarde | manual
  duracao_ms INTEGER,
  total_achados INTEGER NOT NULL DEFAULT 0,
  novos INTEGER NOT NULL DEFAULT 0,
  resolvidos INTEGER NOT NULL DEFAULT 0,
  avisados INTEGER NOT NULL DEFAULT 0,
  email_enviado BOOLEAN NOT NULL DEFAULT false,
  resumo JSONB,
  erro TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditoria_execucoes_data ON bmax_auditoria_execucoes (iniciado_em DESC);
`;

(async () => {
    try {
        await sequelize.query(sql);
        console.log("OK: bmax_auditoria_achados e bmax_auditoria_execucoes prontas");
        process.exit(0);
    } catch (e) {
        console.error("ERRO:", e.message);
        process.exit(1);
    }
})();
