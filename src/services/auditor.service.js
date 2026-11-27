const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");
const { sendEmail } = require("./email.service");
const { ESPERADOS, LIM_CREDITOS_24H, LIM_VALOR_24H } = require("./roboMonitor.service");
const A = require("./auditorCards.service");
const C = require("../config/constants");
const { logger } = require("../logger");

// AUDITOR DIÁRIO (25/11/2026). Regra do André: o auditor SÓ AVISA, nunca corrige nada. As checagens apenas leem; a única coisa que ele
// grava são as tabelas dele (bmax_auditoria_*). O e-mail vai só para EMAIL_AUDITOR e só quando há achado novo ou um achado antigo que
// venceu o lembrete semanal. Um achado continua "aberto" até uma rodada não o encontrar mais; checagem que falhou ao rodar NUNCA marca
// seus achados como resolvidos.

const REAVISO_DIAS = 7;
const DIAS_MUDANCA_ABERTA = 3;      // uma mudança de PCI/produto/classe fica "aberta" por 3 dias e some sozinha
const LIMITE_LINHAS_EMAIL = 12;     // por tipo de checagem; o resto fica na aba Auditor diário
const TOLERANCIA_SALDO = 0.01;

const brl = x => "R$ " + Number(x).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hojeBRT = () => new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
const linkCard = id => (/^\d+$/.test(String(id)) ? `https://app.pipefy.com/open-cards/${id}` : null);
const VENDA = new Set([C.RD_STAGE_VENDIDO, C.RD_STAGE_VENDA_EFETIVADA, C.RD_STAGE_ENTREGA_TECNICA]);

// ─── Contexto: tudo que as checagens leem de fora (CRM e banco). Em teste é substituído por dados falsos. ──────────────────

function lerCard(deal, get) {
    return {
        id: String(deal.id || deal._id || ""), rdId: deal.rd_deal_id ? String(deal.rd_deal_id) : null, nome: deal.name || "",
        pci: get(deal, "PERFIL PCI"), segmento: get(deal, "SEGMENTO DE PRODUTO"), classe: get(deal, "CLASSE DE PREÇO"),
        revenda: get(deal, "REVENDA/LOJA"), representante: get(deal, "REPRESENTANTE"), responsavel: deal.user && deal.user.name ? String(deal.user.name).trim() : "", maquina: get(deal, "MÁQUINA DE INTERESSE"),
        valor: Number(deal.amount_total || 0), etapaId: deal.deal_stage ? deal.deal_stage.id : null, criadoEm: deal.created_at || null, deal,
        cnpj: String(get(deal, "CNPJ") || "").replace(/\D/g, ""), fechadoEm: deal.closed_at || deal.updated_at || null,
    };
}

function criarContexto({ dryRun, rodada = "manual" }) {
    let cache = null;
    return {
        dryRun, rodada, avisos: [],
        async cards() {
            if (!cache) {
                const rd = require("./rd.leads.service");
                cache = (await rd.getLeads("admin", "adm")).map(d => lerCard(d, rd.getCustomField));
            }
            return cache;
        },
        desfechoDoCard: d => require("./pci12Desfecho.service").desfechoDoCard(d),
        zen: { configurado: () => require("./zenNf.service").configurado(), notasDoCnpj: c => require("./zenNf.service").notasDoCnpj(c) },
        db: {
            async snapshot() {
                const rows = await sequelize.query(`SELECT card_id, pci, produto, classe FROM bmax_auditoria_cards_ultimo`, { type: QueryTypes.SELECT });
                return new Map(rows.map(r => [r.card_id, r]));
            },
            async creditados() {
                const rows = await sequelize.query(`SELECT DISTINCT lead_id FROM bmax_transacoes WHERE tipo = 'credito' AND lead_id IS NOT NULL`, { type: QueryTypes.SELECT });
                return new Set(rows.map(r => String(r.lead_id)));
            },
            async pcixPrazos() {
                return sequelize.query(`SELECT deal_id, iniciado_em FROM bmax_pcix_prazo WHERE encerrado_em IS NULL`, { type: QueryTypes.SELECT });
            },
            async ultimaRodadaAgendada() {
                const r = await sequelize.query(`SELECT iniciado_em FROM bmax_auditoria_execucoes WHERE rodada <> 'manual' ORDER BY iniciado_em DESC LIMIT 1`, { type: QueryTypes.SELECT });
                return r[0] ? new Date(r[0].iniciado_em) : null;
            },
            async mudancasRecentes() {
                return sequelize.query(
                    `SELECT id, card_id, campo, valor_antes, valor_depois, nome, revenda, severidade, detectado_em FROM bmax_auditoria_card_mudancas
                      WHERE detectado_em > now() - make_interval(days => :d) ORDER BY detectado_em DESC`, { replacements: { d: DIAS_MUDANCA_ABERTA }, type: QueryTypes.SELECT });
            },
            // grava as mudanças e atualiza o retrato (só as linhas novas ou alteradas) na mesma transação
            async gravar(mudancas, linhas) {
                await sequelize.transaction(async (transaction) => {
                    for (const m of mudancas) {
                        await sequelize.query(
                            `INSERT INTO bmax_auditoria_card_mudancas (card_id, campo, valor_antes, valor_depois, nome, revenda, severidade)
                             VALUES (:card_id, :campo, :antes, :depois, :nome, :revenda, :severidade)`, { replacements: m, type: QueryTypes.INSERT, transaction });
                    }
                    for (let i = 0; i < linhas.length; i += 400) {
                        const p = linhas.slice(i, i + 400);
                        await sequelize.query(
                            `INSERT INTO bmax_auditoria_cards_ultimo (card_id, pci, produto, classe, nome, revenda)
                             SELECT * FROM unnest(ARRAY[:ids]::text[], ARRAY[:pcis]::text[], ARRAY[:produtos]::text[], ARRAY[:classes]::text[], ARRAY[:nomes]::text[], ARRAY[:revendas]::text[])
                             ON CONFLICT (card_id) DO UPDATE SET pci = EXCLUDED.pci, produto = EXCLUDED.produto, classe = EXCLUDED.classe,
                                nome = EXCLUDED.nome, revenda = EXCLUDED.revenda, atualizado_em = now()`,
                            { replacements: { ids: p.map(x => x.card_id), pcis: p.map(x => x.pci), produtos: p.map(x => x.produto), classes: p.map(x => x.classe), nomes: p.map(x => x.nome), revendas: p.map(x => x.revenda) }, type: QueryTypes.INSERT, transaction });
                    }
                });
            },
            async prazos12a(ids) {
                if (!ids.length) return new Map();
                const rows = await sequelize.query(`SELECT deal_id, assumido_em, resultado FROM bmax_pci12a_prazo WHERE deal_id IN (:ids)`, { replacements: { ids }, type: QueryTypes.SELECT });
                return new Map(rows.map(r => [String(r.deal_id), r]));
            },
            async andamentos(ids) { return require("./negociacaoStatus.service").ultimosPorDeal(ids); },
        },
    };
}

// ─── Checagens (cada uma devolve uma lista de achados; só lê) ─────────────────────────────────────────────

// Saldo guardado (bmax_saldo) x soma dos lançamentos (bmax_transacoes). Fonte única do saldo = razão (regra de 25/11).
async function checarSaldoVsRazao() {
    const linhas = await sequelize.query(
        `SELECT COALESCE(s.tipo_agente, t.tipo_agente) AS tipo_agente, COALESCE(s.revenda, t.revenda) AS nome,
                s.saldo::float AS saldo, COALESCE(t.soma, 0)::float AS soma, (s.id IS NULL) AS sem_carteira
           FROM bmax_saldo s
           FULL OUTER JOIN (
                SELECT tipo_agente, revenda, SUM(CASE WHEN tipo = 'credito' THEN valor ELSE -valor END) AS soma
                  FROM bmax_transacoes GROUP BY tipo_agente, revenda
           ) t ON t.tipo_agente = s.tipo_agente AND t.revenda = s.revenda`,
        { type: QueryTypes.SELECT }
    );
    const achados = [];
    for (const l of linhas) {
        const saldo = l.sem_carteira ? 0 : Number(l.saldo || 0);
        const dif = Number((saldo - l.soma).toFixed(2));
        if (Math.abs(dif) < TOLERANCIA_SALDO) continue;
        achados.push({
            chave: `saldo_vs_razao:${l.tipo_agente}:${l.nome}`,
            grupo: "dinheiro", checagem: "saldo_vs_razao",
            severidade: Math.abs(dif) >= 100 ? "alta" : "media",
            titulo: l.sem_carteira
                ? `Há lançamentos sem carteira de saldo: ${l.tipo_agente} "${l.nome}" (soma dos lançamentos ${brl(l.soma)})`
                : `Saldo da carteira ${l.tipo_agente} "${l.nome}" difere da soma dos lançamentos em ${brl(dif)}`,
            detalhe: { tipo_agente: l.tipo_agente, carteira: l.nome, saldo_guardado: saldo, soma_dos_lancamentos: l.soma, diferenca: dif },
            acao: "NÃO corrigir o saldo ainda. Primeiro conferir no Extrato de Comissões se o erro está nos lançamentos (duplicidade, crédito sem débito, estorno).",
        });
    }
    return achados;
}

// Volume de créditos em 24h acima do limite do monitor dos robôs (incidente de 24/11). Só lê; não envia o e-mail do monitor.
async function checarCreditosAnormais() {
    const porTipo = await sequelize.query(
        `SELECT tipo_agente, count(*)::int n, COALESCE(sum(valor),0)::float v FROM bmax_transacoes
          WHERE tipo = 'credito' AND criado_em > now() - interval '24 hours' GROUP BY 1`, { type: QueryTypes.SELECT });
    const n = porTipo.reduce((s, x) => s + x.n, 0), v = porTipo.reduce((s, x) => s + x.v, 0);
    if (n <= LIM_CREDITOS_24H && v <= LIM_VALOR_24H) return [];
    return [{
        chave: `creditos_anormais:${hojeBRT()}`,
        grupo: "dinheiro", checagem: "creditos_anormais", severidade: "alta",
        titulo: `Volume anormal de créditos nas últimas 24h: ${n} créditos, ${brl(v)} (normal: até ${LIM_CREDITOS_24H} e ${brl(LIM_VALOR_24H)})`,
        detalhe: { creditos: n, valor: v, por_tipo: porTipo },
        acao: "Conferir se é venda grande legítima ou crédito duplicado (já aconteceu na virada para o Pipefy) antes de aprovar qualquer saque.",
    }];
}

// Robô esperado sem sucesso dentro do prazo, ou cuja última execução falhou. Mesma regra do vigia, sem enviar e-mail.
async function checarRobos() {
    const hist = await sequelize.query(`SELECT MIN(iniciado_em) AS desde FROM bmax_robo_execucoes`, { type: QueryTypes.SELECT });
    const desde = hist[0] && hist[0].desde ? new Date(hist[0].desde) : null;
    if (!desde || Date.now() - desde.getTime() < 30 * 3600 * 1000) return [];   // histórico curto: o vigia também espera
    const linhas = await sequelize.query(
        `SELECT robo, MAX(iniciado_em) FILTER (WHERE ok) AS ultimo_ok, MAX(iniciado_em) AS ultimo FROM bmax_robo_execucoes GROUP BY robo`, { type: QueryTypes.SELECT });
    const mapa = new Map(linhas.map(l => [l.robo, l]));
    const ultimas = await sequelize.query(
        `SELECT DISTINCT ON (robo) robo, ok, erro, iniciado_em FROM bmax_robo_execucoes WHERE robo <> 'alerta-creditos' ORDER BY robo, iniciado_em DESC`, { type: QueryTypes.SELECT });
    const achados = [];
    for (const [robo, horas] of Object.entries(ESPERADOS)) {
        const l = mapa.get(robo);
        const idadeH = l && l.ultimo_ok ? (Date.now() - new Date(l.ultimo_ok).getTime()) / 3600000 : null;
        if (idadeH === null || idadeH > horas) {
            achados.push({
                chave: `robo_sem_sucesso:${robo}`, grupo: "robos", checagem: "robo_sem_sucesso", severidade: "alta",
                titulo: idadeH === null ? `Robô "${robo}" nunca teve sucesso no histórico do monitor` : `Robô "${robo}" sem sucesso há ${Math.floor(idadeH)}h (limite ${horas}h)`,
                detalhe: { robo, ultimo_sucesso: l && l.ultimo_ok ? new Date(l.ultimo_ok).toISOString() : null, limite_horas: horas },
                acao: "Ver a última execução em Gestão > Auditor diário e o log da Vercel do robô.",
            });
        }
    }
    for (const u of ultimas) {
        if (u.ok || !(u.robo in ESPERADOS)) continue;
        achados.push({
            chave: `robo_ultima_falhou:${u.robo}`, grupo: "robos", checagem: "robo_ultima_falhou", severidade: "media",
            titulo: `A última execução do robô "${u.robo}" falhou`,
            detalhe: { robo: u.robo, quando: new Date(u.iniciado_em).toISOString(), erro: u.erro },
            acao: "Conferir o erro e se a próxima rodada já recuperou.",
        });
    }
    return achados;
}

// Nome do responsável pelo card, para o título de todo achado de card (quem precisa agir sabe a quem procurar).
const respTxt = c => ` · responsável: ${String(c && c.responsavel || "").trim() || "(ninguém)"}`;

// Venda concluída (Vendido / Venda Efetivada / Entrega Técnica, valor > 0) com PCI, produto, classe, revenda ou representante em branco.
// Sem PCI e Classe a comissão não é creditada; os demais atrapalham relatório e cobrança.
async function checarVendaSemDados(ctx) {
    const achados = [];
    for (const c of await ctx.cards()) {
        if (!VENDA.has(c.etapaId) || !(c.valor > 0)) continue;
        const faltando = A.camposFaltandoNaVenda(c);
        if (!faltando.length) continue;
        const bloqueiaComissao = faltando.includes("PCI") || faltando.includes("Classe de preço");
        achados.push({
            chave: `venda_sem_dados:${c.id}`, grupo: "cards", checagem: "venda_sem_dados", severidade: bloqueiaComissao ? "alta" : "media",
            titulo: `Venda "${c.nome}" (${String(c.revenda).trim() || "sem revenda"}, ${brl(c.valor)}) sem: ${faltando.join(", ")}${respTxt(c)}`,
            detalhe: { card: c.id, nome: c.nome, revenda: c.revenda, representante: c.representante, responsavel: c.responsavel || "", valor: c.valor, faltando },
            link: linkCard(c.id),
            acao: bloqueiaComissao ? "Preencher no card. Sem PCI e Classe de preço a comissão não é creditada." : "Preencher no card para o relatório e a cobrança ficarem completos.",
        });
    }
    return achados;
}

// PCI que não combina com o produto do card (Robô = PCI 1,2,3,13; Laser = 4,5,6,14; Máquinas = 7 a 12b e 15). Segmento do card manda;
// sem segmento, usa o texto da "Máquina de interesse" só como indício (gravidade baixa).
async function checarPciXProduto(ctx) {
    const achados = [];
    for (const c of await ctx.cards()) {
        const r = A.pciIncompativelComProduto(c);
        if (!r) continue;
        const pciTxt = A.pciKey(c.pci);
        achados.push({
            chave: `pci_x_produto:${c.id}`, grupo: "cards", checagem: "pci_x_produto", severidade: r.origem === "segmento" ? "media" : "baixa",
            titulo: `"${c.nome}" (${String(c.revenda).trim() || "sem revenda"}): ${pciTxt} é de ${A.ROTULO_PRODUTO[r.esperado]}, mas ${r.origem === "segmento" ? "o produto do card" : "a máquina de interesse"} indica ${A.ROTULO_PRODUTO[r.encontrado]}${respTxt(c)}`,
            detalhe: { card: c.id, nome: c.nome, pci: pciTxt, esperado: r.esperado, encontrado: r.encontrado, origem: r.origem, maquina: c.maquina },
            link: linkCard(c.id),
            acao: "Conferir se o PCI ou o produto está errado e corrigir no card.",
        });
    }
    return achados;
}

// PCI X só vale para máquina que não é BMax e máscara. Acusa PCI X em produto da família BMax (deveria ser o PCI do produto) e em consumível.
async function checarPciXProduto2(ctx) {
    const E = require("./escopoBmax.service");
    if (!E.pcixAtivo()) return [];      // módulo PCI X desligado (PCIX_ATIVO)
    const achados = [];
    for (const c of await ctx.cards()) {
        if (A.pciKey(c.pci) !== "PCIX") continue;
        const tipo = E.tipoDoProduto(c.maquina);
        if (tipo !== "bmax" && tipo !== "consumivel") continue;
        achados.push({
            chave: `pcix_produto:${c.id}`, grupo: "cards", checagem: "pcix_produto", severidade: "media",
            titulo: `"${c.nome}" (${String(c.revenda).trim() || "sem revenda"}): PCI X com ${tipo === "bmax" ? "produto da linha BMax" : "consumível"} (${String(c.maquina).trim()}); PCI X é só para máquina que não é BMax e máscara${respTxt(c)}`,
            detalhe: { card: c.id, nome: c.nome, maquina: c.maquina, tipo, responsavel: c.responsavel || "", revenda: c.revenda },
            link: linkCard(c.id),
            acao: tipo === "bmax" ? "Trocar o PCI para o do produto BMax (13, 14 ou 15 se veio da revenda)." : "Consumível não é permitido no BMax: Sem PCI, Sem revenda, Sem representante e comentário no card.",
        });
    }
    return achados;
}

// Resumo diário do PCI X por revenda (quantos abertos, vencidos do prazo de 30 dias, vendidos e perdidos). Não é erro: é para o André acompanhar.
async function checarPciXResumo(ctx) {
    if (!require("./escopoBmax.service").pcixAtivo()) return [];      // módulo PCI X desligado (PCIX_ATIVO)
    const px = require("./pciX.service");
    const cards = (await ctx.cards()).filter(c => A.pciKey(c.pci) === "PCIX");
    if (!cards.length) return [];
    const prazos = new Map();
    try { for (const r of await ctx.db.pcixPrazos()) prazos.set(String(r.deal_id), r); } catch (e) { if (!ctx.dryRun) throw e; }
    const perdido = new Set([C.RD_STAGE_PERDIDO, C.RD_STAGE_PERDIDO_REVENDA, C.RD_STAGE_EXCLUIDO].filter(Boolean));
    const porRevenda = new Map();
    for (const c of cards) {
        const rev = String(c.revenda || "").trim() || "(sem revenda)";
        const g = porRevenda.get(rev) || { revenda: rev, abertos: 0, vencidos: 0, vendidos: 0, perdidos: 0, cards: [] };
        if (VENDA.has(c.etapaId)) g.vendidos++;
        else if (perdido.has(c.etapaId)) g.perdidos++;
        else {
            g.abertos++;
            const r = prazos.get(c.id) || (c.rdId && prazos.get(c.rdId));
            const dias = r ? px.situacao(r.iniciado_em).dias : 0;
            if (r && px.situacao(r.iniciado_em).vencido) g.vencidos++;
            g.cards.push({ id: c.id, nome: c.nome, dias, representante: String(c.representante || "").trim() || "(sem representante)", responsavel: c.responsavel || "" });
        }
        porRevenda.set(rev, g);
    }
    return [...porRevenda.values()].map(g => ({
        chave: `pcix_resumo:${g.revenda}`, grupo: "prazos", checagem: "pcix_resumo", severidade: "baixa", reavisoDias: 0.8,
        titulo: `PCI X · ${g.revenda}: ${g.abertos} em aberto${g.vencidos ? ` (${g.vencidos} com o prazo de 30 dias vencido)` : ""}, ${g.vendidos} vendido(s), ${g.perdidos} perdido(s)`,
        detalhe: g,
        acao: "Acompanhamento diário dos leads de produto não BMax repassados à revenda (sem cashback). Prazo de 30 dias.",
    }));
}

// PCI12 / PCI12a em aberto com responsável diferente do André Coelho (regra do projeto). Só avisa: quem decide e corrige é o André.
async function checarPci12Responsavel(ctx) {
    const achados = [];
    for (const c of await ctx.cards()) {
        if (VENDA.has(c.etapaId)) {
            // Vendido: o responsável é quem vendeu (12b) ou o André (12a). Mas PCI12 puro (pendente) não pode estar em venda: o PCI está errado.
            if (A.pciKey(c.pci) !== "PCI12") continue;
            achados.push({
                chave: `pci12_em_venda:${c.id}`, grupo: "cards", checagem: "pci12_responsavel", severidade: "media",
                titulo: `"${c.nome}" (${String(c.revenda).trim() || "sem revenda"}): vendido com PCI12 (pendente), que não pode concluir venda; deveria ser PCI12a ou PCI12b${respTxt(c)}`,
                detalhe: { card: c.id, nome: c.nome, pci: "PCI12", responsavel: String(c.responsavel || "").trim() || "(ninguém)", revenda: c.revenda },
                link: linkCard(c.id),
                acao: "Definir se foi 12a (revenda atende, responsável André) ou 12b (Boxer atende, responsável de quem vendeu) e corrigir o PCI no card. O auditor não corrige sozinho.",
            });
            continue;
        }
        const r = A.pci12ResponsavelErrado(c);
        if (!r) continue;
        achados.push({
            chave: `pci12_responsavel:${c.id}`, grupo: "cards", checagem: "pci12_responsavel", severidade: "media",
            titulo: `"${c.nome}" (${String(c.revenda).trim() || "sem revenda"}): ${A.pciKey(c.pci)} está com ${r.encontrado} como responsável; pela regra do projeto deve ser ${r.esperado}`,
            detalhe: { card: c.id, nome: c.nome, pci: A.pciKey(c.pci), responsavel: r.encontrado, esperado: r.esperado, revenda: c.revenda },
            link: linkCard(c.id),
            acao: "Conferir no Pipefy e devolver o responsável ao André Coelho (o auditor não corrige sozinho).",
        });
    }
    return achados;
}

// Venda do CRM x nota no ZEN (Fase A, 27/11/2026): cards vendidos nos últimos 30 dias. Só avisa; não altera Pipefy nem ZEN.
// "Sem nota" só depois de 3 dias do fechamento. Valor até 4% diferente da nota vira "valor sugerido" (candidato ao ajuste automático da Fase B).
const DIAS_OLHAR_VENDAS_ZEN = 30;
async function checarVendasZen(ctx) {
    const V = require("./vendasZen.service");
    const hoje = hojeBRT();
    const desde = new Date(Date.now() - DIAS_OLHAR_VENDAS_ZEN * 86400000).toISOString().slice(0, 10);
    const cards = (await ctx.cards()).filter(c => VENDA.has(c.etapaId) && c.valor > 0 && !V.ehTeste(c)
        && String(c.fechadoEm || "").slice(0, 10) >= desde && A.pciKey(c.pci) !== "PCI12A");   // PCI12a: a revenda vende, não há nota da Boxer
    if (!cards.length) return [];
    if (!ctx.zen.configurado()) throw new Error("ZEN_EMAIL/ZEN_SENHA não configurados: não dá para conferir as vendas com o ZEN");
    const nfsPorCnpj = new Map();
    let falhas = 0;
    const cnpjs = [...new Set(cards.filter(c => c.cnpj.length === 14).map(c => c.cnpj))];
    for (const cnpj of cnpjs) {
        try { nfsPorCnpj.set(cnpj, await ctx.zen.notasDoCnpj(cnpj)); } catch (e) { falhas++; logger.warn({ message: "Auditor: falha ao ler notas do ZEN", error: e.message }); }
    }
    if (cnpjs.length && falhas === cnpjs.length) throw new Error("não foi possível ler nenhuma nota do ZEN");
    const comNotas = cards.filter(c => nfsPorCnpj.has(c.cnpj));
    const res = V.avaliarVendas(comNotas, nfsPorCnpj);
    const achados = [];
    for (const c of comNotas) {
        const r = res.get(c.id);
        if (!r || r.estado === "ok" || r.estado === "ok_soma") continue;
        const base = { card: c.id, nome: c.nome, cnpj: c.cnpj, valorCard: c.valor, fechadoEm: String(c.fechadoEm || "").slice(0, 10), responsavel: String(c.responsavel || "").trim() || "(ninguém)", revenda: c.revenda };
        if (r.estado === "sem_nota") {
            if ((new Date(hoje) - new Date(String(c.fechadoEm).slice(0, 10))) / 86400000 < V.DIAS_ESPERA_SEM_NOTA) continue;
            achados.push({
                chave: `venda_sem_nota_zen:${c.id}`, grupo: "cards", checagem: "venda_sem_nota_zen", severidade: "media",
                titulo: `"${c.nome}" (${brl(c.valor)}, vendido em ${base.fechadoEm}): nenhuma nota do CNPJ no ZEN na janela da venda${respTxt(c)}`,
                detalhe: base, link: linkCard(c.id),
                acao: "Conferir se a nota foi emitida (talvez com outro CNPJ) ou se o card está vendido sem venda real. O auditor não altera nada.",
            });
        } else {
            const sug = r.sugerido != null;
            achados.push({
                chave: `venda_valor_zen:${c.id}`, grupo: "cards", checagem: "venda_valor_zen", severidade: sug ? "baixa" : "media",
                titulo: `"${c.nome}": card ${brl(c.valor)}, nota ${r.nota} ${brl(r.notaTotal)} (${r.notaData}), diferença ${brl(r.diff)} (${(r.pct * 100).toFixed(1).replace(".", ",")}%)${respTxt(c)}`,
                detalhe: { ...base, nota: r.nota, notaData: r.notaData, notaTotal: r.notaTotal, diferenca: r.diff, pct: r.pct, valorSugerido: r.sugerido },
                link: linkCard(c.id),
                acao: sug ? `Ajustar o valor do card para ${brl(r.sugerido)} (total da nota), se a nota for dessa venda.`
                          : "Diferença acima de 4%: pode ser faturamento parcial, produto diferente ou valor errado no card. Conferir antes de ajustar.",
            });
        }
    }
    return achados;
}

// Mudança de PCI, produto ou classe em relação ao último retrato. A 1ª rodada só grava a linha de base. Preencher campo vazio e a decisão
// PCI12 -> 12a/12b não contam. Gravidade: alta se a venda já foi creditada (a comissão pode ter ficado errada), média se vendida, baixa se aberta.
async function checarMudancasCampos(ctx) {
    let snapshot;
    try {
        snapshot = await ctx.db.snapshot();
    } catch (e) {
        if (!ctx.dryRun) throw e;
        ctx.avisos.push("Checagem de mudanças de PCI/produto/classe: as tabelas do auditor ainda não existem, então nada foi comparado.");
        return [];
    }
    const cards = await ctx.cards();
    const linhas = cards.map(c => ({ card_id: c.id, pci: A.pciKey(c.pci), produto: A.produtoKey(c.segmento), classe: A.classeKey(c.classe), nome: c.nome, revenda: String(c.revenda || "").trim() }));
    if (snapshot.size === 0) {
        if (!ctx.dryRun) await ctx.db.gravar([], linhas);
        ctx.avisos.push("Primeira rodada da checagem de mudanças: " + (ctx.dryRun ? "seria gravada" : "foi gravada") + " a linha de base de " + linhas.length + " cards. Mudanças só aparecem a partir da próxima rodada.");
        return [];
    }
    const creditados = await ctx.db.creditados();
    const novasMudancas = [], paraGravar = [];
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i], l = linhas[i], antes = snapshot.get(l.card_id);
        if (!antes) { paraGravar.push(l); continue; }                     // card novo no escopo: só entra no retrato
        const mudou = A.diffCampos({ pci: antes.pci, produto: antes.produto, classe: antes.classe }, l);
        if (!mudou.length) continue;
        const creditado = creditados.has(c.id) || (c.rdId && creditados.has(c.rdId));
        const severidade = creditado ? "alta" : VENDA.has(c.etapaId) ? "media" : "baixa";
        for (const m of mudou) novasMudancas.push({ card_id: l.card_id, campo: m.campo, antes: m.de, depois: m.para, nome: l.nome, revenda: l.revenda, severidade });
        paraGravar.push(l);
    }
    if (!ctx.dryRun && (novasMudancas.length || paraGravar.length)) await ctx.db.gravar(novasMudancas, paraGravar);

    const respPorCard = new Map(cards.map(c => [String(c.id), c.responsavel]));
    const recentes = (await ctx.db.mudancasRecentes()).map(r => ({ ...r, antes: r.valor_antes, depois: r.valor_depois }));
    const emMemoria = ctx.dryRun ? novasMudancas.map(m => ({ ...m, id: `novo:${m.card_id}:${m.campo}` })) : [];
    return [...recentes, ...emMemoria].map(m => ({
        chave: `mudanca:${m.id}`, grupo: "cards", checagem: "mudanca_campos", severidade: m.severidade || "baixa",
        titulo: `"${m.nome}" (${m.revenda || "sem revenda"}): ${A.ROTULO_CAMPO[m.campo]} mudou de ${A.mostrarValor(m.campo, m.antes)} para ${A.mostrarValor(m.campo, m.depois)}${m.severidade === "alta" ? " (venda já creditada)" : ""}${respTxt({ responsavel: respPorCard.get(String(m.card_id)) })}`,
        detalhe: { card: m.card_id, campo: m.campo, antes: m.antes, depois: m.depois },
        link: linkCard(m.card_id),
        acao: m.severidade === "alta" ? "Conferir no Extrato de Comissões se a comissão já creditada continua correta e se a mudança foi intencional." : "Conferir se a mudança foi intencional.",
    }));
}

// PCI12a em aberto sem resposta da revenda (nenhum andamento no Portal, ou último status Pendente/Sem retorno), por revenda e representante,
// para a cobrança. Casa os dois ids do card (Pipefy e RD): os controles antigos guardam o id do RD.
async function checarPci12aSemResposta(ctx) {
    const cards = (await ctx.cards()).filter(c => A.pciKey(c.pci) === "PCI12A" && !ctx.desfechoDoCard(c.deal));
    if (!cards.length) return [];
    const ids = [...new Set(cards.flatMap(c => [c.id, c.rdId]).filter(Boolean))];
    const [prazos, andamentos] = await Promise.all([ctx.db.prazos12a(ids), ctx.db.andamentos(ids)]);
    const agora = Date.now(), semResposta = [];
    for (const c of cards) {
        const prazo = prazos.get(c.id) || (c.rdId && prazos.get(c.rdId));
        if (prazo && prazo.resultado) continue;                                   // já tem desfecho no Portal
        if (!A.semRespostaDaRevenda(andamentos.get(c.id) || (c.rdId && andamentos.get(c.rdId)) || null)) continue;
        const desde = prazo && prazo.assumido_em ? new Date(prazo.assumido_em) : c.criadoEm ? new Date(c.criadoEm) : null;
        semResposta.push({ id: c.id, nome: c.nome, revenda: c.revenda, representante: c.representante, responsavel: c.responsavel, dias: desde ? Math.max(0, Math.floor((agora - desde.getTime()) / 86400000)) : 0 });
    }
    return A.agruparSemResposta(semResposta).map(g => ({
        chave: `pci12a_sem_resposta:${g.revenda}`, grupo: "prazos", checagem: "pci12a_sem_resposta", severidade: g.maisAntigoDias >= 50 ? "alta" : "media",
        titulo: `${g.revenda}: ${g.total} card(s) PCI12a sem resposta (o mais antigo há ${g.maisAntigoDias} dias) · rep.: ${Object.entries(g.representantes).map(([r, n]) => `${r} (${n})`).join(", ")}`,
        detalhe: { revenda: g.revenda, total: g.total, maisAntigoDias: g.maisAntigoDias, representantes: g.representantes, cards: g.cards },
        acao: "Cobrar a revenda (e avisar o representante) para registrar o andamento no Portal. O prazo do PCI12a é de 60 dias.",
    }));
}

// Rodadas agendadas (manhã 09h UTC, tarde 16h UTC): o intervalo normal entre duas é de 6 a 18h. Mais de 20h desde a rodada anterior = uma rodada
// não aconteceu (a Vercel pode pular cron). Só vale para rodada agendada; a manual e a simulação não entram. Some sozinho na rodada seguinte.
const LIMITE_RODADA_PERDIDA_H = 20;
async function checarRodadaPerdida(ctx) {
    if (ctx.dryRun || ctx.rodada === "manual") return [];
    const ultima = await ctx.db.ultimaRodadaAgendada();
    if (!ultima) return [];                       // primeira rodada agendada da história
    const horas = (Date.now() - ultima.getTime()) / 3600000;
    if (horas <= LIMITE_RODADA_PERDIDA_H) return [];
    return [{
        chave: `auditor_rodada_perdida:${hojeBRT()}`, grupo: "robos", checagem: "auditor_rodada_perdida", severidade: "media",
        titulo: `O auditor ficou ${Math.floor(horas)}h sem rodar (a rodada anterior foi em ${ultima.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}): pelo menos uma rodada não aconteceu`,
        detalhe: { ultima_rodada: ultima.toISOString(), horas: Math.floor(horas) },
        acao: "Provável pulo do cron da Vercel. Se repetir, mover o agendamento para um serviço com horário exato.",
    }];
}

// `cobre`: os tipos de achado (campo `checagem`) que esta função consegue dar como resolvidos quando roda sem erro e não os encontra mais.
const CHECAGENS = [
    { id: "saldo_vs_razao", grupo: "dinheiro", cobre: ["saldo_vs_razao"], roda: checarSaldoVsRazao },
    { id: "creditos_anormais", grupo: "dinheiro", cobre: ["creditos_anormais"], roda: checarCreditosAnormais },
    { id: "robos", grupo: "robos", cobre: ["robo_sem_sucesso", "robo_ultima_falhou"], roda: checarRobos },
    { id: "venda_sem_dados", grupo: "cards", cobre: ["venda_sem_dados"], roda: checarVendaSemDados },
    { id: "pci_x_produto", grupo: "cards", cobre: ["pci_x_produto"], roda: checarPciXProduto },
    { id: "pci12_responsavel", grupo: "cards", cobre: ["pci12_responsavel"], roda: checarPci12Responsavel },
    { id: "pcix_produto", grupo: "cards", cobre: ["pcix_produto"], roda: checarPciXProduto2 },
    { id: "pcix_resumo", grupo: "prazos", cobre: ["pcix_resumo"], roda: checarPciXResumo },
    { id: "vendas_zen", grupo: "cards", cobre: ["venda_sem_nota_zen", "venda_valor_zen"], roda: checarVendasZen },
    { id: "mudancas_campos", grupo: "cards", cobre: ["mudanca_campos"], roda: checarMudancasCampos },
    { id: "pci12a_sem_resposta", grupo: "prazos", cobre: ["pci12a_sem_resposta"], roda: checarPci12aSemResposta },
    { id: "rodada_perdida", grupo: "robos", cobre: ["auditor_rodada_perdida"], roda: checarRodadaPerdida },
];

// ─── Comparação com o que já estava aberto (função pura, testada sem banco) ───────────────────────────────

// atuais: achados desta rodada. abertos: linhas de bmax_auditoria_achados com resolvido_em NULL.
// checagensOk: tipos de achado (`checagem`) cobertos por checagens que rodaram sem erro, mais a chave "auditor_checagem_falhou:<id>" de cada
// uma delas. Só o que está nesse conjunto pode ser dado como resolvido: checagem que falhou ao rodar nunca resolve nada.
function reconciliar(atuais, abertos, checagensOk, agora = new Date(), reavisoDias = REAVISO_DIAS) {
    const abertosPorChave = new Map(abertos.map(a => [a.chave, a]));
    const chavesAtuais = new Set(atuais.map(a => a.chave));
    const limite = agora.getTime() - reavisoDias * 86400000;
    const novos = [], persistentes = [];
    for (const a of atuais) (abertosPorChave.has(a.chave) ? persistentes : novos).push(a);
    const okSet = new Set(checagensOk);
    const resolvidos = abertos.filter(a => !chavesAtuais.has(a.chave) && (okSet.has(a.checagem) || okSet.has(a.chave)));
    // Persistente só volta ao e-mail quando venceu o lembrete semanal (ou nunca foi avisado)
    const lembretes = persistentes.filter(a => {
        const antigo = abertosPorChave.get(a.chave);
        const limiteDele = a.reavisoDias ? agora.getTime() - a.reavisoDias * 86400000 : limite;   // ex.: resumo do PCI X avisa todo dia
        return !antigo.ultimo_aviso_em || new Date(antigo.ultimo_aviso_em).getTime() < limiteDele;
    });
    return { novos, persistentes, resolvidos, lembretes, paraAvisar: [...novos, ...lembretes] };
}

// ─── E-mail ───────────────────────────────────────────────────────────────────────────────────────────────

const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const COR_SEV = { alta: "#e30613", media: "#e8890c", baixa: "#6b7280" };

// Tema = tipo de achado. A ordem é a do e-mail e da aba: dinheiro primeiro, depois robôs, dados que travam comissão, mudanças, PCI x produto e cobrança.
const TEMAS = [
    ["saldo_vs_razao", "1. Saldo diferente do extrato"],
    ["creditos_anormais", "2. Créditos anormais nas últimas 24h"],
    ["auditor_checagem_falhou", "3. Checagens do auditor que falharam"],
    ["auditor_rodada_perdida", "3. Rodada do auditor que não aconteceu"],
    ["robo_sem_sucesso", "4. Robôs sem sucesso no prazo"],
    ["robo_ultima_falhou", "5. Robôs com a última execução falha"],
    ["venda_sem_dados", "6. Vendas com dados faltando"],
    ["mudanca_campos", "7. Mudanças de PCI, produto ou classe"],
    ["pci_x_produto", "8. PCI que não combina com o produto"],
    ["pci12_responsavel", "9. PCI12/12a com responsável que não é o André"],
    ["pcix_produto", "10. PCI X com produto que não cabe (BMax ou consumível)"],
    ["pcix_resumo", "11. PCI X por revenda (resumo diário)"],
    ["pci12a_sem_resposta", "12. Cobrança: PCI12a sem resposta da revenda"],
    ["venda_sem_nota_zen", "13. Venda do CRM sem nota no ZEN"],
    ["venda_valor_zen", "14. Valor do card diferente da nota do ZEN"],
];
const ORDEM_SEV = { alta: 0, media: 1, baixa: 2 };
const ordemTema = c => { const i = TEMAS.findIndex(t => t[0] === c); return i < 0 ? TEMAS.length : i; };

// Cobrança do PCI12a: quem cobrar e de quê. Por representante (revendas e os cards, com link) e por revenda.
function blocoCobranca12a(achados) {
    if (!achados.length) return "";
    const totalCards = achados.reduce((s, a) => s + (a.detalhe.total || 0), 0);
    const porRep = {};
    for (const a of achados) for (const c of (a.detalhe.cards || [])) {
        const rep = (porRep[c.representante] = porRep[c.representante] || {});
        (rep[a.detalhe.revenda] = rep[a.detalhe.revenda] || []).push(c);
    }
    const cardLi = c => { const l = linkCard(c.id); return `${l ? `<a href="${esc(l)}">${esc(c.nome)}</a>` : esc(c.nome)} (${c.dias} dias${c.responsavel ? `, resp.: ${esc(c.responsavel)}` : ""})`; };
    const lista = Object.entries(porRep).sort((x, y) => Object.values(y[1]).flat().length - Object.values(x[1]).flat().length);
    return `<h3 style="margin:18px 0 6px">${esc(TEMAS.find(t => t[0] === "pci12a_sem_resposta")[1])} (${totalCards} cards em ${achados.length} revenda(s))</h3>
        <p style="margin:0 0 6px;color:#555;font-size:13px">Cards em que a revenda assumiu a venda e ainda não registrou andamento no Portal (ou deixou "Pendente"/"Sem retorno").</p>
        <p style="margin:10px 0 4px;color:#1d327b"><strong>Por representante</strong></p><ul style="margin:0;padding-left:18px">${lista.map(([rep, revs]) =>
            `<li style="margin-bottom:8px"><strong>${esc(rep)}</strong>: ${Object.values(revs).flat().length} card(s)<ul style="margin:2px 0 0;padding-left:18px">${Object.entries(revs).map(([rev, cs]) =>
                `<li>${esc(rev)} (${cs.length}): ${cs.map(cardLi).join("; ")}</li>`).join("")}</ul></li>`).join("")}</ul>
        <p style="margin:10px 0 4px;color:#1d327b"><strong>Por revenda</strong></p><ul style="margin:0;padding-left:18px">${achados.map(a =>
            `<li style="margin-bottom:4px"><strong>${esc(a.detalhe.revenda)}</strong>: ${a.detalhe.total} card(s), o mais antigo há ${a.detalhe.maisAntigoDias} dias${a.detalhe.maisAntigoDias >= 50 ? ' <span style="color:#e30613">(perto dos 60 dias)</span>' : ""}</li>`).join("")}</ul>`;
}

function montarEmail({ novos, lembretes, resolvidos, abertosTotal, atuais = [] }) {
    const bloco = (titulo, lista) => {
        if (!lista.length) return "";
        const porTema = new Map();
        for (const a of lista) (porTema.has(a.checagem) ? porTema.get(a.checagem) : porTema.set(a.checagem, []).get(a.checagem)).push(a);
        const temas = [...porTema.entries()].sort((x, y) => ordemTema(x[0]) - ordemTema(y[0]));
        return `<h3 style="margin:18px 0 6px">${esc(titulo)} (${lista.length})</h3>` + temas.map(([checagem, itens]) => {
            itens = itens.slice().sort((a, b) => (ORDEM_SEV[a.severidade] ?? 3) - (ORDEM_SEV[b.severidade] ?? 3));
            const visiveis = itens.slice(0, LIMITE_LINHAS_EMAIL), resto = itens.length - visiveis.length;
            const tema = TEMAS.find(t => t[0] === checagem);
            const linhas = visiveis.map(a => `<li style="margin-bottom:8px"><span style="color:${COR_SEV[a.severidade] || "#6b7280"};font-weight:bold">${esc((a.severidade || "").toUpperCase())}</span> ${esc(a.titulo)}${a.acao ? `<br><span style="color:#555;font-size:13px">O que fazer: ${esc(a.acao)}</span>` : ""}${a.link ? `<br><a href="${esc(a.link)}">abrir</a>` : ""}</li>`).join("")
                + (resto > 0 ? `<li style="color:#555;margin-bottom:8px">... e mais ${resto} do mesmo tipo. Veja todos em Gestão &gt; Auditor diário.</li>` : "");
            return `<p style="margin:10px 0 4px;color:#1d327b"><strong>${esc(tema ? tema[1] : checagem)} (${itens.length})</strong></p><ul style="margin:0;padding-left:18px">${linhas}</ul>`;
        }).join("");
    };
    const ehCobranca = a => a.checagem === "pci12a_sem_resposta";
    const avisarCobranca = [...novos, ...lembretes].some(ehCobranca);
    const assunto = `BMAX - Auditor diário: ${novos.length} novo(s), ${abertosTotal} em aberto`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:20px">
        <h2 style="color:#1d327b;margin-bottom:4px">Auditor diário do BMAX</h2>
        <p style="margin-top:0;color:#555">${novos.length} achado(s) novo(s) · ${lembretes.length} lembrete(s) semanal(is) · ${resolvidos.length} resolvido(s) desde a última rodada · ${abertosTotal} em aberto no total.</p>
        ${bloco("Novos", novos.filter(a => !ehCobranca(a)))}${bloco("Continuam abertos (lembrete semanal)", lembretes.filter(a => !ehCobranca(a)))}${avisarCobranca ? blocoCobranca12a(atuais.filter(ehCobranca)) : ""}${bloco("Resolvidos desde a última rodada", resolvidos.map(r => ({ grupo: r.grupo, checagem: r.checagem, severidade: "baixa", titulo: r.titulo })))}
        <p style="font-size:12px;color:#666;margin-top:24px">Aviso automático do Portal BMAX. O auditor só lê e avisa: nunca corrige nada. Detalhes em Gestão &gt; Auditor diário.</p></div>`;
    return { assunto, html };
}

// ─── Execução ─────────────────────────────────────────────────────────────────────────────────────────────

// dryRun: roda as checagens e devolve o resultado, sem gravar nada e sem enviar e-mail.
async function rodarAuditoria({ rodada = "manual", dryRun = false } = {}) {
    const t0 = Date.now();
    const ctx = criarContexto({ dryRun, rodada });
    const atuais = [], checagensOk = [], tempos = [];
    let erros = 0;

    for (const c of CHECAGENS) {
        const c0 = Date.now();
        try {
            const achados = await c.roda(ctx);
            achados.forEach(a => atuais.push(a));
            checagensOk.push(...c.cobre, `auditor_checagem_falhou:${c.id}`);
            tempos.push({ id: c.id, ms: Date.now() - c0, achados: achados.length });
        } catch (e) {
            erros++;
            logger.error({ message: "Auditor: checagem falhou", checagem: c.id, error: e.message });
            tempos.push({ id: c.id, ms: Date.now() - c0, erro: e.message });
            atuais.push({ chave: `auditor_checagem_falhou:${c.id}`, grupo: c.grupo, checagem: "auditor_checagem_falhou", severidade: "alta",
                titulo: `A checagem "${c.id}" do auditor falhou ao rodar: ${e.message}`, detalhe: { checagem: c.id, erro: e.message },
                acao: "Ver o log da Vercel. Enquanto isso essa checagem não está vigiando nada." });
        }
    }

    let tabelasAusentes = false;
    const abertos = await sequelize.query(`SELECT chave, checagem, grupo, titulo, ultimo_aviso_em FROM bmax_auditoria_achados WHERE resolvido_em IS NULL`, { type: QueryTypes.SELECT })
        .catch(e => { if (!dryRun) throw e; tabelasAusentes = true; return []; });   // simulação funciona antes de o DDL ser aplicado
    const r = reconciliar(atuais, abertos, checagensOk);

    const resumo = {
        ok: erros === 0, rodada, dryRun, duracaoMs: 0, checagens: tempos,
        total: atuais.length, novos: r.novos.length, persistentes: r.persistentes.length, resolvidos: r.resolvidos.length,
        lembretes: r.lembretes.length, avisados: 0, emailEnviado: false, avisos: ctx.avisos,
    };
    if (dryRun) {
        resumo.duracaoMs = Date.now() - t0;
        resumo.achados = atuais;
        resumo.resolvidosLista = r.resolvidos.map(x => x.chave);
        resumo.emailSeriaEnviado = r.paraAvisar.length > 0;
        if (tabelasAusentes) resumo.avisos.push("As tabelas do auditor ainda não existem: tudo aparece como novo.");
        return resumo;
    }

    for (const a of atuais) {
        await sequelize.query(
            `INSERT INTO bmax_auditoria_achados (chave, grupo, checagem, severidade, titulo, detalhe, link, acao_sugerida)
             VALUES (:chave, :grupo, :checagem, :severidade, :titulo, CAST(:detalhe AS jsonb), :link, :acao)
             ON CONFLICT (chave) DO UPDATE SET
                severidade = EXCLUDED.severidade, titulo = EXCLUDED.titulo, detalhe = EXCLUDED.detalhe, link = EXCLUDED.link, acao_sugerida = EXCLUDED.acao_sugerida,
                primeira_vez = CASE WHEN bmax_auditoria_achados.resolvido_em IS NOT NULL THEN now() ELSE bmax_auditoria_achados.primeira_vez END,
                ultimo_aviso_em = CASE WHEN bmax_auditoria_achados.resolvido_em IS NOT NULL THEN NULL ELSE bmax_auditoria_achados.ultimo_aviso_em END,
                resolvido_em = NULL, ultima_vez = now()`,
            { replacements: { chave: a.chave, grupo: a.grupo, checagem: a.checagem, severidade: a.severidade || "media", titulo: a.titulo, detalhe: JSON.stringify(a.detalhe || {}), link: a.link || null, acao: a.acao || null }, type: QueryTypes.INSERT }
        );
    }
    if (r.resolvidos.length) {
        await sequelize.query(`UPDATE bmax_auditoria_achados SET resolvido_em = now() WHERE chave IN (:chaves) AND resolvido_em IS NULL`,
            { replacements: { chaves: r.resolvidos.map(x => x.chave) }, type: QueryTypes.UPDATE });
    }

    if (r.paraAvisar.length) {
        const destino = process.env.EMAIL_AUDITOR;
        if (!destino) {
            erros++;
            resumo.erroEmail = "EMAIL_AUDITOR não configurado: há achados para avisar e nenhum e-mail foi enviado";
            logger.error({ message: resumo.erroEmail });
        } else {
            const { assunto, html } = montarEmail({ novos: r.novos, lembretes: r.lembretes, resolvidos: r.resolvidos, abertosTotal: atuais.length, atuais });
            const enviado = await sendEmail(destino, assunto, html).catch(() => false);
            if (enviado === false) {
                erros++;
                resumo.erroEmail = "falha ao enviar o e-mail do auditor";
            } else {
                resumo.emailEnviado = true;
                resumo.avisados = r.paraAvisar.length;
                await sequelize.query(`UPDATE bmax_auditoria_achados SET ultimo_aviso_em = now() WHERE chave IN (:chaves)`,
                    { replacements: { chaves: r.paraAvisar.map(x => x.chave) }, type: QueryTypes.UPDATE });
            }
        }
    }

    resumo.ok = erros === 0;
    if (erros) resumo.erros = erros;   // o monitor dos robôs (cronTracker) trata "erros" > 0 como falha e avisa o admin
    resumo.duracaoMs = Date.now() - t0;
    await sequelize.query(
        `INSERT INTO bmax_auditoria_execucoes (rodada, duracao_ms, total_achados, novos, resolvidos, avisados, email_enviado, resumo, erro)
         VALUES (:rodada, :ms, :total, :novos, :resolvidos, :avisados, :email, CAST(:resumo AS jsonb), :erro)`,
        { replacements: { rodada, ms: resumo.duracaoMs, total: resumo.total, novos: resumo.novos, resolvidos: resumo.resolvidos, avisados: resumo.avisados, email: resumo.emailEnviado, resumo: JSON.stringify({ checagens: tempos, avisos: ctx.avisos }), erro: resumo.erroEmail || null }, type: QueryTypes.INSERT }
    );
    return resumo;
}

module.exports = {
    rodarAuditoria, reconciliar, montarEmail, CHECAGENS, REAVISO_DIAS,
    checarRodadaPerdida, checarPci12Responsavel, checarVendaSemDados, checarPciXProduto, checarMudancasCampos, checarPci12aSemResposta, checarVendasZen,
};
