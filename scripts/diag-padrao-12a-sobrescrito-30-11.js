// Somente leitura: cards em que a revenda escolheu "eu assumo" (BOX>REV) e depois o robô de 48h aplicou 12b.
require("dotenv").config({ quiet: true });
const db = require("../src/database");
const { QueryTypes } = require("sequelize");
const q = sql => db.sequelize.query(sql, { type: QueryTypes.SELECT });
(async () => {
  console.log("A) escolheram BOX>REV na auditoria E depois tiveram auto_12b:");
  console.log(JSON.stringify(await q(`
    SELECT a.entity_id AS deal_id, a.username, a.role, MIN(a."createdAt") AS escolheu_12a, t.auto_12b_em, t.detectado_em, t.criado_em AS tracking_criado
    FROM "AuditLogs" a JOIN bmax_pci12_tracking t ON t.deal_id = a.entity_id
    WHERE a.action = 'SELECT_CAMINHO_VENDA' AND a.metadata->>'caminho' = 'BOX>REV' AND t.auto_12b_em IS NOT NULL
    GROUP BY a.entity_id, a.username, a.role, t.auto_12b_em, t.detectado_em, t.criado_em ORDER BY 1`), null, 1));
  console.log("B) total de auto_12b por dia:");
  console.log(JSON.stringify(await q(`SELECT date_trunc('day', auto_12b_em) AS dia, count(*) FROM bmax_pci12_tracking WHERE auto_12b_em IS NOT NULL GROUP BY 1 ORDER BY 1`)));
  console.log("C) rastreados criados depois da escolha (tracking_criado > escolha) — qualquer caminho:");
  console.log(JSON.stringify(await q(`
    SELECT a.entity_id AS deal_id, a.metadata->>'caminho' AS caminho, a."createdAt" AS escolheu, t.criado_em AS tracking_criado, t.auto_12b_em, t.resolvido_em
    FROM "AuditLogs" a JOIN bmax_pci12_tracking t ON t.deal_id = a.entity_id
    WHERE a.action = 'SELECT_CAMINHO_VENDA' AND t.criado_em > a."createdAt" ORDER BY a."createdAt"`), null, 1));
  process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
