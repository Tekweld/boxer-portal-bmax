// TESTE SOMENTE LEITURA do enriquecimento do extrato (NF do ZEN pela tag bmax + % de comissão).
// Uso: node scripts/teste-extrato-nf-pct-5-11-2026.js <.env com ZEN_EMAIL/ZEN_SENHA>
require("dotenv").config({ quiet: true });
const fs = require("fs");
for (const linha of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) { const m = linha.match(/^(ZEN_[A-Z_]+)=(.*)$/); if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const l = require("../src/services/rd.leads.service");
const { notasPorLeads } = require("../src/services/zenNf.service");
const db = require("../src/database");
const { QueryTypes } = require("sequelize");
(async () => {
  const deals = await l.getLeads("admin", "adm");
  const mapa = new Map(deals.map(d => [d.id || d._id, d]));
  const rows = await db.sequelize.query(`SELECT DISTINCT lead_id, pci, classe_preco, comissao_pct, tipo_agente FROM bmax_transacoes WHERE tipo='credito' AND lead_id IS NOT NULL`, { type: QueryTypes.SELECT });
  const sem = rows.filter(r => r.comissao_pct === null).length;
  console.log("créditos distintos:", rows.length, "| sem comissao_pct gravado:", sem, "| sem classe_preco:", rows.filter(r => !r.classe_preco).length);
  const ids = [...new Set(rows.map(r => r.lead_id))];
  const leads = ids.map(id => { const d = mapa.get(id); return d && { id, cnpj: l.getCustomField(d, "CNPJ"), fechadoEm: d.closed_at || d.updated_at, valorCard: d.amount_total, nome: d.name }; }).filter(Boolean);
  const t0 = Date.now();
  const nfs = await notasPorLeads(leads);
  console.log("leads:", leads.length, "com NF:", Object.keys(nfs).length, "em", Date.now() - t0, "ms");
  for (const x of leads.filter(x => nfs[x.id]).slice(0, 25)) console.log(" ", x.nome, "| card", x.valorCard, "| NF", nfs[x.id]);
  process.exit(0);
})().catch(e => { console.error("ERRO", e.stack || e.message); process.exit(1); });
