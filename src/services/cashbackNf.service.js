// Fechamento automático de venda por NF do ZEN — FASE 2, hoje SOMENTE SIMULAÇÃO (05/11/2026): lista o que seria
// feito, não escreve nada no RD, no ZEN nem no banco.
//
// Regra: card de lead de revenda (PCI 12a/12b/13/14/15) ainda ABERTO (win vazio) em etapa de andamento, criado a
// partir de 01/05/2026, cujo CNPJ tenha NF de saída no ZEN emitida depois da criação do card.
//  - NF com a tag "bmax": candidata a fechamento automático.
//  - NF sem tag (achada só pelo CNPJ): só sugestão, fica para revisão humana.
// Ação planejada (quando for ligada): valor do card (amount_unique) = soma das NFs; mover para a etapa de venda do
// funil (Venda Efetivada na Indústria Interno, Vendido no BMAX) E marcar o card como ganho (win=true — o "botão de
// venda" do RD; mover etapa sozinho não marca); depois o recalcularComissoes credita. Sem Classe de Preço ou sem PCI
// o card NÃO é fechado (vira alerta), porque não há como calcular a comissão.
const C = require("../config/constants");
const l = require("./rd.leads.service");
const { notasParaCard, configurado } = require("./zenNf.service");
const { calcularComissoes } = require("./cashback.service");

const CORTE = "2026-05-01";
const ETAPAS_ABERTAS = new Set([C.RD_STAGE_ASSUMIDO, C.RD_STAGE_NEGOCIACAO, C.RD_STAGE_LEAD]);
const PCI_REVENDA = /^PCI(12A|12B|13|14|15)$/;
const dia = s => String(s || "").slice(0, 10);

function destinoDaVenda(pipelineId) {
    if (pipelineId === C.RD_PIPELINE_INDUSTRIA) return { stageId: C.RD_STAGE_VENDA_EFETIVADA, nome: "Venda Efetivada" };
    if (pipelineId === C.RD_PIPELINE_BMAX_INTERNO) return { stageId: C.RD_STAGE_VENDIDO, nome: "Vendido" };
    return null;
}

async function pool(itens, n, fn) {
    const out = new Array(itens.length); let i = 0;
    await Promise.all(Array.from({ length: n }, async () => { while (i < itens.length) { const k = i++; out[k] = await fn(itens[k]); } }));
    return out;
}

async function simular() {
    if (!configurado()) throw new Error("ZEN_EMAIL/ZEN_SENHA não configurados");
    const deals = await l.fetchAllDealsAllPipelines();
    const candidatos = [];
    for (const d of deals) {
        if (d.win === true || d.win === false) continue;
        if (!ETAPAS_ABERTAS.has(d.deal_stage && d.deal_stage.id)) continue;
        const pci = (l.getCustomField(d, "PERFIL PCI") || "").trim();
        if (!PCI_REVENDA.test(pci.replace(/\s/g, "").toUpperCase())) continue;
        const revenda = l.getCustomField(d, "REVENDA/LOJA") || "";
        if (!revenda || revenda === "Sem Revenda" || revenda === "?????") continue;
        if (dia(d.created_at) < CORTE) continue;
        candidatos.push({ d, pci, revenda });
    }

    const resultado = await pool(candidatos, 4, async ({ d, pci, revenda }) => {
        const cnpj = String(l.getCustomField(d, "CNPJ") || "").replace(/\D/g, "");
        const classe = (l.getCustomField(d, "CLASSE DE PREÇO") || "").replace(/\D/g, "");
        const base = {
            dealId: d.id || d._id, nome: d.name, revenda, pci, classe, cnpj,
            etapa: d.deal_stage && d.deal_stage.name, criadoEm: dia(d.created_at),
            valorAtual: Number(d.amount_total || 0), responsavel: d.user && d.user.name
        };
        if (cnpj.length !== 14) return { ...base, decisao: "REVISAR", motivo: "CNPJ do card inválido ou vazio" };
        let achadas;
        try { achadas = await notasParaCard(cnpj, base.criadoEm); } catch (e) { return { ...base, decisao: "ERRO", motivo: "Falha ao consultar o ZEN: " + e.message.slice(0, 80) }; }
        const { comTag, semTag } = achadas;
        const lista = ns => ns.map(n => `NF ${n.numero} (${n.data}) R$ ${n.total.toFixed(2)}`).join("; ");
        if (!comTag.length && !semTag.length) return { ...base, decisao: "AGUARDAR", motivo: "Sem NF do cliente após a criação do card" };
        if (!comTag.length) return { ...base, decisao: "REVISAR", motivo: "NF achada pelo CNPJ mas SEM a tag bmax — confirmar antes de fechar", notas: lista(semTag), valorNf: Number(semTag.reduce((s, n) => s + n.total, 0).toFixed(2)) };

        const valorNf = Number(comTag.reduce((s, n) => s + n.total, 0).toFixed(2));
        const dest = destinoDaVenda(d._pipelineId);
        const alertas = [];
        if (!dest) alertas.push("funil sem etapa de venda mapeada");
        if (!classe) alertas.push("sem Classe de Preço (vendedor Boxer precisa preencher)");
        if (comTag.length > 1) alertas.push(comTag.length + " notas com tag — confirmar que todas são deste card");
        let cashback = null;
        if (classe && dest) {
            try {
                const c = await calcularComissoes({ valorTotal: valorNf, pci, classePreco: classe, representante: l.getCustomField(d, "REPRESENTANTE"), responsavelRd: d.user && d.user.name });
                if (c.faltando) alertas.push(c.motivo); else cashback = Number((((c.revenda && c.revenda.valor) || 0) + ((c.representante && c.representante.valor) || 0) + ((c.vendedorInterno && c.vendedorInterno.valor) || 0)).toFixed(2));
            } catch (e) { alertas.push("erro ao calcular comissão"); }
        }
        return {
            ...base, decisao: alertas.length ? "REVISAR" : "FECHARIA", motivo: alertas.join(" | "), notas: lista(comTag), valorNf, cashbackEstimado: cashback,
            acao: dest ? `valor do card ${base.valorAtual.toFixed(2)} → ${valorNf.toFixed(2)}; mover para "${dest.nome}" e marcar como GANHO (win=true)` : ""
        };
    });

    const cont = {};
    resultado.forEach(r => { cont[r.decisao] = (cont[r.decisao] || 0) + 1; });
    return { simulacao: true, candidatos: resultado.length, resumo: cont, lista: resultado };
}

module.exports = { simular };
