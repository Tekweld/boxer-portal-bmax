// Prova da etapa 5: linha de cashback com NOME diferente mas CÓDIGO da Aldesoldas aparece no extrato da Aldesoldas. Limpa tudo no fim.
const P = "C:/Users/andre.coelho.BXSD/BOXER/Dados - Documentos/Comercial/Geral/Estrategia/2026/Projeto BMax/boxer-portal-bmax";
process.chdir(P); require(P + "/node_modules/dotenv").config({ quiet: true });
const db = require(P + "/src/database"); const { QueryTypes } = require(P + "/node_modules/sequelize"); const { sbSistemasService } = require(P + "/src/config/supabaseSistemas");
const saldo = require(P + "/src/services/saldo.service");
const q = (s, r) => db.sequelize.query(s, { replacements: r || {}, type: QueryTypes.SELECT });
(async () => {
  const ald = (await sbSistemasService("/comercial_revendas_bmax?nome=eq.Aldesoldas&select=id"))[0].id; const NOME = "ZZ NOME ANTIGO ETAPA5";
  const antes = await saldo.getExtrato("Aldesoldas"); const sAntes = await saldo.getSaldoGrupo("Aldesoldas", null);
  try {
    await db.sequelize.query(`INSERT INTO bmax_transacoes (revenda, tipo, valor, descricao, saldo_apos, tipo_agente, revenda_id) VALUES (:n, 'credito', 0.01, 'teste etapa 5', 0.01, 'revenda', :id)`, { replacements: { n: NOME, id: ald }, type: QueryTypes.INSERT });
    const dep = await saldo.getExtrato("Aldesoldas"); console.log("extrato da Aldesoldas:", antes.length, "->", dep.length, "| achou a linha de nome diferente pelo código:", dep.some(r => r.descricao === "teste etapa 5"));
  } finally {
    await db.sequelize.query(`DELETE FROM bmax_transacoes WHERE revenda=:n`, { replacements: { n: NOME }, type: QueryTypes.DELETE });
    const fim = await saldo.getExtrato("Aldesoldas"); console.log("limpeza: extrato", fim.length, "(deve ser", antes.length + ") | saldo", sAntes, "->", await saldo.getSaldoGrupo("Aldesoldas", null));
  }
  process.exit(0);
})().catch(e => { console.error("ERRO", e.stack || e.message); process.exit(1); });
