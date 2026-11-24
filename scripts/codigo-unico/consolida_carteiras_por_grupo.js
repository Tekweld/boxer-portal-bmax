// Cashback é do GRUPO (André, 24/11/2026): junta as carteiras de revenda das lojas de cada grupo numa carteira única com o NOME DO GRUPO.
// Mantém todos os lançamentos (só troca o nome da carteira + grupo_id), refaz saldo_apos/saldo e também ajusta os saques antigos do grupo.
// Uso: node scripts/codigo-unico/consolida_carteiras_por_grupo.js [--aplicar]
const path = require("path"); const fs = require("fs");
const ROOT = path.resolve(__dirname, "../.."); process.chdir(ROOT); require("dotenv").config({ quiet: true });
const db = require(ROOT + "/src/database"); const { QueryTypes } = require("sequelize");
const { sbSistemasService } = require(ROOT + "/src/config/supabaseSistemas"); const { codigoDe, limparCache } = require(ROOT + "/src/services/codigoUnico.service");
const q = (s, r, t) => db.sequelize.query(s, { replacements: r || {}, type: QueryTypes.SELECT, transaction: t });
const APLICAR = process.argv.includes("--aplicar");
(async () => {
  limparCache();
  const grupos = await sbSistemasService("/comercial_bmax_grupos?select=id,nome");
  const lojas = await sbSistemasService("/comercial_revendas_bmax?select=id,nome,nome_rd,grupo_id&grupo_id=not.is.null");
  const carteiras = await q(`SELECT revenda, saldo::float saldo, revenda_id, grupo_id FROM bmax_saldo WHERE tipo_agente='revenda'`);
  const plano = [];
  for (const g of grupos) {
    const ids = new Set(lojas.filter(l => l.grupo_id === g.id).map(l => l.id));
    const alvo = [];
    for (const c of carteiras) {
      const cod = await codigoDe(c.revenda, "revenda");
      const rid = c.revenda_id || cod.revenda_id, gid = c.grupo_id || cod.grupo_id;
      if (gid === g.id || (rid && ids.has(rid))) alvo.push(c);
    }
    if (alvo.length && (alvo.length > 1 || alvo[0].revenda !== g.nome)) plano.push({ grupo: g, carteiras: alvo, total: alvo.reduce((s, c) => s + c.saldo, 0) });
  }
  for (const p of plano) console.log(`Grupo "${p.grupo.nome}": ${p.carteiras.map(c => `${c.revenda}=${c.saldo}`).join(" + ")}  =>  "${p.grupo.nome}" = ${p.total.toFixed(2)}`);
  if (!plano.length) console.log("nada a consolidar");
  if (!APLICAR || !plano.length) process.exit(0);

  const bk = path.resolve(ROOT, "../Documentação/Backups_Banco/carteiras_por_grupo_ANTES_24-11-2026.json");
  fs.writeFileSync(bk, JSON.stringify({ plano, transacoes: await q(`SELECT * FROM bmax_transacoes WHERE tipo_agente='revenda'`), saldos: await q(`SELECT * FROM bmax_saldo WHERE tipo_agente='revenda'`), saques: await q(`SELECT * FROM bmax_saques`) }, null, 1));
  console.log("backup:", bk);
  await db.sequelize.transaction(async t => {
    const run = (s, r) => db.sequelize.query(s, { replacements: r || {}, transaction: t });
    for (const p of plano) {
      const nomes = p.carteiras.map(c => c.revenda); const alvo = p.grupo.nome; const gid = p.grupo.id;
      await run(`UPDATE bmax_transacoes SET revenda = :alvo, grupo_id = :gid WHERE tipo_agente='revenda' AND revenda IN (:nomes)`, { alvo, gid, nomes });
      await run(`UPDATE bmax_saques SET revenda = :alvo, grupo_id = :gid WHERE revenda IN (:nomes)`, { alvo, gid, nomes });
      const rows = await q(`SELECT id, tipo, valor::float v FROM bmax_transacoes WHERE tipo_agente='revenda' AND revenda = :alvo ORDER BY criado_em, id`, { alvo }, t);
      let corrente = 0;
      for (const r of rows) { corrente += r.tipo === "credito" ? r.v : -r.v; await run(`UPDATE bmax_transacoes SET saldo_apos = :s WHERE id = :id`, { s: Number(corrente.toFixed(2)), id: r.id }); }
      const final = Number(corrente.toFixed(2));
      await run(`DELETE FROM bmax_saldo WHERE tipo_agente='revenda' AND revenda IN (:nomes) AND revenda <> :alvo`, { nomes, alvo });
      await run(`INSERT INTO bmax_saldo (revenda, saldo, tipo_agente, atualizado_em, grupo_id) VALUES (:alvo, :s, 'revenda', NOW(), :gid)
                 ON CONFLICT (tipo_agente, revenda) DO UPDATE SET saldo = :s, atualizado_em = NOW(), grupo_id = :gid`, { alvo, s: final, gid });
      console.log(`  ${alvo}: ${rows.length} lançamentos, saldo ${final}`);
    }
  });
  const incons = await q(`SELECT s.revenda, s.saldo::float, COALESCE(t.v,0)::float soma FROM bmax_saldo s LEFT JOIN (SELECT tipo_agente, revenda, SUM(CASE WHEN tipo='credito' THEN valor ELSE -valor END) v FROM bmax_transacoes GROUP BY 1,2) t USING (tipo_agente, revenda) WHERE abs(s.saldo - COALESCE(t.v,0)) > 0.01`);
  console.log("carteiras com saldo != soma (deve ser 0):", incons.length);
  console.log("carteiras de revenda agora:", (await q(`SELECT revenda, saldo::float FROM bmax_saldo WHERE tipo_agente='revenda' ORDER BY revenda`)).map(c => `${c.revenda}=${c.saldo}`).join(" | "));
  process.exit(0);
})().catch(e => { console.error("ERRO", e.stack || e.message); process.exit(1); });
