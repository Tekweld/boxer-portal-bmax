// Repara os créditos de comissão DUPLICADOS pela virada para o Pipefy (24/11/2026): o robô viu o mesmo lead com id novo (numérico) e creditou de novo.
// Regra: crédito com lead_id numérico cujo lead (id do RD no mapa) JÁ tem crédito do mesmo agente sob o id do RD -> é duplicata (apagada, com backup).
// Crédito numérico sem contraparte (venda realmente nova) fica, mas na carteira de nome único. Depois recalcula saldo e saldo_apos das carteiras afetadas.
// Uso: node scripts/codigo-unico/repara_creditos_duplicados_pipefy.js <mapa.json> [--aplicar]
const path = require("path"); const fs = require("fs");
const ROOT = path.resolve(__dirname, "../.."); process.chdir(ROOT); require("dotenv").config({ quiet: true });
const db = require(ROOT + "/src/database"); const { QueryTypes } = require("sequelize");
const { nomeUnico, codigoDe } = require(ROOT + "/src/services/codigoUnico.service");
const q = (s, r) => db.sequelize.query(s, { replacements: r || {}, type: QueryTypes.SELECT });
const APLICAR = process.argv.includes("--aplicar"); const MAPA = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).mapa;
(async () => {
  const novos = await q(`SELECT * FROM bmax_transacoes WHERE lead_id ~ '^[0-9]+$' AND tipo='credito' ORDER BY criado_em`);
  const antigos = await q(`SELECT lead_id, tipo_agente, SUM(valor)::float v FROM bmax_transacoes WHERE tipo='credito' AND lead_id !~ '^[0-9]+$' GROUP BY 1,2`);
  const antigo = new Map(antigos.map(a => [`${a.lead_id}::${a.tipo_agente}`, a.v]));
  const dup = [], ficam = [], semMapa = [];
  for (const n of novos) {
    const rdId = MAPA[n.lead_id]; if (!rdId) { semMapa.push(n); continue; }
    (antigo.has(`${rdId}::${n.tipo_agente}`) ? dup : ficam).push({ ...n, rdId, valorAntigo: antigo.get(`${rdId}::${n.tipo_agente}`) });
  }
  const soma = a => a.reduce((s, x) => s + Number(x.valor), 0);
  console.log(`créditos com id do Pipefy: ${novos.length} | duplicatas: ${dup.length} (R$ ${soma(dup).toFixed(2)}) | ficam (venda nova): ${ficam.length} (R$ ${soma(ficam).toFixed(2)}) | sem mapa: ${semMapa.length}`);
  const dif = dup.filter(d => Math.abs(d.valorAntigo - Number(d.valor)) > 0.01);
  console.log(`duplicatas cujo valor difere do crédito antigo (o robô acertará a diferença depois): ${dif.length}`, dif.slice(0, 8).map(d => `${d.tipo_agente}|${d.revenda}|novo ${d.valor} x antigo ${d.valorAntigo}`));
  console.log("ficam:", ficam.map(f => `${f.tipo_agente}|${f.revenda}|${f.valor}|lead ${f.lead_id}`));
  const afetadas = new Set([...dup, ...ficam].map(x => `${x.tipo_agente}::${x.revenda}`));
  console.log("carteiras afetadas:", afetadas.size);
  if (!APLICAR) { process.exit(0); }

  // backup
  const bk = path.resolve(ROOT, "../Documentação/Backups_Banco/creditos_duplicados_pipefy_ANTES_24-11-2026.json");
  const carteirasAntes = await q(`SELECT * FROM bmax_saldo`);
  fs.writeFileSync(bk, JSON.stringify({ duplicatas: dup, ficam, carteirasAntes }, null, 1));
  console.log("backup:", bk);

  await db.sequelize.transaction(async t => {
    const run = (s, r) => db.sequelize.query(s, { replacements: r || {}, transaction: t });
    // 1) apaga duplicatas
    for (const d of dup) await run(`DELETE FROM bmax_transacoes WHERE id = :id`, { id: d.id });
    // 2) créditos que ficam: carteira de nome único
    for (const f of ficam) {
      const nome = await nomeUnico(f.revenda, f.tipo_agente);
      if (nome !== f.revenda) {
        const c = await codigoDe(nome, f.tipo_agente);
        await run(`UPDATE bmax_transacoes SET revenda = :nome, revenda_id = COALESCE(:r, revenda_id), grupo_id = COALESCE(:g, grupo_id) WHERE id = :id`, { nome, r: c.revenda_id, g: c.grupo_id, id: f.id });
        afetadas.add(`${f.tipo_agente}::${nome}`);
      }
    }
    // 3) recalcula saldo_apos e saldo das carteiras afetadas (a partir das linhas existentes, em ordem)
    for (const k of afetadas) {
      const [tipo, nome] = k.split("::");
      const [rows] = await run(`SELECT id, tipo, valor::float v FROM bmax_transacoes WHERE tipo_agente = :tipo AND revenda = :nome ORDER BY criado_em, id`, { tipo, nome });
      let corrente = 0;
      for (const r of rows) { corrente += r.tipo === "credito" ? r.v : -r.v; await run(`UPDATE bmax_transacoes SET saldo_apos = :s WHERE id = :id`, { s: Number(corrente.toFixed(2)), id: r.id }); }
      const final = Number(corrente.toFixed(2));
      if (rows.length) await run(`UPDATE bmax_saldo SET saldo = :s, atualizado_em = NOW() WHERE tipo_agente = :tipo AND revenda = :nome`, { s: final, tipo, nome });
      else await run(`DELETE FROM bmax_saldo WHERE tipo_agente = :tipo AND revenda = :nome AND saldo = 0`, { tipo, nome });
      // carteira de nome único pode ainda não existir (venda nova movida para ela)
      if (rows.length) await run(`INSERT INTO bmax_saldo (revenda, saldo, tipo_agente, atualizado_em) VALUES (:nome, :s, :tipo, NOW()) ON CONFLICT (tipo_agente, revenda) DO NOTHING`, { nome, s: final, tipo });
    }
  });
  const depois = await q(`SELECT tipo_agente, revenda, saldo::float FROM bmax_saldo WHERE tipo_agente='revenda' ORDER BY revenda`);
  console.log("carteiras de revenda depois:", depois.map(d => `${d.revenda}=${d.saldo}`).join(" | "));
  const incons = await q(`SELECT s.tipo_agente, s.revenda, s.saldo::float, COALESCE(t.v,0)::float soma FROM bmax_saldo s LEFT JOIN (SELECT tipo_agente, revenda, SUM(CASE WHEN tipo='credito' THEN valor ELSE -valor END) v FROM bmax_transacoes GROUP BY 1,2) t USING (tipo_agente, revenda) WHERE abs(s.saldo - COALESCE(t.v,0)) > 0.01`);
  console.log("carteiras com saldo diferente da soma dos lançamentos (deve ser 0):", incons.length, JSON.stringify(incons.slice(0, 5)));
  process.exit(0);
})().catch(e => { console.error("ERRO", e.stack || e.message); process.exit(1); });
