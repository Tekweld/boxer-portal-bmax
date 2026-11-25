const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { getLeads, getCustomField, fetchDealsBmaxInterno, getDealById, buscarDataAssumidoNoRD } = require("./rd.leads.service");
const { motivoForaDoEscopo } = require("./escopoBmax.service");
const { sbSistemasService } = require("../config/supabaseSistemas");
const {
    RD_STAGE_VENDIDO, RD_STAGE_VENDA_EFETIVADA, RD_STAGE_ENTREGA_TECNICA,
    RD_STAGE_PERDIDO, RD_STAGE_PERDIDO_REVENDA, RD_STAGE_EXCLUIDO, REVENDA_SEM_CREDITO
} = require("../config/constants");

// Módulo "Performance de Revendas" (admin). Somente leitura: junta cards do RD (leads/vendas), razão de cashback
// (bmax_transacoes) e o histórico do PCI12 (bmax_pci12_tracking, bmax_pci12a_prazo, AuditLogs). Devolve componentes
// ADITIVOS por loja — o front soma para virar grupo e recalcula as taxas (conversão, % 12a em aberto etc.).

const ETAPAS_VENDA = new Set([RD_STAGE_VENDIDO, RD_STAGE_VENDA_EFETIVADA, RD_STAGE_ENTREGA_TECNICA]);
const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const SEM_REVENDA = new Set(REVENDA_SEM_CREDITO.map(norm).concat([""]));

function etapaId(d) { return d.deal_stage ? d.deal_stage.id : null; }
// A etapa RD_STAGE_PERDIDO (funil BMAX, no RD chama-se "Prazo Vencido") recebe DOIS tipos de card: o que a revenda marca como
// "Perdido" no Portal e o que o robô arquiva aos 60 dias. Só o robô grava `arquivado_em` no controle de prazo — por isso:
// na etapa e arquivado pelo robô = "vencido"; na etapa sem arquivamento = "perdido" (marcado pela revenda).
function situacao(d, arquivados) {
    if (ETAPAS_VENDA.has(etapaId(d)) && Number(d.amount_total || 0) > 0) return "venda";
    if (etapaId(d) === RD_STAGE_PERDIDO) return arquivados && arquivados.has(String(d.id || d._id)) ? "vencido" : "perdido";
    if (etapaId(d) === RD_STAGE_PERDIDO_REVENDA) return "perdido"; // etapa "Perdido pela Revenda" (desde 16/11/2026)
    if (d.win === false || etapaId(d) === RD_STAGE_EXCLUIDO) return "perdido";
    return "aberto";
}
// Cards de teste da integração não entram em nenhum indicador
const ehTeste = d => /^(teste[_ ]|teste integra)/i.test(String(d.name || "").trim());
const dentro = (data, de, ate) => {
    if (!de && !ate) return true;
    if (!data) return false;
    const t = new Date(data).getTime();
    if (de && t < de) return false;
    if (ate && t > ate) return false;
    return true;
};
const novaLinha = (nome) => ({
    nome, leads: 0, vendas: 0, valor: 0,
    cashback_gerado: 0, cashback_resgatado: 0, saldo: 0,
    pci12_recebidos: 0, dec12a_revenda: 0, dec12a_equipe: 0, dec12b_revenda: 0, dec12b_equipe: 0, auto12b: 0, aguardando: 0,
    horas_soma: 0, horas_n: 0,
    a12_assumidos: 0, a12_vendidos: 0, a12_valor: 0, a12_perdidos: 0, a12_abertos: 0, a12_vencidos: 0,
    detalhes: [], leads12: []
});

// de/ate: timestamps (ms) ou null. Leads contam pela data de CRIAÇÃO; vendas pela data de FECHAMENTO;
// cashback pela data do lançamento; PCI12 pela data do evento (detecção/escolha, ou criação do card).
async function calcularPerformance({ de = null, ate = null } = {}) {
    const [leadsInd, leadsBmax, cadastro, grupos, revendasLogin, ledger, saldos, tracking, prazo12a, escolhas] = await Promise.all([
        getLeads("admin", "adm"),
        fetchDealsBmaxInterno().catch(() => []),
        sbSistemasService("/comercial_revendas_bmax?select=nome,nome_rd,classe,estado,cidade,rep,grupo,ativo,user_id&order=nome").catch(() => []),
        sequelize.query(`SELECT grupo, revenda_rd FROM bmax_grupos`, { type: QueryTypes.SELECT }).catch(() => []),
        sequelize.query(`SELECT name, grupo, user_id FROM "Revendas"`, { type: QueryTypes.SELECT }).catch(() => []),
        sequelize.query(
            `SELECT revenda AS nome, tipo, saque_id, valor, criado_em FROM bmax_transacoes WHERE tipo_agente='revenda'`,
            { type: QueryTypes.SELECT }),
        sequelize.query(`SELECT revenda AS nome, saldo FROM bmax_saldo WHERE tipo_agente='revenda'`, { type: QueryTypes.SELECT }),
        sequelize.query(
            `SELECT deal_id, detectado_em, resolvido_em, auto_12b_em FROM bmax_pci12_tracking`, { type: QueryTypes.SELECT }),
        sequelize.query(`SELECT deal_id, assumido_em, arquivado_em, resultado FROM bmax_pci12a_prazo`, { type: QueryTypes.SELECT }),
        sequelize.query(
            `SELECT DISTINCT ON (a.entity_id) a.entity_id AS deal_id, a.metadata->>'caminho' AS caminho, a."createdAt" AS quando, u.role
             FROM "AuditLogs" a LEFT JOIN "Users" u ON u.username = a.username
             WHERE a.action = 'SELECT_CAMINHO_VENDA' AND a.status = 'success'
             ORDER BY a.entity_id, a."createdAt" DESC`,
            { type: QueryTypes.SELECT })
    ]);

    // Id canônico = id do Pipefy. Os controles (tracking, prazo 12a, auditoria) foram gravados com o id do RD: converte pelo rd_deal_id do card,
    // senão o mesmo lead entra duas vezes (id do RD no controle + id do Pipefy no card) e o PCI12 sai inflado.
    const rd2p = new Map();
    for (const d of [...leadsInd, ...leadsBmax]) if (d && d.rd_deal_id) rd2p.set(String(d.rd_deal_id), String(d.id || d._id));
    const dupAlias = new Map();   // card ignorado como duplicata -> card mantido
    const canon = id => { const x = String(id); const p = rd2p.get(x) || x; return dupAlias.get(p) || p; };
    const arquivados = new Set(prazo12a.filter(p => p.arquivado_em).map(p => canon(p.deal_id)));
    // Desfecho gravado no Portal (controle do 12a) vale mais que a inferência pela etapa do RD
    const desfecho12a = new Map(prazo12a.filter(p => p.resultado).map(p => [canon(p.deal_id), p.resultado]));
    const sitLead = d => {
        const r = desfecho12a.get(String(d.id || d._id));
        if (r === "vendido" && Number(d.amount_total || 0) > 0) return "venda";
        if (r === "perdido") return "perdido";
        if (r === "vencido") return "vencido";
        return situacao(d, arquivados);
    };

    // Leads = funil Indústria (Portal) + funil BMAX (negociações das revendas), sem cards de teste/fora do escopo.
    // Card do funil BMAX-Interno do RD que JÁ foi migrado para o Pipefy (o card do Pipefy guarda o id dele em "ID no RD CRM") não conta de novo.
    const leadsBmaxSemMigrados = leadsBmax.filter(d => !rd2p.has(String(d.id || d._id)));
    const leadsBrutos = [...leadsInd, ...leadsBmaxSemMigrados.filter(d => d.deal_stage && !motivoForaDoEscopo(getCustomField(d, "MÁQUINA DE INTERESSE"), getCustomField(d, "SEGMENTO DE PRODUTO")))]
        .filter(d => !ehTeste(d));
    // Mesma venda registrada em 2 cards (ex.: card da revenda + card da Indústria, copiados 1:1 na migração): mesmo CNPJ + mesma revenda +
    // mesmo valor (> 0) + mesmo dia de criação = um lead só. Fica o card que já tem controle/escolha do PCI12; os ignorados vão em `duplicados_ignorados`.
    const ligadosAoControle = new Set([...tracking, ...prazo12a, ...escolhas].map(t => canon(t.deal_id)));
    const chaveDup = d => {
        const v = Number(d.amount_total || 0), cnpj = String(getCustomField(d, "CNPJ") || "").replace(/\D/g, "");
        if (!(v > 0) || cnpj.length < 11) return null;
        return [cnpj, norm(getCustomField(d, "REVENDA/LOJA") || ""), v.toFixed(2), String(d.created_at || "").slice(0, 10)].join("|");
    };
    const unicos = new Map(), semChave = [], duplicadosIgnorados = [];
    for (const d of leadsBrutos) {
        const k = chaveDup(d); if (!k) { semChave.push(d); continue; }
        const ant = unicos.get(k);
        if (!ant) { unicos.set(k, d); continue; }
        const mantem = ligadosAoControle.has(String(d.id || d._id)) && !ligadosAoControle.has(String(ant.id || ant._id)) ? d : ant, descarta = mantem === d ? ant : d;
        unicos.set(k, mantem);
        dupAlias.set(String(descarta.id || descarta._id), String(mantem.id || mantem._id));
        duplicadosIgnorados.push({ mantido: String(mantem.id || mantem._id), ignorado: String(descarta.id || descarta._id), lead: mantem.name, valor: Number(mantem.amount_total) });
    }
    const leads = [...semChave, ...unicos.values()];
    const porId = new Map();
    for (const d of leads) porId.set(d.id || d._id, d);

    // ── Resolvedor de nomes: a mesma revenda aparece com vários nomes (nome longo do ZEN em `nome`, nome curto em `nome_rd`,
    // nomes das lojas em bmax_grupos). Tudo aponta para UMA linha canônica (nome_rd, senão nome), preferindo cadastro ativo.
    const linhas = new Map(), meta = new Map(), alias = new Map();
    const grupoPorNome = new Map(grupos.map(g => [norm(g.revenda_rd), g.grupo]));
    const cadOrdenado = [...cadastro].sort((a, b) => (b.ativo ? 1 : 0) - (a.ativo ? 1 : 0) || (b.nome_rd ? 1 : 0) - (a.nome_rd ? 1 : 0));
    for (const c of cadOrdenado) {
        const canon = (c.nome_rd || c.nome || "").trim(); const kc = norm(canon);
        if (!kc || SEM_REVENDA.has(kc)) continue;
        if (!linhas.has(kc)) {
            linhas.set(kc, novaLinha(canon));
            meta.set(kc, { classe: c.classe || "", estado: c.estado || "", cidade: c.cidade || "", rep: c.rep || "", grupo: c.grupo || grupoPorNome.get(kc) || "", ativo: !!c.ativo });
        }
        for (const n of [c.nome, c.nome_rd]) { const k = norm(n); if (k && !alias.has(k)) alias.set(k, kc); }
    }
    // Código numérico do ZEN no início do nome ("42863, Alpha Abras…" e "42863 Alphabras Poços de Caldas 1" = mesma loja)
    const porCodigo = new Map();
    for (const c of cadOrdenado) {
        const kc = norm((c.nome_rd || c.nome || "").trim()); if (!linhas.has(kc)) continue;
        for (const n of [c.nome, c.nome_rd]) { const m = String(n || "").trim().match(/^(\d{4,6})\b/); if (m && !porCodigo.has(m[1])) porCodigo.set(m[1], kc); }
    }
    // Login do Portal (tabela Revendas): liga ao cadastro pelo user_id ou, sem vínculo, pelas palavras do nome (só se for inequívoco).
    // Revenda com login é cliente ativa, mesmo que o cadastro esteja marcado inativo.
    const tokens = t => norm(t).replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length > 2 && !["ltda", "eireli", "epp", "comercio", "para", "dos", "das"].includes(w));
    for (const r of revendasLogin) {
        const kr = norm(r.name); if (!kr || SEM_REVENDA.has(kr)) continue;
        let kc = null;
        const porUser = cadOrdenado.find(c => c.user_id && String(c.user_id) === String(r.user_id));
        if (porUser) kc = norm((porUser.nome_rd || porUser.nome || "").trim());
        else if (alias.has(kr)) kc = alias.get(kr);
        else {
            const tk = tokens(r.name);
            if (tk.length >= 2) {
                const cand = cadOrdenado.filter(c => { const tn = tokens(c.nome); return tk.every(w => tn.includes(w)); });
                const unicos = [...new Set(cand.map(c => norm((c.nome_rd || c.nome || "").trim())))];
                if (unicos.length === 1) kc = unicos[0];
            }
        }
        if (kc && linhas.has(kc)) {
            if (!alias.has(kr)) alias.set(kr, kc);
            const m = meta.get(kc); m.ativo = true; if (!m.grupo && r.grupo) m.grupo = r.grupo;
            if (!/^\d/.test(r.name)) linhas.get(kc).nome = String(r.name).trim(); // nome de exibição curto, o do login
        }
    }
    const garantir = (nome) => {
        // nome so conhecido por bmax_grupos (ex.: 42863 Alphabras Pocos de Caldas 1): usa a linha com o nome do proprio grupo, se existir
        const gDoNome = grupoPorNome.get(norm(nome));
        const mc = String(nome).trim().match(/^(\d{4,6})\b/);
        let k = alias.get(norm(nome)) || (mc && porCodigo.get(mc[1])) || (gDoNome && linhas.has(norm(gDoNome)) ? norm(gDoNome) : norm(nome));
        if (!linhas.has(k)) {
            linhas.set(k, novaLinha(String(nome).trim()));
            meta.set(k, { classe: "", estado: "", cidade: "", rep: "", grupo: grupoPorNome.get(norm(nome)) || "", ativo: false, fora_cadastro: true });
        }
        return linhas.get(k);
    };
    const semRevenda = { leads: 0, vendas: 0, valor: 0 };

    // ── Leads e vendas ──
    for (const d of leads) {
        const id = d.id || d._id;
        const nome = (getCustomField(d, "REVENDA/LOJA") || "").trim();
        const sit = sitLead(d);
        const criadoOk = dentro(d.created_at, de, ate);
        const vendaOk = sit === "venda" && dentro(d.closed_at || d.updated_at, de, ate);
        if (SEM_REVENDA.has(norm(nome))) {
            if (criadoOk) semRevenda.leads++;
            if (vendaOk) { semRevenda.vendas++; semRevenda.valor += Number(d.amount_total); }
            continue;
        }
        const l = garantir(nome);
        if (criadoOk) l.leads++;
        if (vendaOk) { l.vendas++; l.valor += Number(d.amount_total); }
        if (criadoOk || vendaOk) l.detalhes.push({ id, n: d.name, e: d.deal_stage ? d.deal_stage.name : "", p: (getCustomField(d, "PERFIL PCI") || "").trim(), v: Number(d.amount_total || 0), s: sit, c: d.created_at });
    }

    // ── Cashback gerado (créditos − ajustes de recálculo), resgatado (débitos com saque) e saldo atual ──
    for (const t of ledger) {
        if (SEM_REVENDA.has(norm(t.nome)) || !dentro(t.criado_em, de, ate)) continue;
        const l = garantir(t.nome); const v = Number(t.valor || 0);
        if (t.tipo === "credito") l.cashback_gerado += v;
        else if (t.saque_id) l.cashback_resgatado += v;
        else l.cashback_gerado -= v;
    }
    for (const s of saldos) if (!SEM_REVENDA.has(norm(s.nome))) garantir(s.nome).saldo += Number(s.saldo || 0);

    // ── PCI12 ──
    const trk = new Map(tracking.map(t => [canon(t.deal_id), t]));
    const esc12a = new Map(escolhas.map(e => [canon(e.deal_id), e]));
    const p12a = new Map(prazo12a.map(p => [canon(p.deal_id), p]));
    const universo = new Set([...trk.keys(), ...esc12a.keys(), ...p12a.keys()]);
    for (const [id, d] of porId) { const p = (getCustomField(d, "PERFIL PCI") || "").trim(); if (p === "PCI 12a" || p === "PCI 12b" || p === "PCI 12") universo.add(id); }

    // Deals do histórico PCI12 que não estão em nenhum dos dois funis lidos (ex.: movidos): busca individual
    const faltando = [...universo].filter(id => !porId.has(id));
    const extras = await Promise.all(faltando.map(id => getDealById(id).catch(() => null)));
    extras.forEach((d, i) => { if (d && !ehTeste(d)) porId.set(faltando[i], d); });

    const prazoLista = [];
    for (const id of universo) {
        const d = porId.get(id); if (!d) continue;
        const nome = (getCustomField(d, "REVENDA/LOJA") || "").trim();
        if (SEM_REVENDA.has(norm(nome))) continue;
        const t = trk.get(id), e = esc12a.get(id), pciCard = (getCustomField(d, "PERFIL PCI") || "").trim();

        // caminho final: escolha registrada > 12b automático > PCI atual do card
        let caminho = null, quem = "equipe", auto = false;
        if (e && e.caminho) { caminho = e.caminho === "BOX>REV" ? "12a" : "12b"; quem = e.role === "revenda" ? "revenda" : "equipe"; }
        else if (t && t.auto_12b_em) { caminho = "12b"; auto = true; }
        else if (pciCard === "PCI 12a" || p12a.has(id)) caminho = "12a";
        else if (pciCard === "PCI 12b") caminho = "12b";

        let inicio12a = null;
        // Painel "12a perto do prazo": todo 12a ainda aberto, com os dias desde que a revenda assumiu (independe do filtro de período)
        if (caminho === "12a" && sitLead(d) === "aberto") {
            const pz = p12a.get(id);
            // Data de assumir: 1) clique registrado no Portal; 2) tarefa "Revenda Assumiu o Atendimento" do card no RD; 3) controle (estimada)
            let inicio = null, fonte = "";
            if (e && e.caminho === "BOX>REV") { inicio = (pz && pz.assumido_em) || e.quando; fonte = "portal"; }
            if (!inicio) { const dRd = await buscarDataAssumidoNoRD(id); if (dRd) { inicio = dRd; fonte = "rd"; } }
            if (!inicio) { inicio = (pz && pz.assumido_em) || (t && t.resolvido_em) || null; fonte = "estimada"; }
            inicio12a = inicio || null;
            if (inicio) {
                const dias = Math.floor((Date.now() - new Date(inicio).getTime()) / 864e5);
                prazoLista.push({ id, fonte_data: fonte, revenda: garantir(nome).nome, lead: d.name, valor: Number(d.amount_total || 0), etapa: d.deal_stage ? d.deal_stage.name : "", dias, restam: 60 - dias, assumido: inicio, atualizado: d.updated_at || null });
            }
        }

        if (caminho === "12a" && !inicio12a) inicio12a = (p12a.get(id) && p12a.get(id).assumido_em) || (e && e.quando) || null;
        const dataEvento = (t && t.detectado_em) || (e && e.quando) || d.created_at;
        if (!dentro(dataEvento, de, ate)) continue;
        const l = garantir(nome);
        l.pci12_recebidos++;
        // lead a lead (para filtrar a tabela ao clicar nos cards): cam = 12a/12b/null (aguardando); q = revenda/equipe/auto
        l.leads12.push({ id, n: d.name, e: d.deal_stage ? d.deal_stage.name : "", p: pciCard, v: Number(d.amount_total || 0), s: sitLead(d), cam: caminho, q: auto ? "auto" : (caminho ? quem : ""), ini: inicio12a, dias: inicio12a ? Math.floor((Date.now() - new Date(inicio12a).getTime()) / 864e5) : null });

        // "Aguardando" = ainda sem caminho E ainda aberto; vendas/perdas finalizadas sem escolha registrada não estão aguardando nada
        if (!caminho) { if (sitLead(d) === "aberto") l.aguardando++; }
        else if (auto) l.auto12b++;
        else if (caminho === "12a") (quem === "revenda" ? l.dec12a_revenda++ : l.dec12a_equipe++);
        else (quem === "revenda" ? l.dec12b_revenda++ : l.dec12b_equipe++);

        if (t && t.resolvido_em && t.detectado_em && !auto) {
            const h = (new Date(t.resolvido_em) - new Date(t.detectado_em)) / 36e5;
            if (h >= 0 && h < 24 * 90) { l.horas_soma += h; l.horas_n++; }
        }
        if (caminho === "12a") {
            l.a12_assumidos++;
            const sit = sitLead(d);
            if (sit === "venda") { l.a12_vendidos++; l.a12_valor += Number(d.amount_total); }
            else if (sit === "perdido") l.a12_perdidos++;
            else if (sit === "vencido") l.a12_vencidos++;
            else l.a12_abertos++;
        }
    }

    const rows = [...linhas.entries()].map(([k, l]) => ({ ...l, ...meta.get(k) }));
    for (const r of rows) {
        r.valor = Number(r.valor.toFixed(2)); r.cashback_gerado = Number(r.cashback_gerado.toFixed(2));
        r.cashback_resgatado = Number(r.cashback_resgatado.toFixed(2)); r.a12_valor = Number(r.a12_valor.toFixed(2));
    }
    const comAtividade = rows.filter(r => r.ativo || r.leads || r.vendas || r.cashback_gerado || r.pci12_recebidos || r.saldo);
    semRevenda.valor = Number(semRevenda.valor.toFixed(2));
    return {
        gerado_em: new Date().toISOString(),
        historico_pci12: { rastreio_48h_desde: "2026-07-30", escolhas_e_assumidos_desde: "2026-09-10" },
        linhas: comAtividade,
        sem_revenda: semRevenda,
        duplicados_ignorados: duplicadosIgnorados,
        prazo12a: prazoLista.sort((a, b) => b.dias - a.dias)
    };
}

module.exports = { calcularPerformance };
