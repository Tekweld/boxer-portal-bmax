const { lerPlanilhaCashback } = require("./cashback.service");
const {
    RD_PIPELINE_INDUSTRIA,
    RD_PIPELINE_BMAX_INTERNO,
    RD_PIPELINE_REVENDAS,
    RD_STAGES,
    RD_STAGE_EXCLUIDO,
    RD_STAGE_ASSUMIDO,
    RD_STAGE_LEAD,
    RD_STAGE_VENDIDO,
    RD_STAGE_PERDIDO,
    RD_STAGE_VENDA_EFETIVADA,
    RD_STAGES_EXCLUIDOS_REVENDAS,
    RD_CUSTOM_FIELDS,
    RD_CF_SLUG_MAP,
    RD_OWNERS,
    RD_OWNER_DEFAULT,
    ESTADOS,
} = require("../config/constants");

const RD_CRM_V1 = "https://crm.rdstation.com/api/v1";

const { sbSistemasAnon } = require("../config/supabaseSistemas");
const { logger } = require("../logger");

let _aliasCache = { data: null, ts: 0 };
async function getAliasMaps() {
    if (_aliasCache.data && Date.now() - _aliasCache.ts < 30 * 60 * 1000) return _aliasCache.data;
    const usernameToRd = {};
    const rdToUsername = {};
    try {
        const rows = await sbSistemasAnon('/comercial_representantes_bmax?select=nome,rd_alias&rd_alias=not.is.null');
        for (const r of rows || []) {
            usernameToRd[r.nome] = r.rd_alias;
            rdToUsername[r.rd_alias] = r.nome;
        }
    } catch { /* mantém mapas vazios em caso de falha */ }
    _aliasCache = { data: { usernameToRd, rdToUsername }, ts: Date.now() };
    return _aliasCache.data;
}

function rdToken() {
    return process.env.RD_CRM_TOKEN;
}

function getCustomField(deal, label) {
    const cf = (deal.deal_custom_fields || []).find(
        f => f.custom_field && f.custom_field.label.trim().toUpperCase() === label.trim().toUpperCase()
    );
    return cf ? cf.value : "";
}

function getCustomFieldId(deal, label) {
    const cf = (deal.deal_custom_fields || []).find(
        f => f.custom_field && f.custom_field.label.toUpperCase() === label.toUpperCase()
    );
    return cf ? cf.custom_field._id : null;
}

const RD_FETCH_TIMEOUT_MS = 20000;
const RD_MAX_RETRIES = 2;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function rdFetchOnce(url, opts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RD_FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

// Reintenta em 429/5xx/timeout com backoff exponencial (1s, 2s) antes de desistir —
// evita que uma instabilidade passageira da API do RD vire um 500 imediato para
// quem está usando o Portal.
async function rdFetch(path, method = "GET", body = null) {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${RD_CRM_V1}${path}${sep}token=${rdToken()}`;

    const opts = { method, headers: {} };
    if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= RD_MAX_RETRIES; attempt++) {
        let res;
        try {
            res = await rdFetchOnce(url, opts);
        } catch (err) {
            lastErr = err.name === "AbortError"
                ? new Error("Tempo esgotado ao conectar com a API do RD Station.")
                : err;
            if (attempt < RD_MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt)); continue; }
            throw lastErr;
        }

        if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(
                res.status === 429
                    ? "Rate limit atingido na API do RD Station. Tente novamente em alguns segundos."
                    : `Erro RD ${res.status}: instabilidade no servidor do RD Station.`
            );
            if (attempt < RD_MAX_RETRIES) { await sleep(1000 * Math.pow(2, attempt)); continue; }
            throw lastErr;
        }

        const json = await res.json();

        if (!res.ok) {
            logger.error({ message: "Erro na resposta do RD Station", method, path, status: res.status, body: json });
            const detail = json?.errors ? JSON.stringify(json.errors) : (json?.message || JSON.stringify(json));
            throw new Error(`Erro RD ${res.status}: ${detail}`);
        }

        return json;
    }
    throw lastErr;
}

// ─── DEALS (GET) ─────────────────────────────────────────────

let _leadsCache = { data: null, ts: 0 };
const LEADS_CACHE_TTL = 5 * 60 * 1000;

const RD_MAX_PAGES = 200; // teto de segurança (200 * 200 = 40k deals) contra paginação inconsistente da API

async function fetchAllDealsFromRD() {
    if (_leadsCache.data && Date.now() - _leadsCache.ts < LEADS_CACHE_TTL) return _leadsCache.data;

    let allDeals = [];
    let page = 1;
    while (page <= RD_MAX_PAGES) {
        const json = await rdFetch(
            `/deals?deal_pipeline_id=${RD_PIPELINE_INDUSTRIA}&created_at_start=2026-05-01&page=${page}&limit=200`
        );
        const deals = json.deals || [];
        if (deals.length === 0) break;
        allDeals = allDeals.concat(deals);
        if (!json.has_more) break;
        page++;
    }
    if (page > RD_MAX_PAGES) logger.error({ message: "fetchAllDealsFromRD atingiu o teto de páginas — dados podem estar incompletos", maxPages: RD_MAX_PAGES });
    _leadsCache = { data: allDeals, ts: Date.now() };
    return allDeals;
}

async function getLeads(username, role) {
    let allDeals = await fetchAllDealsFromRD();

    const excludeStages = new Set([
        RD_STAGE_EXCLUIDO,
        RD_STAGE_PERDIDO
    ]);
    const cutoffDate = new Date("2026-05-01T00:00:00");
    allDeals = allDeals.filter(d => {
        if (!d.deal_stage || excludeStages.has(d.deal_stage.id)) return false;
        const created = new Date(d.created_at);
        return created >= cutoffDate;
    });

    if (role === "revenda") {
        const grupo = typeof arguments[2] === "string" ? arguments[2] : null;
        let grupoRevendas = null;
        if (grupo) {
            const { sequelize } = require("../database");
            const { QueryTypes } = require("sequelize");
            const rows = await sequelize.query(
                `SELECT revenda_rd FROM bmax_grupos WHERE grupo = :grupo`,
                { replacements: { grupo }, type: QueryTypes.SELECT }
            );
            grupoRevendas = new Set(rows.map(r => r.revenda_rd));
        }
        allDeals = allDeals.filter(d => {
            const revenda = getCustomField(d, "REVENDA/LOJA");
            if (grupoRevendas) return grupoRevendas.has(revenda);
            return revenda === username;
        });
    } else if (role === "representante") {
        const { usernameToRd, rdToUsername } = await getAliasMaps();
        const rdName = usernameToRd[username] || username;
        const portalAliases = [username, rdName, ...Object.entries(rdToUsername).filter(([, v]) => v === username).map(([k]) => k)];
        const nameSet = new Set(portalAliases);

        allDeals = allDeals.filter(d => {
            const rep = getCustomField(d, "REPRESENTANTE");
            return nameSet.has(rep);
        });
    }

    return allDeals;
}

// ─── DEALS (WRITE) ───────────────────────────────────────────

async function createLead(negociacao) {
    const cnpjClean = (negociacao.cnpj || '').replace(/[.\-\/\s]/g, '');
    const formattedCnpj = cnpjClean.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    const formattedCep = String(negociacao.cep || "").replace(/\D/g, "").replace(/^(\d{5})(\d{3})$/, "$1-$2");

    let organization = await getOrgByCNPJ(formattedCnpj);

    if (!organization) {
        try {
            organization = await createOrg({
                name: negociacao.nome,
                user_id: RD_OWNER_DEFAULT,
                organization_custom_fields: [
                    { custom_field_id: "661582f3c3b2c90015345101", value: formattedCnpj },
                    { custom_field_id: "661582fab845080022ccef54", value: negociacao.cidade || "" },
                    { custom_field_id: "685ade2fb62e040017a2c8dd", value: formattedCep }
                ]
            });
        } catch (e) {
            const byName = await rdFetch(`/organizations?q=${encodeURIComponent(negociacao.nome)}&limit=5`);
            organization = (byName.organizations || [])[0] || null;
            if (!organization) throw e;
        }
    }

    const pci = negociacao.pci || "PCI 12";

    const responsavelId = await resolverResponsavelId(negociacao.responsavel);

    // Funil: pedido do André (2026-09-11, revisado) — revenda SEMPRE vai pro
    // BMAX, sem escolha; representante e admin podem escolher (campo "Funil"
    // no formulário, ambos os roles também conduzem venda pela Indústria às
    // vezes). Decide pelo role real do token (setado no controller), nunca
    // por algo vindo do body pra quem não pode escolher.
    const podeEscolherFunil = negociacao.role === "adm" || negociacao.role === "representante";
    const quisIndustria = podeEscolherFunil && negociacao.funil === "industria";
    const pipeline = quisIndustria ? RD_PIPELINE_INDUSTRIA : RD_PIPELINE_BMAX_INTERNO;
    const stage = quisIndustria ? RD_STAGE_LEAD : RD_STAGE_ASSUMIDO;

    const body = {
        deal: {
            name: negociacao.nome,
            deal_pipeline_id: pipeline,
            deal_stage_id: stage,
            user_id: responsavelId,
            organization_id: organization._id || organization.id,
            deal_custom_fields: [
                { custom_field_id: RD_CUSTOM_FIELDS.CNPJ, value: formattedCnpj },
                { custom_field_id: RD_CUSTOM_FIELDS.CIDADE, value: negociacao.cidade },
                { custom_field_id: RD_CUSTOM_FIELDS.ESTADO, value: negociacao.estado || "" },
                { custom_field_id: RD_CUSTOM_FIELDS.REVENDA_LOJA, value: matchRevendaRD(negociacao.revenda) },
                { custom_field_id: RD_CUSTOM_FIELDS.REPRESENTANTE, value: negociacao.representante },
                { custom_field_id: RD_CUSTOM_FIELDS.MAQUINA, value: negociacao.maquinainteresse },
                { custom_field_id: RD_CUSTOM_FIELDS.NOTAS, value: "Lead BMAX" },
                { custom_field_id: RD_CUSTOM_FIELDS.PERFIL_PCI, value: pci }
            ]
        }
    };

    return await rdFetch("/deals", "POST", body);
}

// Lista de usuários ativos do RD Station — usada pra popular "Responsável"
// na Nova Negociação sempre com quem realmente existe no RD hoje (achado
// 2026-09-11: a lista era um array fixo em constants.js, faltando gente
// como Billy e André que já eram usuários reais do RD havia tempo).
let _rdUsersCache = { data: null, ts: 0 };
const RD_USERS_CACHE_TTL = 60 * 60 * 1000;

async function getRdUsuariosAtivos() {
    if (_rdUsersCache.data && Date.now() - _rdUsersCache.ts < RD_USERS_CACHE_TTL) return _rdUsersCache.data;
    const json = await rdFetch("/users");
    const usuarios = (json.users || [])
        .filter(u => u.active && !u.hidden)
        .map(u => ({ nome: u.name, id: u.id || u._id }));
    _rdUsersCache = { data: usuarios, ts: Date.now() };
    return usuarios;
}

// "Revenda"/"Representante" continuam sendo pseudo-responsáveis fixos (rota
// de auto-atribuição já existente, ver RD_OWNERS em constants.js) — qualquer
// outro nome é resolvido contra a lista real de usuários do RD.
async function resolverResponsavelId(nomeEscolhido) {
    if (RD_OWNERS[nomeEscolhido]) return RD_OWNERS[nomeEscolhido];
    const usuarios = await getRdUsuariosAtivos();
    const usuario = usuarios.find(u => u.nome === nomeEscolhido);
    return usuario ? usuario.id : RD_OWNER_DEFAULT;
}

function matchRevendaRD(nome) {
    if (!nome) return "Sem Revenda";
    return nome.trim() || "Sem Revenda";
}

function normalizeCnpj(raw) {
    return (raw || '').replace(/[.\-\/\s]/g, '');
}

// Checagem de duplicata na criação de negociação (Nova Negociação). Corrigido
// 2026-09-11: só olhava o funil INDÚSTRIA-INTERNO — desde que representante/
// revenda passaram a criar sempre no BMAX (mesmo dia), essa checagem ficava
// cega pro próprio funil onde a maioria das negociações novas (e muitas já
// existentes) realmente está, deixando duplicar CNPJs já cadastrados. Agora
// varre os 5 funis de verdade (mesma varredura ao vivo da Consulta de Lead,
// não o índice em cache — aqui precisa ser o estado mais atual possível,
// mesmo custando ~15s a mais na hora de salvar).
async function getLeadByCnpj(cnpj) {
    const cnpjClean = normalizeCnpj(cnpj);
    if (!cnpjClean) return null;

    const deals = await fetchAllDealsAllPipelines();
    const encontrado = deals.find(d => {
        if (!d.deal_stage || d.deal_stage.id === RD_STAGE_VENDA_EFETIVADA || d.deal_stage.id === RD_STAGE_EXCLUIDO || d.deal_stage.id === RD_STAGE_PERDIDO) return false;
        const dealCnpj = normalizeCnpj(getCustomField(d, 'CNPJ'));
        return dealCnpj === cnpjClean;
    });

    return encontrado || null;
}

// Corrige o nome do representante em TODAS as negociações já existentes no RD
// (histórico completo, sem filtro de data) — usado quando o admin renomeia um
// representante, para que ele não perca visibilidade/comissão sobre leads antigos.
//
// IMPORTANTE: o campo REPRESENTANTE no RD é um picklist estrito (allow_new:false) —
// o RD aceita a chamada mas descarta silenciosamente qualquer valor que não esteja
// na lista de opções do campo. O chamador PRECISA garantir que `nomeNovo` já foi
// adicionado ao picklist (via syncRepresentantesToRD) ANTES de chamar esta função,
// senão a escrita não persiste em nenhum deal.
//
// dryRun:true só conta/lista os deals que seriam afetados, sem gravar nada — use
// para conferir o escopo (quantos deals, quais IDs) antes de rodar de verdade.
async function renomearRepresentanteNoRD(nomeAntigo, nomeNovo, { dryRun = false } = {}) {
    const pipelines = [RD_PIPELINE_INDUSTRIA, RD_PIPELINE_BMAX_INTERNO];
    let total = 0, updated = 0, failed = 0;
    const dealIds = [];

    for (const pipelineId of pipelines) {
        let page = 1;
        while (page <= RD_MAX_PAGES) {
            const json = await rdFetch(`/deals?deal_pipeline_id=${pipelineId}&page=${page}&limit=200`);
            const deals = json.deals || [];
            if (deals.length === 0) break;

            for (const d of deals) {
                if (getCustomField(d, "REPRESENTANTE") !== nomeAntigo) continue;
                total++;
                const dealId = d._id || d.id;
                if (dryRun) { dealIds.push(dealId); continue; }
                try {
                    await updateLead(dealId, { data: { custom_fields: { representante: nomeNovo } } });
                    updated++;
                } catch (e) {
                    failed++;
                    logger.error({ message: "Erro ao renomear representante no deal", dealId, error: e.message });
                }
            }

            if (!json.has_more) break;
            page++;
        }
    }

    if (dryRun) return { total, dealIds, dryRun: true };
    _leadsCache = { data: null, ts: 0 }; // invalida cache — próximo getLeads busca dados atualizados
    return { total, updated, failed };
}

// Corrige o nome da revenda em TODAS as negociações já existentes no RD (histórico
// completo, sem filtro de data) — mesma lógica de renomearRepresentanteNoRD, mas
// varre também RD_PIPELINE_REVENDAS (onde deals de revenda também podem viver, ao
// contrário do rename de representante que só varre INDUSTRIA/BMAX_INTERNO).
//
// Mesma regra do picklist estrito se aplica ao campo REVENDA/LOJA: o chamador
// PRECISA rodar syncRevendasToRD com o nome novo incluído ANTES de chamar esta
// função, senão a escrita não persiste.
async function renomearRevendaNoRD(nomeAntigo, nomeNovo, { dryRun = false } = {}) {
    const pipelines = [RD_PIPELINE_INDUSTRIA, RD_PIPELINE_BMAX_INTERNO, RD_PIPELINE_REVENDAS];
    let total = 0, updated = 0, failed = 0;
    const dealIds = [];

    for (const pipelineId of pipelines) {
        let page = 1;
        while (page <= RD_MAX_PAGES) {
            const json = await rdFetch(`/deals?deal_pipeline_id=${pipelineId}&page=${page}&limit=200`);
            const deals = json.deals || [];
            if (deals.length === 0) break;

            for (const d of deals) {
                if (getCustomField(d, "REVENDA/LOJA") !== nomeAntigo) continue;
                total++;
                const dealId = d._id || d.id;
                if (dryRun) { dealIds.push(dealId); continue; }
                try {
                    await updateLead(dealId, { data: { custom_fields: { "revenda-loja": nomeNovo } } });
                    updated++;
                } catch (e) {
                    failed++;
                    logger.error({ message: "Erro ao renomear revenda no deal", dealId, error: e.message });
                }
            }

            if (!json.has_more) break;
            page++;
        }
    }

    if (dryRun) return { total, dealIds, dryRun: true };
    _leadsCache = { data: null, ts: 0 };
    return { total, updated, failed };
}

async function updateLead(id, body) {
    const v1Body = {};

    if (body?.data?.stage_id) v1Body.deal_stage_id = body.data.stage_id;
    if (body?.data?.owner_id) v1Body.user_id = body.data.owner_id;

    if (body?.data?.custom_fields) {
        v1Body.deal_custom_fields = [];
        for (const [key, val] of Object.entries(body.data.custom_fields)) {
            const cfId = RD_CF_SLUG_MAP[key];
            if (cfId) v1Body.deal_custom_fields.push({ custom_field_id: cfId, value: val });
        }
    }

    return await rdFetch(`/deals/${id}`, "PUT", { deal: v1Body });
}

// ─── SYNC REVENDAS → RD ─────────────────────────────────────

async function getRDCustomFieldId(label) {
    const fields = await rdFetch("/custom_fields");
    const field = fields.find(f => f.label && f.label.trim().toUpperCase() === label.trim().toUpperCase());
    return field ? (field._id || field.id) : null;
}

async function syncRevendasToRD(revendaNomes) {
    const fieldId = await getRDCustomFieldId("REVENDA/LOJA");
    if (!fieldId) throw new Error("Campo REVENDA/LOJA não encontrado no RD Station");

    const opts = [...revendaNomes.filter(n => n && n.trim()), "Sem Revenda"];
    const unique = [...new Set(opts)];

    await rdFetch(`/custom_fields/${fieldId}`, "PUT", {
        custom_field: { options: unique }
    });

    return { synced: unique.length, fieldId };
}

async function syncRepresentantesToRD(repNomes) {
    const fieldId = await getRDCustomFieldId("REPRESENTANTE");
    if (!fieldId) throw new Error("Campo REPRESENTANTE não encontrado no RD Station");

    const opts = [...repNomes.filter(n => n && n.trim()), "N/D"];
    const unique = [...new Set(opts)];

    await rdFetch(`/custom_fields/${fieldId}`, "PUT", {
        custom_field: { options: unique }
    });

    return { synced: unique.length, fieldId };
}

// ─── ORGANIZATIONS ───────────────────────────────────────────

async function getOrg(id) {
    if (id === "Vazio") return "Vazio";
    return await rdFetch(`/organizations/${id}`);
}

async function getOrgByCNPJ(cnpj) {
    const json = await rdFetch(`/organizations?q=${encodeURIComponent(cnpj)}&limit=10`);
    const orgs = json.organizations || [];
    return orgs.length > 0 ? orgs[0] : null;
}

async function createOrg(orgData) {
    return await rdFetch("/organizations", "POST", { organization: orgData });
}

// ─── TASKS ───────────────────────────────────────────────────

async function getTask(id) {
    if (id === "Vazio") return [];
    const json = await rdFetch(`/tasks?deal_id=${id}`);
    return json.tasks || [];
}

async function createTask(taskData) {
    const body = {
        task: {
            deal_id: taskData.deal_id,
            subject: taskData.name || taskData.subject,
            type: taskData.type || "task",
            date: taskData.date,
            hour: taskData.hour,
            user_id: taskData.owner_id || taskData.user_id || RD_OWNER_DEFAULT,
            notes: taskData.notes || undefined
        }
    };
    return await rdFetch("/tasks", "POST", body);
}

async function updateTask(taskData, id) {
    return await rdFetch(`/tasks/${id}`, "PUT", { task: taskData });
}

// ─── NOTES ───────────────────────────────────────────────────

async function getLeadNotes(deal_id) {
    return await rdFetch(`/annotations?deal_id=${deal_id}`);
}

// ─── MAP DEAL TO CARD ────────────────────────────────────────

const estados = ESTADOS;
const estagios = RD_STAGES;

async function mapDealToCard(deal, role, creditosMap) {
    const stageId = deal.deal_stage ? deal.deal_stage.id : null;
    const org = deal.organization || {};
    const orgCfs = {};
    if (org.organization_custom_fields) {
        for (const cf of org.organization_custom_fields) {
            if (cf.custom_field) orgCfs[cf.custom_field.label.toUpperCase()] = cf.value;
        }
    }

    const cnpjRaw = getCustomField(deal, "CNPJ") || orgCfs["CNPJ"] || "?????";
    const cnpj = cnpjRaw.replace(/\D/g, "").replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
    const cidade = getCustomField(deal, "CIDADE") || orgCfs["CIDADE"] || "?????";
    const estado = getCustomField(deal, "ESTADO") || orgCfs["ESTADO"] || "??";
    const representante = getCustomField(deal, "REPRESENTANTE") || "?????";
    const revenda = getCustomField(deal, "REVENDA/LOJA") || "?????";
    const maquinainteresse = getCustomField(deal, "MÁQUINA DE INTERESSE") || "?????";
    const pciRaw = (getCustomField(deal, "PERFIL PCI") || orgCfs["PERFIL PCI"] || "").trim();
    const pci = pciRaw.replace(/\s/g, "");

    let cashback = 0;
    const dealId = deal.id || deal._id || "";
    const stageLabel = estagios[stageId] || "";
    if (stageLabel === "Venda Efetivada" || stageLabel === "Vendido") {
        if (creditosMap && dealId in creditosMap) {
            cashback = creditosMap[dealId];
        } else {
            const pciCashback = pci;
            const classeCashback = (getCustomField(deal, "CLASSE DE PREÇO") || "").replace(/\D/g, "");
            const cashbackRole = role === "adm" ? "revenda" : role;
            const comissao = parseFloat(await lerPlanilhaCashback(pciCashback, cashbackRole, classeCashback)) || 0;
            cashback = Number(deal.amount_total || 0) * Number(comissao || 0);
        }
    }

    const criadoem = new Date(deal.created_at).toLocaleDateString("pt-BR");
    const nextTask = deal.next_task || {};
    const tarefa = nextTask.subject || "Sem Tarefa Ativa";
    let datatarefa = nextTask.date ? " - " + new Date(nextTask.date).toLocaleDateString("pt-BR") : "";
    if (datatarefa === " - Invalid Date") datatarefa = "";

    const tag = estagios[stageId] || "??????";

    const classePreco = (getCustomField(deal, "CLASSE DE PREÇO") || "").replace(/\D/g, "");
    const oportunidadedevendas = getCustomField(deal, "OPORTUNIDADE DE VENDA") || "";
    const responsavelRd = (deal.user && deal.user.name) || "";

    return {
        id: deal.id || deal._id || "?????",
        nome: deal.name || "?????",
        cnpj,
        cidade,
        estado,
        maquinainteresse,
        valor: deal.amount_total || 0,
        pci,
        classePreco,
        criadoem,
        representante,
        revenda,
        tag,
        cashback,
        tarefa,
        datatarefa,
        oportunidadedevendas,
        responsavelRd
    };
}

// ─── Consulta de Lead (tela "Consulta de Lead" do BMax Motor) ──
// Deixa qualquer vendedor/SDR checar, por CNPJ/email/telefone/nome, se um
// cliente já existe em negociação em QUALQUER funil do RD — e sinaliza bem
// claro quando o resultado está no funil BMAX (cliente veio de uma revenda,
// a venda é dela, não da Boxer). O `q=` da API do RD não filtra de verdade
// (testado ao vivo) — por isso, igual a getLeadByCnpj, buscamos tudo e
// filtramos no client.
//
// Varrer 5 funis inteiros (sem filtro de data) é pesado demais pra caber no
// timeout de uma função serverless do Vercel (confirmado ao vivo: 504
// FUNCTION_INVOCATION_TIMEOUT na primeira tentativa, buscando tudo na hora
// do clique). Por isso o índice é pré-computado por um cron diário
// (buildConsultaLeadIndex, chamado por /api/cron/sync-consulta-lead) e
// guardado em cache.service.js (tabela leads_cache, TTL de 25h — sobrevive
// folgado entre execuções diárias do cron). O endpoint de busca só lê esse
// índice já pronto — nunca faz a varredura na hora da consulta do usuário.

let _pipelinesCache = { data: null, ts: 0 };
const PIPELINES_CACHE_TTL = 60 * 60 * 1000;

async function getAllPipelines() {
    if (_pipelinesCache.data && Date.now() - _pipelinesCache.ts < PIPELINES_CACHE_TTL) return _pipelinesCache.data;
    const json = await rdFetch("/deal_pipelines");
    const pipelines = (Array.isArray(json) ? json : []).map(p => ({ id: p._id || p.id, nome: p.name }));
    _pipelinesCache = { data: pipelines, ts: Date.now() };
    return pipelines;
}

const PAGE_LIMIT = 200;
const PAGE_CONCURRENCY = 6; // não estourar rate-limit do RD buscando página demais de uma vez

function marcarPipeline(deals, pipelineId, pipelineNome) {
    for (const d of deals) { d._pipelineId = pipelineId; d._pipelineNome = pipelineNome; }
    return deals;
}

// Busca a 1ª página pra descobrir o total de páginas (a API do RD devolve
// `total`), depois busca o resto em paralelo (em lotes, pra não estourar
// rate-limit) em vez de página por página em série — é o que faz a varredura
// completa dos 5 funis caber no timeout do Vercel (sequencial passava de 50s
// só no maior funil).
async function fetchDealsForPipeline(pipelineId, pipelineNome) {
    const primeira = await rdFetch(`/deals?deal_pipeline_id=${pipelineId}&page=1&limit=${PAGE_LIMIT}`);
    let deals = marcarPipeline(primeira.deals || [], pipelineId, pipelineNome);
    if (!primeira.has_more) return deals;

    const totalPaginas = Math.min(Math.ceil((primeira.total || deals.length) / PAGE_LIMIT), RD_MAX_PAGES);
    const paginasRestantes = [];
    for (let p = 2; p <= totalPaginas; p++) paginasRestantes.push(p);

    for (let i = 0; i < paginasRestantes.length; i += PAGE_CONCURRENCY) {
        const lote = paginasRestantes.slice(i, i + PAGE_CONCURRENCY);
        const respostas = await Promise.all(
            lote.map(p => rdFetch(`/deals?deal_pipeline_id=${pipelineId}&page=${p}&limit=${PAGE_LIMIT}`))
        );
        for (const json of respostas) deals.push(...marcarPipeline(json.deals || [], pipelineId, pipelineNome));
    }
    return deals;
}

// Busca os 5 funis em paralelo, e dentro de cada funil também pagina em
// paralelo (ver fetchDealsForPipeline) — reduz bastante o tempo total em
// relação a buscar página por página, funil por funil, em série.
async function fetchAllDealsAllPipelines() {
    const pipelines = await getAllPipelines();
    const porFunil = await Promise.all(pipelines.map(p => fetchDealsForPipeline(p.id, p.nome)));
    return porFunil.flat();
}

const CONSULTA_LEAD_CACHE_KEY = "consulta_lead_index";
const CONSULTA_LEAD_CACHE_TTL = 7 * 60 * 60 * 1000; // 7h — cron roda 3x/dia (9h/14h/18h), folga sobre o intervalo de 5h entre execuções

// Chamado só pelo cron (/api/cron/sync-consulta-lead) — faz a varredura pesada
// uma vez por dia e guarda o resultado já no formato final de exibição.
async function buildConsultaLeadIndex() {
    const { setCachedLeads } = require("./cache.service");
    const deals = await fetchAllDealsAllPipelines();
    const resultados = deals.map(dealParaResultado);
    await setCachedLeads(CONSULTA_LEAD_CACHE_KEY, resultados);
    return resultados.length;
}

function soDigitos(s) {
    return (s || "").toString().replace(/\D/g, "");
}

function detectarTipoBusca(termoBruto) {
    const termo = (termoBruto || "").trim();
    const digitos = soDigitos(termo);
    if (termo.includes("@")) return "email";
    if (digitos.length === 14) return "cnpj";
    if (digitos.length >= 8 && digitos.length <= 11) return "telefone";
    return "nome";
}

function dealParaResultado(deal) {
    const stage = deal.deal_stage || {};
    const contatos = (deal.contacts || []).map(c => ({
        nome: c.name || "",
        emails: (c.emails || []).map(e => e.email).filter(Boolean),
        telefones: (c.phones || []).map(p => p.phone).filter(Boolean)
    }));
    return {
        id: deal.id || deal._id,
        nome: deal.name || "",
        organizacao: deal.organization?.name || "",
        cnpj: getCustomField(deal, "CNPJ") || "",
        cidade: getCustomField(deal, "CIDADE") || "",
        estado: getCustomField(deal, "ESTADO") || "",
        funil: deal._pipelineNome || "",
        funilId: deal._pipelineId || "",
        estagio: stage.name || "",
        responsavel: deal.user?.name || "",
        representante: getCustomField(deal, "REPRESENTANTE") || "",
        revenda: getCustomField(deal, "REVENDA/LOJA") || "",
        valor: deal.amount_total || 0,
        criadoEm: deal.created_at || null,
        contatos,
        emFunilBmax: deal._pipelineId === RD_PIPELINE_BMAX_INTERNO
    };
}

// Busca no índice já pronto (ver buildConsultaLeadIndex) — nunca chama o RD
// na hora do clique do usuário, só lê o que o cron diário já deixou pronto.
async function buscarLead(termoBruto) {
    const termo = (termoBruto || "").trim();
    if (!termo) return { termo, tipoDetectado: null, total: 0, resultados: [], indiceDisponivel: true };

    const { getCachedLeads } = require("./cache.service");
    const indice = await getCachedLeads(CONSULTA_LEAD_CACHE_KEY, CONSULTA_LEAD_CACHE_TTL);
    if (!indice) {
        return { termo, tipoDetectado: null, total: 0, resultados: [], indiceDisponivel: false };
    }

    const tipo = detectarTipoBusca(termo);
    const digitos = soDigitos(termo);
    const termoLower = termo.toLowerCase();

    const encontrados = indice.filter(r => {
        if (tipo === "cnpj") {
            return soDigitos(r.cnpj) === digitos;
        }
        if (tipo === "email") {
            return (r.contatos || []).some(c => (c.emails || []).some(e => (e || "").toLowerCase() === termoLower));
        }
        if (tipo === "telefone") {
            const alvo = digitos.slice(-8);
            return (r.contatos || []).some(c => (c.telefones || []).some(t => soDigitos(t).slice(-8) === alvo));
        }
        // nome — negociação, organização ou contato
        const nomes = [r.nome, r.organizacao, ...(r.contatos || []).map(c => c.nome)]
            .filter(Boolean).map(n => n.toLowerCase());
        return nomes.some(n => n.includes(termoLower));
    });

    return { termo, tipoDetectado: tipo, total: encontrados.length, resultados: encontrados, indiceDisponivel: true };
}

// Monta os cards de leads exatamente como o dashboard (GET /api/leads) monta —
// usada tanto pelo dashboard quanto pela exportação, para que os dois nunca
// possam divergir (cashback, PCI, etc. sempre calculados da mesma forma).
async function buildLeadsCards(role, identifier, grupo) {
    const { getCreditosPorLeads } = require("./saldo.service");

    const leads = await getLeads(identifier, role, grupo);
    const leadIds = leads.map(d => d.id || d._id).filter(Boolean);
    const creditosMap = await getCreditosPorLeads(leadIds);

    return Promise.all(leads.map(lead => mapDealToCard(lead, role, creditosMap)));
}

module.exports = {
    getLeads,
    buildLeadsCards,
    buscarLead,
    buildConsultaLeadIndex,
    getRdUsuariosAtivos,
    createLead,
    updateLead,
    getOrg,
    getTask,
    createTask,
    updateTask,
    createOrg,
    getOrgByCNPJ,
    getLeadByCnpj,
    getLeadNotes,
    mapDealToCard,
    getCustomField,
    syncRevendasToRD,
    syncRepresentantesToRD,
    getAliasMaps,
    renomearRepresentanteNoRD,
    renomearRevendaNoRD
};
