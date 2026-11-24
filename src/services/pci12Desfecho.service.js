const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const rd = require("./rd.leads.service");
const C = require("../config/constants");
const { logger } = require("../logger");

// Desfecho do lead PCI12a gravado NO PORTAL (bmax_pci12a_prazo.resultado: vendido | perdido | vencido | null = em aberto).
// Antes o estado só existia como "etapa do RD", e uma mesma etapa servia para "Perdido pela revenda" e "Prazo Vencido" — foi
// assim que um card perdido pela revenda passou por "prazo vencido" sem o robô ter feito nada (16/11/2026). Agora todo caminho
// grava aqui: botão do Portal (origem "portal"), robô dos 60 dias ("robo") e mudança feita à mão no RD ("rd", pela reconciliação).

const VENDA = new Set([C.RD_STAGE_VENDIDO, C.RD_STAGE_VENDA_EFETIVADA, C.RD_STAGE_ENTREGA_TECNICA]);

// Desfecho que o card do RD indica hoje (ou null se segue em aberto)
function desfechoDoCard(d) {
    const st = d.deal_stage ? d.deal_stage.id : null;
    if (VENDA.has(st) || d.win === true) return "vendido";
    if (st === C.RD_STAGE_PERDIDO_REVENDA || st === C.RD_STAGE_EXCLUIDO || d.win === false) return "perdido";
    if (st === C.RD_STAGE_PERDIDO) return "vencido";   // etapa "Prazo Vencido": só o robô dos 60 dias manda para lá
    return null;
}

// Grava o desfecho do lead no controle (não faz nada se o lead não está no controle de 60 dias ou se já está igual)
async function registrarResultado12a(dealId, resultado, origem, outrosIds = []) {
    const ids = [String(dealId), ...outrosIds.filter(Boolean).map(String)];
    await sequelize.query(
        `UPDATE bmax_pci12a_prazo
            SET resultado = CAST(:resultado AS text),
                resultado_em = CASE WHEN CAST(:resultado AS text) IS NULL THEN NULL ELSE now() END,
                resultado_origem = :origem
          WHERE deal_id IN (:ids) AND resultado IS DISTINCT FROM CAST(:resultado AS text)`,
        { replacements: { ids, resultado: resultado || null, origem }, type: QueryTypes.UPDATE }
    );
}

// Confere cada lead do controle com o card no RD e corrige o desfecho no Portal quando divergir (inclui mudança manual no RD).
async function reconciliar({ dryRun = false } = {}) {
    const rows = await sequelize.query(`SELECT deal_id, resultado FROM bmax_pci12a_prazo`, { type: QueryTypes.SELECT });
    const [ind, bm] = await Promise.all([rd.fetchAllDealsFromRD().catch(() => []), rd.fetchDealsBmaxInterno().catch(() => [])]);
    const porId = new Map();
    for (const d of [...ind, ...bm]) porId.set(String(d.id || d._id), d);

    let consultados = 0;
    const mudancas = [];
    for (const r of rows) {
        let d = porId.get(String(r.deal_id));
        if (!d && consultados < 25) { d = await rd.getDealById(r.deal_id).catch(() => null); consultados++; }
        if (!d || !d.deal_stage) continue;
        const novo = desfechoDoCard(d);
        if ((novo || null) === (r.resultado || null)) continue;
        mudancas.push({ dealId: r.deal_id, de: r.resultado || null, para: novo });
        if (!dryRun) {
            try { await registrarResultado12a(r.deal_id, novo, "rd"); }
            catch (e) { logger.error({ message: "Falha ao gravar desfecho do 12a", dealId: r.deal_id, error: e.message }); }
        }
    }
    return { avaliados: rows.length, mudancas: mudancas.length, detalhe: mudancas.slice(0, 50) };
}

module.exports = { desfechoDoCard, registrarResultado12a, reconciliar };
