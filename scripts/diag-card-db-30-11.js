// Somente leitura: trilha do deal no Postgres (auditoria + tracking PCI12). Uso: node scripts/diag-card-db-30-11.js <dealId>
require("dotenv").config({ quiet: true });
const db = require("../src/database");
const { QueryTypes } = require("sequelize");
(async () => {
  const id = process.argv[2];
  const q = (sql) => db.sequelize.query(sql, { replacements: { id }, type: QueryTypes.SELECT });
  console.log("AUDIT:", JSON.stringify(await q(`SELECT "createdAt", action, * FROM "AuditLogs" WHERE entity_id = :id ORDER BY "createdAt"`), null, 1));
  console.log("TRACKING:", JSON.stringify(await q(`SELECT * FROM bmax_pci12_tracking WHERE deal_id = :id`)));
  console.log("PRAZO12A:", JSON.stringify(await q(`SELECT * FROM bmax_pci12a_prazo WHERE deal_id = :id`)));
  process.exit(0);
})().catch(e => { console.error("ERRO", e.message); process.exit(1); });
