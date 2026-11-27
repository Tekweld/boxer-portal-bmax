// AUDITORIA DAS VENDAS DO CRM x ZEN (Fase A, 27/11/2026). SOMENTE LEITURA e SÓ AVISA: nada é gravado no Pipefy nem no ZEN.
// Desenho: Documentação/Desenho_Auditoria_Vendas_CRM_x_ZEN_26-11-2026.md. Regra do André: card vendido = nota fiscal no ZEN (valor do card =
// total da NF, sem frete, só impostos). Divergência de até 4% vira "valor sugerido" (candidata ao ajuste automático da Fase B); acima disso
// é alerta. A conferência de produto fica para uma próxima fase.

const TOLERANCIA_PCT = 0.04;        // até 4% = só valor a ajustar
const DIAS_ESPERA_SEM_NOTA = 3;     // a nota pode sair alguns dias depois do card concluir: só alerta "sem nota" depois disso
const JANELA_ANTES = 60, JANELA_DEPOIS = 90;

const so = s => String(s || "").replace(/\D/g, "");
const dia = s => String(s || "").slice(0, 10);
const addDias = (d, n) => new Date(new Date(d).getTime() + n * 86400000).toISOString().slice(0, 10);
const difDias = (a, b) => Math.round((new Date(a) - new Date(b)) / 86400000);

// Card de teste não entra em nada.
const ehTeste = c => /teste/i.test(c && c.nome || "");

// Avalia UM card contra as notas do CNPJ dele. card: { valor, criadoEm, fechadoEm }; nfs: [{ numero, data, total }] (sem canceladas).
// Devolve { estado: "ok"|"ok_soma"|"valor_diverge"|"sem_nota", nota, soma, diff, pct, sugerido, usadas }.
function avaliarVenda(card, nfs) {
    const valor = Number(card.valor) || 0;
    const criado = dia(card.criadoEm) || "0000-00-00", fechado = dia(card.fechadoEm) || criado;
    const cand = nfs.filter(n => n.data >= addDias(criado, -JANELA_ANTES) && n.data <= addDias(fechado, JANELA_DEPOIS));
    if (!cand.length) return { estado: "sem_nota" };
    const tol = Math.max(0.05, valor * 0.001);
    // 1) uma nota de valor igual (a mais perto do fechamento)
    const iguais = cand.filter(n => Math.abs(n.total - valor) <= tol).sort((a, b) => Math.abs(difDias(a.data, fechado)) - Math.abs(difDias(b.data, fechado)));
    if (iguais.length) return { estado: "ok", nota: iguais[0].numero, usadas: [iguais[0]] };
    // 2) pedido faturado em várias notas: soma de 2 a 6 notas com o valor do card
    const livres = cand.slice(0, 14);
    let melhor = null;
    for (let m = 1; m < (1 << livres.length); m++) {
        const sub = livres.filter((_, i) => m & (1 << i));
        if (sub.length < 2 || sub.length > 6) continue;
        const soma = sub.reduce((s, n) => s + n.total, 0);
        if (Math.abs(soma - valor) > tol) continue;
        if (!melhor || sub.length < melhor.sub.length) melhor = { sub, soma };
    }
    if (melhor) return { estado: "ok_soma", nota: melhor.sub.map(n => n.numero).join(" + "), soma: melhor.soma, usadas: melhor.sub };
    // 3) a nota mais próxima do valor do card
    const prox = cand.slice().sort((a, b) => Math.abs(a.total - valor) - Math.abs(b.total - valor))[0];
    const diff = prox.total - valor, pct = valor ? Math.abs(diff) / valor : 1;
    return { estado: "valor_diverge", nota: prox.numero, notaData: prox.data, notaTotal: prox.total, diff, pct, sugerido: pct <= TOLERANCIA_PCT ? prox.total : null, usadas: [prox] };
}

// Avalia vários cards, uma nota para um card só (cards do mesmo CNPJ não disputam a mesma nota). Retorna Map card.id -> resultado.
function avaliarVendas(cards, nfsPorCnpj) {
    const out = new Map(), usadas = new Set();
    const porCnpj = new Map();
    for (const c of cards) { const k = so(c.cnpj); if (!porCnpj.has(k)) porCnpj.set(k, []); porCnpj.get(k).push(c); }
    for (const [cnpj, lista] of porCnpj) {
        // quem fechou antes escolhe primeiro
        for (const c of lista.slice().sort((a, b) => dia(a.fechadoEm).localeCompare(dia(b.fechadoEm)))) {
            const livres = (nfsPorCnpj.get(cnpj) || []).filter(n => !usadas.has(cnpj + ":" + n.numero));
            const r = avaliarVenda(c, livres);
            if (r.estado === "ok" || r.estado === "ok_soma" || (r.estado === "valor_diverge" && r.sugerido != null)) (r.usadas || []).forEach(n => usadas.add(cnpj + ":" + n.numero));
            out.set(c.id, r);
        }
    }
    return out;
}

module.exports = { avaliarVenda, avaliarVendas, ehTeste, TOLERANCIA_PCT, DIAS_ESPERA_SEM_NOTA };
