// Avisos por WhatsApp (canal SÓ de comunicação — nada é executado por lá; cada aviso leva o link do Portal).
// Este serviço monta a PRÉVIA do que seria enviado hoje a cada login de revenda. Não envia nada.
// Regras (André, 14/10/2026): sem nada a comunicar não sai mensagem; só revenda ativa no programa;
// só login com celular válido e aceite registrado; sem nome de cliente e sem % de comissão no texto.
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../database");
const { sbSistemasService } = require("../config/supabaseSistemas");
const { getLeads, getCustomField } = require("./rd.leads.service");
const { getSaldoGrupo, getCreditosProximosVencimentoGrupo } = require("./saldo.service");
const { buscarPrazos12a } = require("./pci12Tracking.service");
const { normalizarCelularBR } = require("./telefone.service");const { REVENDA_SEM_CREDITO, RD_STAGE_VENDA_EFETIVADA, RD_STAGE_VENDIDO, RD_STAGE_ENTREGA_TECNICA, RD_STAGE_PERDIDO, RD_STAGE_PERDIDO_REVENDA, RD_STAGE_EXCLUIDO } = require("../config/constants");

const PORTAL_URL = process.env.PORTAL_URL || "https://bmax.boxersoldas.com.br";
const MARCOS_CASHBACK = [30, 15, 7];     // dias para expirar
const MARCOS_12A = [15, 30, 50];         // dias desde que a revenda assumiu o lead (o prazo final é 60)
const FINAIS = new Set([RD_STAGE_VENDA_EFETIVADA, RD_STAGE_VENDIDO, RD_STAGE_ENTREGA_TECNICA, RD_STAGE_PERDIDO, RD_STAGE_PERDIDO_REVENDA, RD_STAGE_EXCLUIDO]);

const trim = s => String(s || "").trim();
const brl = v => "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const pciNorm = d => String(getCustomField(d, "PERFIL PCI") || "").replace(/\s/g, "").toUpperCase();

// Modelos de mensagem (templates) — o texto aprovado pela Meta/Twilio tem que ser IDÊNTICO a estes.
// Regras do WhatsApp: variável sem quebra de linha, modelo não começa nem termina em variável.
const MODELOS = {
    pci12: {
        nome: "bmax_pci12_decisao", categoria: "utilidade",
        corpo: "BMAX Boxer: você tem {{1}} aguardando sua decisão de caminho (PCI12). Escolha no Portal em até 48 horas úteis (sábado e domingo não contam); depois desse prazo o lead segue como \"Boxer vende\" e o time Boxer assume o atendimento. Acesse bmax.boxersoldas.com.br ou fale com seu representante Boxer."
    },
    resumo: {
        nome: "bmax_resumo_diario", categoria: "utilidade",
        corpo: "BMAX Boxer — resumo de hoje:\n\nLeads novos na sua tela: {{1}}\nCashback a vencer: {{2}}\nCashback disponível para usar: {{3}}\nLeads assumidos aguardando Vendido ou Perdido: {{4}}\n\nVeja os detalhes em bmax.boxersoldas.com.br"
    },
    incentivo: {
        nome: "bmax_incentivo_negociacao", categoria: "marketing (provável)",
        corpo: "BMAX Boxer: sua revenda não registrou novas negociações nos últimos {{1}} dias. Cada venda concluída gera cashback para você. Registre uma nova negociação em bmax.boxersoldas.com.br"
    }
};
const renderModelo = (m, vars) => m.corpo.replace(/\{\{(\d+)\}\}/g, (_, i) => vars[Number(i) - 1]);
const montarMensagem = (tipo, vars) => ({ tipo, template: MODELOS[tipo].nome, categoria: MODELOS[tipo].categoria, variaveis: vars, texto: renderModelo(MODELOS[tipo], vars) });

async function montarResumoDiario({ hoje = new Date() } = {}) {
    const [logins, grupos, cadAtivos, deals, prazos12a] = await Promise.all([
        sequelize.query(`SELECT u.id AS user_id, u.username, r.name, r.grupo, r.telefone, r.whatsapp_aceite_em FROM "Users" u JOIN "Revendas" r ON r.user_id = u.id WHERE u.role = 'revenda' ORDER BY u.username`, { type: QueryTypes.SELECT }),
        sequelize.query(`SELECT revenda_rd, grupo FROM bmax_grupos`, { type: QueryTypes.SELECT }),
        sbSistemasService("/comercial_revendas_bmax?select=nome,nome_rd&ativo=eq.true&limit=1000"),
        getLeads("admin", "adm"),
        buscarPrazos12a()
    ]);
    const gruposMap = {};
    grupos.forEach(g => (gruposMap[g.grupo] = gruposMap[g.grupo] || []).push(trim(g.revenda_rd)));
    const ativos = new Set(cadAtivos.map(c => trim(c.nome_rd || c.nome).toLowerCase()));
    const assumidoEm = new Map(prazos12a.map(p => [p.deal_id, new Date(p.assumido_em)]));
    const umDia = 86_400_000;

    const resultado = [];
    for (const u of logins) {
        const nomes = (u.grupo && gruposMap[u.grupo]) ? gruposMap[u.grupo] : (u.name ? [trim(u.name)] : []);
        const conjunto = new Set(nomes);
        const ativa = nomes.some(n => ativos.has(n.toLowerCase()));
        const tel = normalizarCelularBR(u.telefone);
        const aceite = !!u.whatsapp_aceite_em;
        const base = { user_id: u.user_id, login: u.username, revenda: u.name, grupo: u.grupo || null, ativa, whatsapp: tel, aceiteEm: u.whatsapp_aceite_em || null };

        // Só revenda ativa no programa recebe aviso
        if (!ativa) { resultado.push({ ...base, itens: null, mensagens: [], enviaria: false, bloqueio: "revenda não está ativa no programa" }); continue; }

        const { podeVerPci } = require("./visibilidadePci.service");
        const meus = deals.filter(d => conjunto.has(trim(getCustomField(d, "REVENDA/LOJA"))) && !REVENDA_SEM_CREDITO.includes(trim(getCustomField(d, "REVENDA/LOJA"))) && podeVerPci("revenda", getCustomField(d, "PERFIL PCI")));
        const pci12 = meus.filter(d => pciNorm(d) === "PCI12" && !FINAIS.has(d.deal_stage?.id));
        const novos = meus.filter(d => new Date(d.created_at) >= new Date(hoje - umDia) && !pci12.includes(d)).length;
        const leads12a = meus.filter(d => pciNorm(d) === "PCI12A" && !FINAIS.has(d.deal_stage?.id) && d.win !== true && d.win !== false);
        const leads12aSemResultado = leads12a.filter(d => {
            const ini = assumidoEm.get(d.id || d._id) || (d.rd_deal_id && assumidoEm.get(d.rd_deal_id));
            return ini && MARCOS_12A.includes(Math.floor((hoje - ini) / umDia));
        }).length;
        const grupoParam = (u.grupo && gruposMap[u.grupo]) ? u.grupo : null;
        const saldo = await getSaldoGrupo(trim(u.name), grupoParam);
        const expirando = await getCreditosProximosVencimentoGrupo(trim(u.name), grupoParam);
        const cashbackExpirando = MARCOS_CASHBACK.map(m => {
            const soma = expirando.filter(c => Math.ceil((new Date(c.expira_em) - hoje) / umDia) === m).reduce((s, c) => s + Number(c.valor), 0);
            return soma > 0 ? { dias: m, valor: soma } : null;
        }).filter(Boolean);
        const diaDoMes = hoje.getDate();
        const cashbackDisponivel = saldo > 0 && (diaDoMes === 1 || diaDoMes === 15) ? saldo : 0;
        const incentivoNovaNegociacao = !meus.some(d => new Date(d.created_at) >= new Date(hoje - 30 * umDia)) && hoje.getDay() === 1; // só às segundas

        const itens = { novos, pci12Pendentes: pci12.length, cashbackExpirando, cashbackDisponivel, leads12aSemResultado, incentivoNovaNegociacao };
        const temResumo = !!(novos || cashbackExpirando.length || cashbackDisponivel || leads12aSemResultado);
        const mensagens = [];
        if (pci12.length) mensagens.push(montarMensagem("pci12", [plural(pci12.length, "lead", "leads")]));
        if (temResumo) {
            const venc = cashbackExpirando.map(c => `${brl(c.valor)} em ${c.dias} dias`).join(" e ") || "nenhum";
            mensagens.push(montarMensagem("resumo", [novos ? String(novos) : "nenhum", venc, saldo > 0 ? brl(saldo) : "nenhum", leads12aSemResultado ? String(leads12aSemResultado) : "nenhum"]));
        }
        // Incentivo a nova negociação = FASE 2 (decisão do André, 14/10/2026): modelo definido, envio desligado.
        // Ligar só com WHATSAPP_INCENTIVO=1 depois de aprovado o modelo de marketing na Twilio/Meta.
        if (incentivoNovaNegociacao && process.env.WHATSAPP_INCENTIVO === "1") mensagens.push(montarMensagem("incentivo", ["30"]));

        let bloqueio = null;
        if (!tel.valido) bloqueio = `WhatsApp inválido: ${tel.motivo}`;
        else if (!aceite) bloqueio = "sem aceite de WhatsApp registrado";
        else if (!mensagens.length) bloqueio = "nada a comunicar hoje";
        resultado.push({ ...base, itens, mensagens, enviaria: !bloqueio, bloqueio });
    }
    const ativos2 = resultado.filter(r => r.ativa);
    return {
        geradoEm: hoje.toISOString(),
        totais: {
            logins: resultado.length,
            ativos: ativos2.length,
            comWhatsAppValido: ativos2.filter(r => r.whatsapp.valido).length,
            comAceite: ativos2.filter(r => r.aceiteEm).length,
            comMensagemHoje: ativos2.filter(r => r.mensagens.length).length,
            enviariamHoje: resultado.filter(r => r.enviaria).length
        },
        logins: resultado
    };
}

module.exports = { montarResumoDiario, MODELOS, renderModelo };
