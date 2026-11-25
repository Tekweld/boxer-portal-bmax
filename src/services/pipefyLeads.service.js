// Implementação Pipefy das 4 operações preparadas nesta primeira leva (ver
// guia_bmax_pipefy.md e o plano da migração): criar negociação, gravar
// etapa/campos, listar leads e checar duplicata por CNPJ. Só é usada quando
// CRM_PROVIDER=pipefy (ver rd.leads.service.js, que despacha pra cá) —
// desativada por padrão, RD continua sendo o provedor ativo.
//
// Tudo o mais (sync de picklist revenda/representante, Consulta de Lead do
// Motor, contato principal/notas do PCI12A, criação de tarefa) continua
// sempre no RD, mesmo com a flag ligada — são operações de varredura
// completa do funil ou sem equivalente direto no Pipefy, e exigem um
// redesenho à parte (webhook + índice local) antes de migrar de fato.
const { logger } = require("../logger");
const { RD_STAGES, RD_OWNERS, RD_STAGE_NEGOCIACAO } = require("../config/constants");
const {
    PIPEFY_PIPE_BMAX,
    PIPEFY_FASES,
    PIPEFY_CAMPOS,
    PIPEFY_FASE_PARA_ETAPA_RD,
    PIPEFY_PCI_OPCOES,
    PIPEFY_MEMBROS,
    PIPEFY_PIPES_PORTAL,
    pipeConfig,
    exigirConfig,
    nomeDoPipePorId,
    faseParaEtapaRdReversa,
    pciParaPipefy,
    pciDoPipefy,
    revendaParaPipefy,
    revendaDoPipefy,
    tabelaEmpresaDoPipe,
    tabelaContatoDoPipe
} = require("../config/pipefyConstants");
const {
    allCardsAtualizadosDesde,
    allCardsInPipe,
    createCard,
    createComment,
    createContato,
    findCardByRdId,
    findCardsByFieldValue,
    findContatoPorEmail,
    getCard,
    getCardComments,
    getPipeLabels,
    getTableRecord,
    getStartFormFields,
    moveCardToPhase,
    updateCardAssignees,
    updateCardFieldsEmLote,
    updateFieldEmVariosCards,
    updatePhaseField
} = require("./pipefy.service");

// Lazy — evita ciclo de require no sentido oposto em módulo que carrega
// primeiro este arquivo (rd.leads.service.js só carrega este módulo dentro
// de função, nunca no topo; aqui também fica dentro de função por simetria
// e clareza, embora o ciclo não seja um problema real nesse sentido).
function getAliasMapsLazy() {
    return require("./rd.leads.service").getAliasMaps();
}

// Campos de opções (PCI, Revenda/Loja, Representante...) só aceitam valor
// exatamente igual a uma opção existente — "" ou lista vazia derrubam a
// gravação EM LOTE INTEIRA (achado real, guia seção 1.2). Descarta valores
// vazios em vez de mandá-los, e tira espaço nas pontas (nomes de
// revenda/representante às vezes vêm com espaço a mais do RD).
function montarCamposValidos(pares) {
    return pares
        .map(({ field_id, field_value }) => ({
            field_id,
            field_value: typeof field_value === "string" ? field_value.trim() : field_value
        }))
        .filter(({ field_value }) => {
            if (field_value === null || field_value === undefined || field_value === "") return false;
            if (Array.isArray(field_value) && field_value.length === 0) return false;
            return true;
        });
}

function validarPci(valor) {
    if (!PIPEFY_PCI_OPCOES.includes(valor)) {
        throw new Error(`PCI inválido para o Pipefy: "${valor}" não está entre as opções válidas`);
    }
}

function normalizeCnpj(raw) {
    return (raw || "").replace(/[.\-\/\s]/g, "");
}

// Confirmado na conta real (26/10/2026, testes manuais do 3º adendo): o
// Pipefy sempre devolve moeda em formato BR, ex. "1.234,56" — "." é SEMPRE
// separador de milhar, "," é SEMPRE separador decimal, mesmo quando o valor
// foi gravado como "1234.56" (formato americano). "1234.56" (formato
// americano puro) é aceito só como fallback defensivo — não é o que o
// Pipefy devolve na prática, mas não custa nada continuar aceitando. Em
// caso de formato inesperado, devolve 0 em vez de derrubar a leitura do
// card inteiro.
function parseValorMonetario(raw) {
    if (!raw) return 0;
    let s = String(raw).trim().replace(/[^\d.,]/g, "");
    if (!s) return 0;
    if (s.includes(",")) {
        s = s.replace(/\./g, "").replace(",", ".");
    } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
        // Sem vírgula, mas no padrão de milhar BR (ex.: "1.000",
        // "1.234.567") — sem isso, "1.000" virava 1 (Number lia o "." como
        // ponto decimal) em vez de 1000 (achado real, 3º adendo).
        s = s.replace(/\./g, "");
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
}

// Tarefa B4 (2º adendo, 23/10/2026): o formato que o Pipefy devolve no VALOR
// de um campo de data (ex.: "Data de criação no RD") não está confirmado —
// se vier "12/05/2026", `new Date(...)` do JS lê como 5 de dezembro, e o
// filtro do painel (negociações desde 01/05/2026, rd.leads.service.js)
// erraria sem avisar. Aceita AAAA-MM-DD (já ISO, devolve como está) e
// DD/MM/AAAA (reordena pra ISO), ambos com ou sem hora; formato não
// reconhecido vira null com aviso em log, em vez de uma data errada
// silenciosa.
function paraDataIso(valor) {
    if (!valor) return null;
    const s = String(valor).trim();

    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s;

    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/);
    if (m) {
        const [, dd, mm, yyyy, hora] = m;
        return `${yyyy}-${mm}-${dd}${hora ? "T" + hora : ""}`;
    }

    logger.warn({ message: "paraDataIso: formato de data não reconhecido", valor: s });
    return null;
}

// getCustomField (rd.leads.service.js) procura um custom field pelo RÓTULO
// do RD (ex: "PERFIL PCI", "REVENDA/LOJA") — essa tabela traduz o rótulo do
// campo no Pipefy (como aparece em mapa_pipefy.json → pipes.BMAX.campos)
// pro rótulo RD equivalente, só pros campos que getCustomField/mapDealToCard
// de fato consultam hoje.
const ROTULO_RD_POR_CAMPO_PIPEFY = {
    "PCI": "PERFIL PCI",
    "CNPJ": "CNPJ",
    "Cidade": "CIDADE",
    "Estado": "ESTADO",
    "Representante": "REPRESENTANTE",
    "Revenda/Loja": "REVENDA/LOJA",
    "Máquina de interesse": "MÁQUINA DE INTERESSE",
    "Segmento de produto": "SEGMENTO DE PRODUTO",
    "Classe de preço": "CLASSE DE PREÇO",
    "Notas": "NOTAS",
    "Oportunidade de venda": "OPORTUNIDADE DE VENDA"
};

// Traduz um card do Pipefy pro mesmo formato de objeto "deal" que o resto do
// Portal já sabe ler (getCustomField, mapDealToCard, cálculo de cashback,
// auditoria, motivoForaDoEscopo, e o guard-clause de
// caminhoVenda.service.js que impede redefinir caminho em lead já
// fechado) — assim nenhuma dessas funções precisa saber que existe Pipefy.
// `pipeNome` indica de qual pipe (chave de PIPEFY_FASE_PARA_ETAPA_RD) esse
// card veio, já pensando na Tarefa 11 (múltiplos pipes configuráveis).
function cardParaDealFake(card, pipeNome = "BMAX") {
    // Na prática, os 4 pipes do mapa_pipefy.json compartilham os MESMOS ids
    // de campo (derivados do rótulo pelo próprio Pipefy, iguais em todos —
    // confirmado no arquivo real) — mas usa os campos do pipe específico
    // (pipeConfig), não sempre PIPEFY_CAMPOS (só BMAX), pra não quebrar se
    // isso um dia deixar de ser verdade pra outro pipe de PIPEFY_PIPES_PORTAL.
    const campos = pipeNome === "BMAX" ? PIPEFY_CAMPOS : pipeConfig(pipeNome).campos;

    const valorPorCampoId = {};
    for (const f of card.fields || []) valorPorCampoId[f.field.id] = f.value;

    const dealCustomFields = Object.entries(campos)
        .filter(([rotuloPipefy, campoId]) => ROTULO_RD_POR_CAMPO_PIPEFY[rotuloPipefy] && campoId in valorPorCampoId)
        .map(([rotuloPipefy, campoId]) => ({
            custom_field: { label: ROTULO_RD_POR_CAMPO_PIPEFY[rotuloPipefy] },
            value: rotuloPipefy === "PCI" ? pciDoPipefy(pipeNome, valorPorCampoId[campoId])
                : rotuloPipefy === "Revenda/Loja" ? revendaDoPipefy(pipeNome, valorPorCampoId[campoId])
                : valorPorCampoId[campoId]
        }));

    const faseNome = card.current_phase?.name || null;
    const tabelaFases = PIPEFY_FASE_PARA_ETAPA_RD[pipeNome];
    if (!tabelaFases) {
        logger.warn({ message: "cardParaDealFake: pipe sem tabela fase->etapa RD configurada (PIPEFY_FASE_PARA_ETAPA_RD) — card fica sem etapa classificada", pipeNome, cardId: card.id });
    }
    const infoFase = (tabelaFases || {})[faseNome] || null;
    const etapaRd = infoFase ? infoFase.etapa : null;

    const campoDataCriacaoRd = campos["Data de criação no RD"];
    const dataCriacaoRd = campoDataCriacaoRd ? valorPorCampoId[campoDataCriacaoRd] : null;
    // card.created_at (confirmado na conta real, 20/10/2026 — é `created_at`,
    // não `createdAt`) é a data de criação do card NO PIPEFY; pra negociação
    // migrada, a data de criação certa é a gravada no campo "Data de criação
    // no RD" — card.created_at só serve de fallback pra negociação criada
    // depois da virada (sem esse campo preenchido).
    const createdAt = paraDataIso(dataCriacaoRd) || card.created_at || null;

    const campoValor = campos["Valor total"];
    const amountTotal = campoValor ? parseValorMonetario(valorPorCampoId[campoValor]) : 0;

    const primeiroResponsavel = (card.assignees || [])[0] || null;
    const user = primeiroResponsavel ? { name: primeiroResponsavel.name, email: primeiroResponsavel.email } : null;

    const win = infoFase ? infoFase.win : null;

    // closed_at: usado por getLeads (rd.leads.service.js) pra decidir se uma
    // negociação criada ANTES de DATA_CORTE_PORTAL ainda aparece no painel
    // (só aparece se win===true e closed_at >= DATA_CORTE_VENDAS_ANTIGAS).
    // Achado 23/11/2026 (pendência do merge com upstream, 19/11/2026): sem
    // isso, TODO card do CRM BOXER SOLDAS criado antes do corte (a maioria,
    // migrada do RD) ficava fora do painel/saldo/comissão pra sempre, mesmo
    // vendido depois do corte — porque closed_at nunca era preenchido.
    const campoDataFechamentoRd = campos["Data de fechamento no RD"];
    const dataFechamentoRd = campoDataFechamentoRd ? valorPorCampoId[campoDataFechamentoRd] : null;
    const closedAt = paraDataIso(dataFechamentoRd) || null;

    // Id da MESMA negociação no RD ("ID no RD CRM", preenchido nos cards migrados): o robô de comissões usa os dois ids para nunca
    // creditar duas vezes a mesma venda (23-24/11/2026: a virada para o Pipefy duplicou os créditos porque o lead_id mudou).
    const campoIdRd = campos["ID no RD CRM"];
    const rdDealId = campoIdRd ? (valorPorCampoId[campoIdRd] || null) : null;
    return {
        id: card.id,
        etiquetas: (card.labels || []).map(l => l.name),   // "RD: Indústria" / "RD: BMAX" / "RD: SDR" / "RD: Revenda" = funil de origem no RD
        rd_deal_id: rdDealId ? String(rdDealId).trim() : null,
        name: card.title,
        deal_custom_fields: dealCustomFields,
        deal_stage: { id: etapaRd, name: faseNome },
        amount_total: amountTotal,
        user,
        next_task: {},
        win,
        created_at: createdAt,
        closed_at: closedAt
    };
}

// Cache em memória POR PIPE (Tarefa 4, bmax_pipefy_correcoes_adendo.md,
// 19/10/2026) — sem isso, getLeads é chamado em 10+ lugares (painel, saldo,
// comissão, cashback, admin, resumo do WhatsApp) e cada chamada varreria o
// pipe inteiro, estourando o limite mensal compartilhado do Pipefy (10
// mil/mês pra empresa inteira — ver guia_bmax_pipefy.md seção 3). Desde que
// o painel passou a ler INDÚSTRIA - INTERNO (Tarefa 11, ~850 cards), uma
// releitura completa a cada PIPEFY_CACHE_MIN (30 min padrão) custaria ~24
// mil chamadas/mês sozinha — mais que o dobro do limite da empresa inteira.
//
// Por isso, por pipe: leitura COMPLETA só no primeiro uso (cache vazio) e
// 1x/dia (pega cards apagados/movidos pra outro pipe, que uma leitura
// incremental não vê); fora isso, leitura INCREMENTAL (só cards alterados
// desde o maior `updated_at` já visto no cache, via allCardsAtualizadosDesde
// — testada e confirmada na conta real, 20/10/2026,
// bmax_pipefy_correcoes_adendo.md; ainda assim cai pra leitura completa
// sozinha se a chamada falhar, nunca deixa a listagem quebrada). Gravação do
// próprio BMAX (createLeadPipefy/updateLeadPipefy) atualiza só o card
// alterado (atualizarCardNoCache), sem forçar reler o pipe inteiro.
//
// Próximo passo pós-virada (não implementado agora): um índice local
// atualizado por webhooks do Pipefy (guia seção 5.6), que elimina de vez a
// necessidade de varrer o pipe periodicamente — esse cache em memória é só
// uma rede de segurança enquanto isso não existe.
const UM_DIA_MS = 24 * 60 * 60 * 1000;

// nomePipe -> { cards: Map<cardId, card cru do Pipefy>, ultimaLeituraCompleta, ultimaAtualizacao, maiorUpdatedAt }
let _cachePorPipe = {};
let _atualizacoesEmAndamento = {}; // nomePipe -> Promise (deduplica atualizações concorrentes do mesmo pipe)

function pipefyCacheTtlMs() {
    const minutos = Number(process.env.PIPEFY_CACHE_MIN) || 30;
    return minutos * 60 * 1000;
}

function pipeIdPorNome(nomePipe) {
    return nomePipe === "BMAX" ? PIPEFY_PIPE_BMAX : pipeConfig(nomePipe).id;
}

// A referência pra leitura incremental é o maior `updated_at` JÁ VISTO nos
// dados do próprio Pipefy (não a hora do relógio local) — achado real do
// usuário (bmax_pipefy_correcoes_adendo.md, 20/10/2026): usar a hora local
// arriscaria perder alterações por diferença de relógio entre o servidor do
// BMAX e o do Pipefy. Comparação de string funciona porque o Pipefy sempre
// devolve o mesmo formato ISO 8601 com fuso (largura fixa).
function maiorUpdatedAt(cardsAnteriores, cards) {
    let maior = cardsAnteriores || null;
    for (const c of cards) {
        if (c.updated_at && (!maior || c.updated_at > maior)) maior = c.updated_at;
    }
    return maior;
}

// --- Persistência do cache no banco (Tarefa A6, 2º adendo 23/10/2026) ---
// Numa instância nova da Vercel (partida a frio), _cachePorPipe começa
// vazio, forçando uma leitura COMPLETA (~18 chamadas) mesmo que a leitura
// incremental já estivesse funcionando bem na instância anterior — com
// muitas partidas a frio por dia, o consumo sobe sem aviso. Essas 2 tabelas
// (scripts/create-pipefy-cache-tables.js) deixam uma instância nova carregar
// o cache do banco ANTES de chamar o Pipefy. Sempre best-effort: qualquer
// falha aqui só loga aviso e segue só com a memória — o cache no banco nunca
// pode derrubar o painel.
async function carregarCacheDoBanco(nomePipe) {
    try {
        const { sequelize } = require("../database");
        const { QueryTypes } = require("sequelize");
        const estado = await sequelize.query(
            `SELECT maior_updated_at, ultima_leitura_completa FROM bmax_pipefy_cache_estado WHERE pipe = :pipe`,
            { replacements: { pipe: nomePipe }, type: QueryTypes.SELECT }
        );
        if (!estado.length) return null;

        const linhas = await sequelize.query(
            `SELECT card_id, card FROM bmax_pipefy_cache_cards WHERE pipe = :pipe`,
            { replacements: { pipe: nomePipe }, type: QueryTypes.SELECT }
        );
        const ultimaLeituraCompleta = new Date(estado[0].ultima_leitura_completa).getTime();
        return {
            cards: new Map(linhas.map(l => [l.card_id, typeof l.card === "string" ? JSON.parse(l.card) : l.card])),
            maiorUpdatedAt: estado[0].maior_updated_at,
            ultimaLeituraCompleta,
            // Conservador: trata a última atualização como se fosse a última
            // leitura completa salva — a próxima chamada decide sozinha (pelo
            // TTL/forcarIncremental) se já é hora de atualizar de novo.
            ultimaAtualizacao: ultimaLeituraCompleta
        };
    } catch (e) {
        logger.warn({ message: "carregarCacheDoBanco: falha ao carregar — seguindo só com a memória", pipe: nomePipe, error: e.message });
        return null;
    }
}

// Tarefa A1 (3º adendo, 23/10/2026): uma consulta por card (antes) significa
// ~850 consultas seguidas numa leitura completa do INDÚSTRIA - INTERNO,
// DENTRO da própria requisição do painel — risco real de estourar o
// tempo-limite da função na Vercel. Grava em lotes de 100, um único INSERT
// com várias linhas em VALUES por lote; os parâmetros vão sempre via
// replacements nomeados (nunca concatenando conteúdo de card no texto da
// consulta).
const LOTE_SALVAR_CACHE = 100;

async function salvarCardsNoBanco(nomePipe, cards) {
    if (!cards.length) return;
    try {
        const { sequelize } = require("../database");
        const { QueryTypes } = require("sequelize");
        for (let i = 0; i < cards.length; i += LOTE_SALVAR_CACHE) {
            const lote = cards.slice(i, i + LOTE_SALVAR_CACHE);
            const replacements = { pipe: nomePipe };
            const valores = lote.map((c, j) => {
                replacements[`id${j}`] = c.id;
                replacements[`card${j}`] = JSON.stringify(c);
                return `(:pipe, :id${j}, :card${j}, now())`;
            }).join(", ");
            await sequelize.query(
                `INSERT INTO bmax_pipefy_cache_cards (pipe, card_id, card, atualizado_em)
                 VALUES ${valores}
                 ON CONFLICT (pipe, card_id) DO UPDATE SET card = EXCLUDED.card, atualizado_em = EXCLUDED.atualizado_em`,
                { replacements, type: QueryTypes.INSERT }
            );
        }
    } catch (e) {
        logger.warn({ message: "salvarCardsNoBanco: falha ao gravar — cache continua só em memória", pipe: nomePipe, error: e.message });
    }
}

async function salvarEstadoNoBanco(nomePipe, { maiorUpdatedAt: valor, ultimaLeituraCompleta }) {
    try {
        const { sequelize } = require("../database");
        const { QueryTypes } = require("sequelize");
        await sequelize.query(
            `INSERT INTO bmax_pipefy_cache_estado (pipe, maior_updated_at, ultima_leitura_completa)
             VALUES (:pipe, :maiorUpdatedAt, to_timestamp(:ultimaLeituraCompleta / 1000.0))
             ON CONFLICT (pipe) DO UPDATE SET maior_updated_at = :maiorUpdatedAt, ultima_leitura_completa = to_timestamp(:ultimaLeituraCompleta / 1000.0)`,
            { replacements: { pipe: nomePipe, maiorUpdatedAt: valor, ultimaLeituraCompleta }, type: QueryTypes.INSERT }
        );
    } catch (e) {
        logger.warn({ message: "salvarEstadoNoBanco: falha ao gravar", pipe: nomePipe, error: e.message });
    }
}

// Só depois de uma leitura COMPLETA (a incremental não sabe quem foi
// apagado/movido pra outro pipe).
async function removerCardsApagadosDoBanco(nomePipe, idsAtuais) {
    try {
        const { sequelize } = require("../database");
        await sequelize.query(
            `DELETE FROM bmax_pipefy_cache_cards WHERE pipe = :pipe AND card_id NOT IN (:ids)`,
            { replacements: { pipe: nomePipe, ids: idsAtuais.length ? idsAtuais : ["__nenhum__"] } }
        );
    } catch (e) {
        logger.warn({ message: "removerCardsApagadosDoBanco: falha ao limpar", pipe: nomePipe, error: e.message });
    }
}

// Tarefa A2.2 (3º adendo, 23/10/2026): um único card apagado (visto por
// atualizarCardNoCache, não por uma leitura completa) também precisa sair do
// banco — senão ele volta sozinho na próxima instância nova da Vercel.
async function removerCardDoBanco(nomePipe, cardId) {
    try {
        const { sequelize } = require("../database");
        await sequelize.query(
            `DELETE FROM bmax_pipefy_cache_cards WHERE pipe = :pipe AND card_id = :cardId`,
            { replacements: { pipe: nomePipe, cardId } }
        );
    } catch (e) {
        logger.warn({ message: "removerCardDoBanco: falha ao apagar", pipe: nomePipe, cardId, error: e.message });
    }
}

async function atualizarPipeNoCache(nomePipe, { forcarIncremental = false } = {}) {
    const pipeId = pipeIdPorNome(nomePipe);
    exigirConfig(pipeId, `o ID do pipe "${nomePipe}" (pipes.${nomePipe}.id)`);

    const agora = Date.now();
    let entrada = _cachePorPipe[nomePipe];

    // Cache em memória vazio (partida a frio) — tenta carregar do banco ANTES
    // de qualquer chamada ao Pipefy (Tarefa A6).
    if (!entrada) {
        entrada = await carregarCacheDoBanco(nomePipe);
        if (entrada) _cachePorPipe[nomePipe] = entrada;
    }

    if (!entrada || agora - entrada.ultimaLeituraCompleta >= UM_DIA_MS) {
        const cards = await allCardsInPipe(pipeId);
        logger.info({ message: "Leitura Pipefy", tipo: entrada ? "completa (diária)" : "completa (inicial)", pipe: nomePipe, cards: cards.length });
        const novoMaiorUpdatedAt = maiorUpdatedAt(null, cards);
        _cachePorPipe[nomePipe] = {
            cards: new Map(cards.map(c => [c.id, c])),
            ultimaLeituraCompleta: agora,
            ultimaAtualizacao: agora,
            maiorUpdatedAt: novoMaiorUpdatedAt
        };
        await salvarEstadoNoBanco(nomePipe, { maiorUpdatedAt: novoMaiorUpdatedAt, ultimaLeituraCompleta: agora });
        await salvarCardsNoBanco(nomePipe, cards);
        await removerCardsApagadosDoBanco(nomePipe, cards.map(c => c.id));
        return;
    }

    const precisaAtualizar = forcarIncremental || agora - entrada.ultimaAtualizacao >= pipefyCacheTtlMs();

    // Sem nenhum updated_at visto ainda (pipe ficou vazio na leitura
    // completa) — não há referência possível pro filtro incremental. Se
    // ninguém está com pressa (não forçado), só marca a tentativa como feita
    // e segue sem chamada; se foi FORÇADO (Tarefa A5 — checagem de
    // duplicidade que precisa mesmo de dado fresco), uma leitura completa é
    // a única forma de resolver, então faz essa em vez de não fazer nada.
    if (precisaAtualizar && !entrada.maiorUpdatedAt) {
        if (!forcarIncremental) {
            entrada.ultimaAtualizacao = agora;
            return;
        }
        const cards = await allCardsInPipe(pipeId);
        logger.info({ message: "Leitura Pipefy", tipo: "completa (forçada, sem referência)", pipe: nomePipe, cards: cards.length });
        entrada.cards = new Map(cards.map(c => [c.id, c]));
        entrada.ultimaLeituraCompleta = agora;
        entrada.ultimaAtualizacao = agora;
        entrada.maiorUpdatedAt = maiorUpdatedAt(null, cards);
        await salvarEstadoNoBanco(nomePipe, { maiorUpdatedAt: entrada.maiorUpdatedAt, ultimaLeituraCompleta: agora });
        await salvarCardsNoBanco(nomePipe, cards);
        await removerCardsApagadosDoBanco(nomePipe, cards.map(c => c.id));
        return;
    }

    if (precisaAtualizar) {
        let cards, completo;
        try {
            cards = await allCardsAtualizadosDesde(pipeId, entrada.maiorUpdatedAt);
            completo = false;
        } catch (e) {
            logger.warn({ message: "fetchAllDealsPipefy: filtro incremental do Pipefy falhou, caindo pra leitura completa", pipe: nomePipe, error: e.message });
            cards = await allCardsInPipe(pipeId);
            completo = true;
        }
        logger.info({ message: "Leitura Pipefy", tipo: completo ? "completa (fallback)" : "incremental", pipe: nomePipe, cards: cards.length });
        if (completo) {
            // A2.1 (3º adendo, 23/10/2026): a leitura completa de RESERVA (quando
            // a incremental falha) substitui a lista, igual a uma leitura completa
            // normal — somar (como antes) deixava cards apagados/movidos pra outro
            // pipe presos no cache até a próxima leitura diária.
            entrada.cards = new Map(cards.map(c => [c.id, c]));
        } else {
            for (const c of cards) entrada.cards.set(c.id, c);
        }
        entrada.ultimaAtualizacao = agora;
        entrada.maiorUpdatedAt = completo ? maiorUpdatedAt(null, cards) : maiorUpdatedAt(entrada.maiorUpdatedAt, cards);
        if (completo) entrada.ultimaLeituraCompleta = agora;

        await salvarEstadoNoBanco(nomePipe, { maiorUpdatedAt: entrada.maiorUpdatedAt, ultimaLeituraCompleta: entrada.ultimaLeituraCompleta });
        await salvarCardsNoBanco(nomePipe, cards);
        if (completo) await removerCardsApagadosDoBanco(nomePipe, cards.map(c => c.id));
    }
}

async function obterCardsDoPipe(nomePipe, opts = {}) {
    if (!_atualizacoesEmAndamento[nomePipe]) {
        _atualizacoesEmAndamento[nomePipe] = atualizarPipeNoCache(nomePipe, opts).finally(() => {
            delete _atualizacoesEmAndamento[nomePipe];
        });
    }
    await _atualizacoesEmAndamento[nomePipe];
    return Array.from(_cachePorPipe[nomePipe].cards.values());
}

// Invalidação "nuclear" — limpa o cache de todos os pipes, forçando leitura
// completa de novo na próxima chamada. Preferir atualizarCardNoCache (abaixo)
// depois de uma gravação do próprio BMAX; isso aqui fica só como utilitário
// manual/de teste.
function invalidarCachePipefy() {
    _cachePorPipe = {};
}

// Depois de criar/atualizar UM card (createLeadPipefy/updateLeadPipefy),
// atualiza só esse card no cache do pipe a que ele pertence, em vez de
// invalidar tudo — evita forçar uma leitura completa do pipe inteiro a cada
// gravação. Card novo é inserido; card que sumiu (raríssimo) é removido do
// Map (e do banco, Tarefa A2.2) se getCard devolver nulo. Pipes ainda sem
// cache aquecido são ignorados — a próxima leitura desse pipe já faz a
// completa normalmente.
//
// Nota (Tarefa A2.3, 3º adendo 23/10/2026): esta função NÃO mexe em
// entrada.maiorUpdatedAt de propósito — já foi cogitado "corrigir" isso pra
// avançar o maiorUpdatedAt até o updated_at do card que o próprio BMAX
// acabou de gravar, mas isso é um bug, não uma melhoria: alterações feitas
// por OUTRAS pessoas no intervalo entre o valor antigo e esse seriam
// puladas pela próxima leitura incremental. O único efeito de deixar como
// está é o card gravado voltar mais uma vez na leitura incremental
// seguinte (sem prejuízo nenhum) — não mexer aqui.
async function atualizarCardNoCache(cardId) {
    const card = await getCard(cardId);
    for (const nomePipe of Object.keys(_cachePorPipe)) {
        if (!card) {
            _cachePorPipe[nomePipe].cards.delete(cardId);
            await removerCardDoBanco(nomePipe, cardId); // A2.2
            continue;
        }
        if (card.pipe?.id === pipeIdPorNome(nomePipe)) {
            _cachePorPipe[nomePipe].cards.set(cardId, card);
            await salvarCardsNoBanco(nomePipe, [card]); // Tarefa A6
        }
    }
}

// Descobre de qual pipe um card é — usado por updateLeadPipefy/
// createTaskPipefy/updateTaskPipefy (Tarefa A3, 2º adendo 23/10/2026) pra
// gravar na fase/campos do pipe CERTO, não sempre BMAX. Primeiro procura o
// ID em cada Map do cache (sem chamada nenhuma); só se não achar em nenhum
// é que faz 1 chamada a getCard. "BMAX" é o fallback final se nem isso achar
// (não deveria acontecer na prática — resolverCardId já teria falhado antes
// com um ID inexistente).
function nomePipeDoCardEmCache(cardId) {
    for (const [nomePipe, entrada] of Object.entries(_cachePorPipe)) {
        if (entrada.cards.has(cardId)) return nomePipe;
    }
    return null;
}

async function nomePipeDoCard(cardId) {
    const doCache = nomePipeDoCardEmCache(cardId);
    if (doCache) return doCache;
    const card = await getCard(cardId);
    return (card && nomeDoPipePorId(card.pipe?.id)) || "BMAX";
}

function configDoPipe(nomePipe) {
    return nomePipe === "BMAX"
        ? { id: PIPEFY_PIPE_BMAX, fases: PIPEFY_FASES, campos: PIPEFY_CAMPOS }
        : pipeConfig(nomePipe);
}

// Quais pipes alimentam getLeads/o painel — PIPEFY_PIPES_PORTAL, padrão
// "INDÚSTRIA - INTERNO" (Tarefa 11: é o único funil que o painel RD lê hoje,
// fetchAllDealsFromRD). Continua configurável, não hardcoded.
async function fetchAllDealsPipefy() {
    const porPipe = await Promise.all(PIPEFY_PIPES_PORTAL.map(async (nomePipe) => {
        const cards = await obterCardsDoPipe(nomePipe);
        return cards.map(c => cardParaDealFake(c, nomePipe));
    }));
    return porPipe.flat();
}

// ID de negociação do RD = ObjectId estilo Mongo, 24 chars hex (ex.:
// "66151c1470449b000d54e919"). ID de card do Pipefy = só dígitos, tipicamente
// bem mais curto. Heurística por formato (Tarefa 8) — não é 100% infalível
// em teoria, mas suficiente na prática (um id do RD praticamente sempre tem
// alguma letra a-f entre 24 caracteres hex).
function pareceIdDoRd(id) {
    return /^[0-9a-fA-F]{24}$/.test(String(id));
}

// Resolve um id (do RD OU do Pipefy) pro id do CARD no Pipefy. Cobre os 3
// casos reais de getDealById hoje: id de card recém-criado na mesma
// requisição (negociacao.service.js, nunca persistido — devolvido direto,
// sem round-trip); id do RD já mapeado via CSV
// (scripts/importar-mapa-rd-pipefy.js) ou busca anterior; id do RD ainda
// não mapeado (busca 1x via findCardByRdId, guia seção 5.1, e grava o
// resultado pra não repetir a busca da próxima vez).
async function resolverCardId(id) {
    const idStr = String(id);
    // Um id que já parece um card do Pipefy (ex.: card recém-criado na mesma
    // requisição, negociacao.service.js) nunca precisa de ida ao banco — é
    // devolvido direto, sem seguir cadeia de transferência: um card recém-
    // criado nunca foi transferido ainda. Tabelas do BMAX, hoje, só guardam
    // id do RD (24 hex), então é por ali (abaixo) que uma transferência
    // antiga precisa ser seguida.
    if (!pareceIdDoRd(idStr)) return idStr;

    const { sequelize } = require("../database");
    const { QueryTypes } = require("sequelize");

    const rows = await sequelize.query(
        `SELECT pipefy_card_id FROM bmax_rd_pipefy_map WHERE rd_deal_id = :rdDealId LIMIT 1`,
        { replacements: { rdDealId: idStr }, type: QueryTypes.SELECT }
    );
    if (rows.length) return await seguirTransferencia(rows[0].pipefy_card_id);

    // Não mapeado ainda — procura em TODOS os pipes de pipesParaChecarDuplicata
    // (BMAX + os do painel), cada um com o SEU campo "ID no RD CRM" (os ids
    // de campo podem, em teoria, diferir entre pipes), parando no primeiro
    // que achar (Tarefa A2, 2º adendo 23/10/2026 — antes só tentava o BMAX,
    // então negociações migradas do INDÚSTRIA - INTERNO nunca eram achadas).
    for (const nomePipe of pipesParaChecarDuplicata()) {
        const configPipe = nomePipe === "BMAX"
            ? { id: PIPEFY_PIPE_BMAX, campos: PIPEFY_CAMPOS }
            : pipeConfig(nomePipe);
        const pipeId = configPipe.id;
        const campoIdRd = configPipe.campos["ID no RD CRM"];
        if (!pipeId || !campoIdRd) continue;

        const card = await findCardByRdId(pipeId, campoIdRd, idStr);
        if (!card) continue;

        await sequelize.query(
            `INSERT INTO bmax_rd_pipefy_map (rd_deal_id, pipefy_card_id) VALUES (:rdDealId, :cardId)
             ON CONFLICT (rd_deal_id) DO UPDATE SET pipefy_card_id = :cardId`,
            { replacements: { rdDealId: idStr, cardId: card.id }, type: QueryTypes.INSERT }
        );
        return await seguirTransferencia(card.id);
    }

    throw new Error(`Nenhum card do Pipefy encontrado para o ID do RD "${idStr}"`);
}

// Tarefa B1 (3º adendo, 26/10/2026): depois de resolver um id do RD pro id do
// card no Pipefy (pelas duas vias acima), segue a cadeia de transferências
// BOX+REV>IND (bmax_pipefy_transferencias, gravada por
// transferirCardParaIndustria) até o card VIVO. Assim, uma tabela do BMAX
// que guarda o id do RD de uma negociação já transferida continua resolvendo
// pro card certo sem nenhuma migração nessas tabelas. Limite de 10 saltos só
// por segurança (nunca deveria encadear tanto na prática).
async function seguirTransferencia(cardId) {
    const { sequelize } = require("../database");
    const { QueryTypes } = require("sequelize");
    let atual = cardId;
    for (let i = 0; i < 10; i++) {
        const rows = await sequelize.query(
            `SELECT card_destino FROM bmax_pipefy_transferencias WHERE card_origem = :origem LIMIT 1`,
            { replacements: { origem: atual }, type: QueryTypes.SELECT }
        );
        if (!rows.length) return atual;
        atual = rows[0].card_destino;
    }
    return atual;
}

async function getDealByIdPipefy(id) {
    const cardId = await resolverCardId(id);
    const card = await getCard(cardId);
    if (!card) return null;
    // Traduz com a tabela do pipe DO CARD, não sempre BMAX (Tarefa A2, 2º
    // adendo 23/10/2026) — senão um card do INDÚSTRIA - INTERNO volta sem
    // etapa/win, e o guard-clause de caminhoVenda.service.js (que barra
    // redefinir caminho em negociação já vendida/perdida) para de funcionar
    // pra ele.
    return cardParaDealFake(card, nomeDoPipePorId(card.pipe?.id) || "BMAX");
}

// Equivalente a getContatoPrincipal (rd.leads.service.js) — nome/telefone
// do contato principal, usado SOMENTE depois que o caminho já é PCI12A
// (mesma regra de privacidade de lá — ver comentário em
// rd.leads.service.js/caminhoVenda.service.js). No RD esse dado vem da
// Organização; no Pipefy não existe esse conceito — lê direto o registro
// conectado ao campo "Contato" do card, na database certa pro pipe
// (tabelaContatoDoPipe, que já sabe que o CRM BOXER SOLDAS usa "Contatos
// (RD)" em vez de "Contatos Comercial"). "Contatos (RD)" não tem campo de
// telefone no mapa — pra cards desse pipe, só o nome vem preenchido.
async function getContatoPrincipalPipefy(cardId) {
    try {
        const id = await resolverCardId(cardId);
        const card = await getCard(id);
        if (!card) return null;

        const nomePipe = nomeDoPipePorId(card.pipe?.id) || "BMAX";
        const campoContatoId = configDoPipe(nomePipe).campos["Contato"];
        if (!campoContatoId) return null;

        const campo = (card.fields || []).find(f => f.field.id === campoContatoId);
        const idsContato = campo ? idsConectadosPorCampo(campo) : [];
        if (!idsContato.length) return null;

        const tabelaContato = tabelaContatoDoPipe(nomePipe);
        if (!tabelaContato.id) return null;

        const registro = await getTableRecord(idsContato[0]);
        if (!registro) return null;

        const porCampoId = {};
        for (const rf of registro.record_fields || []) porCampoId[rf.field.id] = rf.value;

        return {
            nome: (tabelaContato.campoNome && porCampoId[tabelaContato.campoNome]) || null,
            telefone: (tabelaContato.campoTelefone && porCampoId[tabelaContato.campoTelefone]) || null
        };
    } catch (e) {
        logger.error({ message: "getContatoPrincipalPipefy: erro ao buscar contato do card", cardId, error: e.message });
        return null;
    }
}

function dealBateComCnpj(deal, cnpjClean) {
    // "Bloqueia duplicata" = mesma regra de dealBloqueiaDuplicata
    // (rd.leads.service.js): lead com resultado final (ganho ou perdido) no
    // RD não impede criar uma negociação nova pro mesmo CNPJ.
    return deal.win !== true && deal.win !== false && normalizeCnpj(
        (deal.deal_custom_fields.find(f => f.custom_field.label === "CNPJ") || {}).value
    ) === cnpjClean;
}

// Pipes a checar antes de criar uma negociação nova — os que alimentam o
// painel (PIPEFY_PIPES_PORTAL) mais BMAX sempre (destino de createLeadPipefy
// fora do caminho "indústria"; ver escolherPipeDaNegociacao), sem duplicar se
// BMAX já estiver em PIPEFY_PIPES_PORTAL (Tarefa 5/6, bmax_pipefy_correcoes_adendo.md).
function pipesParaChecarDuplicata() {
    return Array.from(new Set([...PIPEFY_PIPES_PORTAL, "BMAX"]));
}

async function buscarPorPipes(nomesPipe, opts = {}) {
    const porPipe = await Promise.all(nomesPipe.map(async (nomePipe) => {
        const cards = await obterCardsDoPipe(nomePipe, opts);
        return cards.map(c => cardParaDealFake(c, nomePipe));
    }));
    return porPipe.flat();
}

// Pipes cobertos pela Consulta de Lead do Motor (Fase 7, 19/11/2026,
// decidido com o usuário): os 4 pipes ativos — INDÚSTRIA - INTERNO fica de
// fora (substituído pelo CRM BOXER SOLDAS na Fase 5).
const PIPES_CONSULTA_LEAD = ["CRM BOXER SOLDAS", "BMAX", "REVENDA - INTERNO", "FUNIL SDR"];

// Devolve os cards desses 4 pipes já traduzidos (cardParaDealFake), cada um
// tagueado com _pipelineNome — o bastante pra rd.leads.service.js continuar
// usando dealParaResultado/dealBloqueiaDuplicata (genéricas, já existentes,
// não sabem nada sobre Pipefy) sem nenhuma mudança nelas. `opts` repassado
// pra obterCardsDoPipe (ex.: { forcarIncremental: true } na busca por CNPJ,
// que precisa do estado mais atual possível — mesma urgência que
// getLeadByCnpjPipefy já trata, acima).
//
// E-mail/telefone do contato ficam DE FORA de propósito (decisão do
// usuário, 19/11/2026): ler o registro de Contato conectado custaria 1
// chamada extra (getTableRecord) POR CARD — centenas a milhares de
// chamadas só pra montar o índice, contra um orçamento de 10 mil
// chamadas/mês pra empresa inteira. Busca por CNPJ/nome/empresa funciona
// normalmente; por e-mail/telefone não encontra nada vindo do Pipefy
// (dealParaResultado já trata `contatos: []`, sem mudança nenhuma lá).
async function fetchAllCardsConsultaLeadPipefy(opts = {}) {
    const porPipe = await Promise.all(PIPES_CONSULTA_LEAD.map(async (nomePipe) => {
        const cards = await obterCardsDoPipe(nomePipe, opts);
        return cards.map(card => {
            const deal = cardParaDealFake(card, nomePipe);
            deal._pipelineNome = nomePipe;
            return deal;
        });
    }));
    return porPipe.flat();
}

async function getLeadByCnpjPipefy(cnpj) {
    const cnpjClean = normalizeCnpj(cnpj);
    if (!cnpjClean) return null;

    const pipes = pipesParaChecarDuplicata();
    const deals = await buscarPorPipes(pipes);
    const encontrado = deals.find(d => dealBateComCnpj(d, cnpjClean));
    if (encontrado) return encontrado;

    // Não achou no cache (até PIPEFY_CACHE_MIN velho) — antes de concluir que
    // não há duplicata, força uma leitura INCREMENTAL desses pipes (não
    // completa), pra pegar uma negociação criada há poucos minutos (ex.:
    // duas abas/cliques quase simultâneos pro mesmo CNPJ). Até a Tarefa A5
    // (2º adendo, 23/10/2026) isso apagava o cache inteiro e forçava uma
    // leitura COMPLETA (~18 chamadas por negociação nova — com 10
    // negociações/dia, ~5.400 chamadas/mês, metade do limite da empresa
    // inteira). Só essa segunda busca força; não repete de novo depois disso.
    const dealsFrescos = await buscarPorPipes(pipes, { forcarIncremental: true });
    return dealsFrescos.find(d => dealBateComCnpj(d, cnpjClean)) || null;
}

// Mesma escolha de funil do createLead do RD (rd.leads.service.js:304-312):
// revenda sempre vai pro BMAX; representante/admin podem escolher "indústria"
// (campo "Funil" do formulário) — decide pelo role real (negociacao.role,
// setado pelo controller a partir do token), nunca por algo vindo do body
// pra quem não pode escolher (Tarefa 5/6, bmax_pipefy_correcoes_adendo.md).
// REGRA (André, 25/11/2026): hoje só existe o pipe CRM BOXER SOLDAS; os funis do RD viraram ETIQUETAS. Nova Negociação:
//   - a REVENDA vende sozinha (BOX>REV, "blindagem")            -> etiqueta "RD: BMAX"      (antigo funil BMAX-Interno do RD; fora do painel e da comissão)
//   - a BOXER atende (BOX+REV>IND, ou lead Indústria/PCI 12)    -> etiqueta "RD: Indústria" (entra no painel e gera comissão pela política)
// O Portal só considera cards com a etiqueta "RD: Indústria".
function escolherPipeDaNegociacao(negociacao) {
    const podeEscolherFunil = negociacao.role === "adm" || negociacao.role === "representante";
    const quisIndustria = podeEscolherFunil && negociacao.funil === "industria";
    const boxerAtende = quisIndustria || negociacao.atendimento === "boxer" || negociacao.caminho === "BOX+REV>IND";
    return { nomePipe: "CRM BOXER SOLDAS", nomeFaseInicial: "Lead", etiqueta: boxerAtende ? "RD: Indústria" : "RD: BMAX" };
}

async function createLeadPipefy(negociacao) {
    const { nomePipe, nomeFaseInicial, etiqueta } = escolherPipeDaNegociacao(negociacao);
    const configPipe = nomePipe === "BMAX"
        ? { id: PIPEFY_PIPE_BMAX, fases: PIPEFY_FASES, campos: PIPEFY_CAMPOS }
        : pipeConfig(nomePipe);

    const pipeId = exigirConfig(configPipe.id, `o ID do pipe "${nomePipe}" (pipes.${nomePipe}.id)`);
    const faseInicial = exigirConfig(configPipe.fases[nomeFaseInicial], `o ID da fase "${nomeFaseInicial}" (pipes.${nomePipe}.fases)`);
    // "Título" é opcional (não existe no CRM BOXER SOLDAS — o título nativo do
    // card, abaixo em createCard, já cobre o mesmo papel nesse pipe).
    const campoTitulo = configPipe.campos["Título"];
    const campoPci = exigirConfig(configPipe.campos["PCI"], `o ID do campo PCI (pipes.${nomePipe}.campos)`);

    // No pipe INDÚSTRIA - INTERNO, o PCI é obrigatório no formulário inicial
    // (testado na conta pelo usuário: sem ele, o Pipefy recusa o card com "O
    // campo PCI é obrigatório") — por isso SEMPRE enviamos um valor, nunca
    // vazio, usando "Sem PCI" (uma das 21 opções) quando o usuário não
    // informou. Nos outros pipes o PCI continua opcional, mas enviar sempre
    // não quebra nada.
    const pciValor = negociacao.pci || "Sem PCI";
    validarPci(pciValor);

    const camposCard = [];
    if (campoTitulo) camposCard.push({ field_id: campoTitulo, field_value: negociacao.nome });

    // O formulário de Nova Negociação do Portal hoje só coleta dado de
    // empresa (CNPJ/nome/cidade/CEP), não um contato individual (nome/e-mail
    // de uma pessoa) — o guia (seção 5.4) pressupõe achar/criar um contato
    // por e-mail antes do card. Gap conhecido: sem e-mail no formulário, o
    // card é criado SEM contato vinculado. Resolver isso (adicionar e-mail
    // de contato no formulário, ou outra fonte) antes da virada real.
    if (negociacao.email) {
        const campoContato = exigirConfig(configPipe.campos["Contato"], `o ID do campo Contato (pipes.${nomePipe}.campos)`);
        const tabelaContato = tabelaContatoDoPipe(nomePipe);
        let contato = await findContatoPorEmail(tabelaContato.id, tabelaContato.campoEmail, negociacao.email);
        if (!contato) {
            contato = await createContato(tabelaContato.id, negociacao.nome, montarCamposValidos([
                { field_id: tabelaContato.campoNome, field_value: negociacao.nome },
                { field_id: tabelaContato.campoEmail, field_value: negociacao.email }
            ]));
        }
        camposCard.push({ field_id: campoContato, field_value: [contato.id] });
    } else {
        logger.warn({ message: "Negociação criada no Pipefy sem contato vinculado (sem e-mail no formulário)", nome: negociacao.nome, pipe: nomePipe });
    }

    // Achado real (26/10/2026): antes desta correção, createLeadPipefy nunca
    // ligava Empresa nenhuma — um card sem Empresa não tem o que a
    // transferência BOX+REV>IND (transferirCardParaIndustria) copiar nesse
    // campo. Mesmo padrão do Contato acima (achar por CNPJ, criar se não
    // existir), mas usando CNPJ em vez de e-mail — o formulário de Nova
    // Negociação sempre coleta CNPJ, então, ao contrário do Contato, isso
    // não depende de um dado opcional.
    const campoEmpresa = configPipe.campos["Empresa"];
    const tabelaEmpresa = tabelaEmpresaDoPipe(nomePipe);
    if (campoEmpresa && negociacao.cnpj && tabelaEmpresa.id && tabelaEmpresa.campoCnpj) {
        // CNPJ gravado só com números no database de Empresas (mesmo formato
        // já usado em getLeadByCnpjPipefy/normalizeCnpj) — o formulário de
        // Nova Negociação aceita CNPJ com pontuação, então normaliza antes
        // de buscar/gravar, senão "11.222.333/0001-81" nunca bate com o
        // registro gravado como "11222333000181" e cria um duplicado.
        const cnpjNormalizado = normalizeCnpj(negociacao.cnpj);
        try {
            let empresa = await findContatoPorEmail(tabelaEmpresa.id, tabelaEmpresa.campoCnpj, cnpjNormalizado);
            if (!empresa) {
                empresa = await createContato(tabelaEmpresa.id, negociacao.nome, montarCamposValidos([
                    { field_id: tabelaEmpresa.campoNome, field_value: negociacao.nome },
                    { field_id: tabelaEmpresa.campoCnpj, field_value: cnpjNormalizado }
                ]));
            }
            camposCard.push({ field_id: campoEmpresa, field_value: [empresa.id] });
        } catch (e) {
            // Achar/criar a Empresa nunca pode impedir a negociação de ser
            // registrada — card é criado sem a Empresa vinculada, e o aviso
            // fica registrado pra correção manual depois.
            logger.warn({ message: "Falha ao achar/criar Empresa no Pipefy — card será criado sem Empresa vinculada", cnpj: cnpjNormalizado, erro: e.message, nome: negociacao.nome, pipe: nomePipe });
        }
    } else if (campoEmpresa) {
        logger.warn({ message: "Negociação criada no Pipefy sem Empresa vinculada (sem CNPJ no formulário, ou database Empresas não configurado)", nome: negociacao.nome, pipe: nomePipe });
    }

    if (configPipe.campos["CNPJ"]) camposCard.push({ field_id: configPipe.campos["CNPJ"], field_value: negociacao.cnpj || "" });
    if (configPipe.campos["Cidade"]) camposCard.push({ field_id: configPipe.campos["Cidade"], field_value: negociacao.cidade || "" });
    if (configPipe.campos["Revenda/Loja"]) camposCard.push({ field_id: configPipe.campos["Revenda/Loja"], field_value: revendaParaPipefy(nomePipe, negociacao.revenda || "") });
    if (configPipe.campos["Representante"]) camposCard.push({ field_id: configPipe.campos["Representante"], field_value: negociacao.representante || "" });
    if (configPipe.campos["Máquina de interesse"]) camposCard.push({ field_id: configPipe.campos["Máquina de interesse"], field_value: negociacao.maquinainteresse || "" });
    camposCard.push({ field_id: campoPci, field_value: pciParaPipefy(nomePipe, pciValor) });

    // O pipe CRM BOXER SOLDAS exige "Responsável" no formulário inicial (descoberto em 25/11/2026: sem ele a criação é recusada pelo Pipefy).
    // Usa o responsável da negociação (revenda vende = "Revenda"); sem membro correspondente cai no administrador (EMAIL_FALLBACK). O fluxo de
    // encaminhamento (caminhoVenda) troca o responsável logo depois quando a Boxer atende.
    if (typeof getStartFormFields === "function") {
        try {
            const campoResp = (await getStartFormFields(pipeId)).find(f => f.required && f.type === "assignee_select");
            if (campoResp && !camposCard.some(c => c.field_id === campoResp.id)) {
                const nomeOwner = negociacao.responsavel || (negociacao.atendimento === "revenda" ? "Revenda" : null);
                let assigneeId = nomeOwner && RD_OWNERS[nomeOwner] ? await resolverAssigneeId(RD_OWNERS[nomeOwner]) : null;
                if (!assigneeId && process.env.EMAIL_FALLBACK) assigneeId = PIPEFY_MEMBROS[String(process.env.EMAIL_FALLBACK).trim().toLowerCase()] || PIPEFY_MEMBROS[process.env.EMAIL_FALLBACK] || null;
                if (assigneeId) camposCard.push({ field_id: campoResp.id, field_value: [String(assigneeId)] });
                else logger.warn({ message: "Nova Negociação: não achei membro do Pipefy para o campo Responsável obrigatório — a criação pode ser recusada", nomeOwner });
            }
        } catch (e) { logger.warn({ message: "Nova Negociação: falha ao preencher o Responsável obrigatório", error: e.message }); }
    }

    // Etiqueta do funil de origem. Sem ela o card ficaria fora do Portal: se a etiqueta não existir no pipe, falha ALTO (nunca cria card sem etiqueta).
    let labelIds = [];
    if (etiqueta && typeof getPipeLabels === "function") {
        const etiquetas = await getPipeLabels(pipeId);
        const achada = etiquetas.find(e => String(e.name).trim() === etiqueta);
        if (!achada) throw new Error(`A etiqueta "${etiqueta}" não existe no pipe "${nomePipe}" do Pipefy — card NÃO criado`);
        labelIds = [achada.id];
    }
    const card = labelIds.length
        ? await createCard(pipeId, faseInicial, negociacao.nome, montarCamposValidos(camposCard), labelIds)
        : await createCard(pipeId, faseInicial, negociacao.nome, montarCamposValidos(camposCard));
    await atualizarCardNoCache(card.id);
    return { id: card.id };
}

// Mesmos slugs genéricos de RD_CF_SLUG_MAP (src/config/constants.js) que
// aplicarCaminhoVenda/controllers já usam em updateLead — traduzidos aqui
// pro rótulo do campo equivalente no Pipefy. "classe-de-preco" fica de fora
// (null), igual no RD: não é gravável por esse caminho em nenhum dos dois.
const CAMPO_PIPEFY_POR_SLUG = {
    "perfil-pci": "PCI",
    "cnpj": "CNPJ",
    "cidade": "Cidade",
    "estado": "Estado",
    "revenda-loja": "Revenda/Loja",
    "representante": "Representante",
    "maquina-de-interesse-1": "Máquina de interesse",
    "notas": "Notas",
    "seguimento-do-produto": "Segmento de produto",
    "classe-de-preco": null
};

// Traduz owner_id do RD (chega aqui como o ID de usuário do RD vindo de
// RD_OWNERS — ex.: RD_OWNERS["Revenda"] — nunca como nome ou e-mail direto)
// pro membro do Pipefy, em 3 passos: ID do RD -> nome (lookup reverso em
// RD_OWNERS) -> e-mail (getAliasMaps().rdToEmail, por nome) -> ID do membro
// no Pipefy (PIPEFY_MEMBROS, por e-mail). Sem membro correspondente em
// qualquer um dos passos, só avisa — não falha a operação (owner é
// informativo, não bloqueia nenhuma regra de negócio como o PCI bloqueia).
function nomeDoOwnerRd(ownerIdRd) {
    return Object.entries(RD_OWNERS).find(([, id]) => id === ownerIdRd)?.[0] || null;
}

async function resolverAssigneeId(ownerIdRd) {
    const nome = nomeDoOwnerRd(ownerIdRd);
    if (!nome) return null;

    const { rdToEmail } = await getAliasMapsLazy();
    const email = rdToEmail[nome];
    if (!email) return null;

    return PIPEFY_MEMBROS[email] || null;
}

// Tarefa B1 (3º adendo, decisão tomada em 26/10/2026): quando o caminho de
// venda "BOX+REV>IND" pede a etapa "Negociação" pra um card do BMAX — que
// não tem essa fase (só existe no INDÚSTRIA - INTERNO, como "NEGOCIAÇÃO") —
// em vez de lançar erro (como updateLeadPipefy já faz pra qualquer etapa sem
// fase correspondente), cria um card NOVO lá (o Pipefy não move card entre
// pipes — ver moveCardToPhase), move o de origem pra uma fase final própria
// do BMAX ("Transferido para a Indústria") e grava a ligação em
// bmax_pipefy_transferencias — resolverCardId passa a seguir essa ligação
// (seguirTransferencia, acima), então as tabelas do BMAX que guardam o id
// antigo continuam funcionando sem nenhuma migração. Tabela pequena e
// explícita (não um algoritmo genérico de busca em todos os pipes) porque é
// o único caso real hoje.
const DESTINO_TRANSFERENCIA_POR_ETAPA = {
    BMAX: {
        [RD_STAGE_NEGOCIACAO]: { nomePipe: "CRM BOXER SOLDAS", nomeFase: "Negociação" }
    }
};

const FASE_ORIGEM_TRANSFERIDA = "Transferido para a Indústria"; // só existe no pipe BMAX

// Campos copiados do card de origem pro card novo (lista fechada, decidida
// com o usuário) — só os que existirem nos dois pipes. "Título"/"PCI"/"Valor
// total"/"Data de criação no RD" têm tratamento à parte em
// transferirCardParaIndustria (título é parâmetro da criação do card, não um
// campo do lote; PCI tem valor padrão obrigatório; valor e data precisam de
// conversão de formato).
const CAMPOS_TRANSFERENCIA = [
    "Contato", "Empresa", "CNPJ", "Cidade", "Estado", "Representante",
    "Revenda/Loja", "Máquina de interesse", "Oportunidade de venda",
    "Frente de trabalho", "Segmento de produto", "Classe de preço",
    "Fonte", "Campanha", "ID no RD CRM"
];

// "Contato"/"Empresa" são campos de CONEXÃO (ligam a um registro do database
// Contatos/Empresas Comercial) — achado real, testado na conta (26/10/2026):
// o `value` de um campo desses traz os TÍTULOS dos registros conectados
// (ex.: '["Nome do contato"]'), não os IDs; gravar isso de volta num
// field_value faz o Pipefy ignorar a conexão em SILÊNCIO (sem erro), e o
// card novo nascia sem Contato nem Empresa. Os IDs de verdade vêm de
// `array_value`/`connectedRepoItems[].id` (ver getCard, pipefy.service.js) —
// por isso esses dois campos usam `idsConectadosPorCampoId` (abaixo), não
// `valorPorCampoId`, no loop de CAMPOS_TRANSFERENCIA.
const CAMPOS_CONECTOR = ["Contato", "Empresa"];

// Extrai o(s) ID(s) de registro conectado de um campo de CONEXÃO do card
// (ex.: "Contato", "Empresa") — mesmo achado real citado acima:
// `connectedRepoItems[].id` traz o id direto, tipado; `array_value` serve de
// reserva (mesmo valor, confirmado igual na conta real), só aceitando
// valores que pareçam id numérico, nunca um texto solto. Usada tanto na
// transferência (abaixo) quanto em getContatoPrincipalPipefy.
function idsConectadosPorCampo(f) {
    const idsPorConnectedRepoItems = (f.connectedRepoItems || []).map(item => item?.id).filter(Boolean);
    const idsPorArrayValue = Array.isArray(f.array_value) ? f.array_value.filter(v => /^\d+$/.test(String(v))) : [];
    return idsPorConnectedRepoItems.length ? idsPorConnectedRepoItems : idsPorArrayValue;
}

// Achado real (18/11/2026): nem todo pipe usa a mesma database pra
// Contato/Empresa (CRM BOXER SOLDAS usa "Contatos (RD)"/"Empresas (RD)",
// diferente de Contatos/Empresas Comercial dos demais — ver
// tabelaContatoDoPipe/tabelaEmpresaDoPipe, pipefyConstants.js). Copiar o ID
// do registro de origem direto pro campo de destino só funciona quando os
// dois pipes usam a MESMA database; quando divergem, acha (por e-mail/CNPJ)
// ou cria o equivalente na database do destino, lendo o registro de origem
// (getTableRecord) pra saber esse e-mail/CNPJ.
async function idsConectorNaBaseDoDestino(rotulo, idsOrigem, nomePipeOrigem, nomePipeDestino) {
    const tabelaOrigem = rotulo === "Empresa" ? tabelaEmpresaDoPipe(nomePipeOrigem) : tabelaContatoDoPipe(nomePipeOrigem);
    const tabelaDestino = rotulo === "Empresa" ? tabelaEmpresaDoPipe(nomePipeDestino) : tabelaContatoDoPipe(nomePipeDestino);
    if (!tabelaOrigem.id || !tabelaDestino.id) return null;
    if (tabelaOrigem.id === tabelaDestino.id) return idsOrigem; // mesma database — o ID já serve direto

    const idOrigem = idsOrigem[0];
    const registroOrigem = await getTableRecord(idOrigem);
    if (!registroOrigem) return null;

    const campoChaveOrigem = rotulo === "Empresa" ? tabelaOrigem.campoCnpj : tabelaOrigem.campoEmail;
    const campoChaveDestino = rotulo === "Empresa" ? tabelaDestino.campoCnpj : tabelaDestino.campoEmail;
    let valorChave = registroOrigem.record_fields.find(f => f.field.id === campoChaveOrigem)?.value;
    if (!valorChave) return null;
    if (rotulo === "Empresa") valorChave = normalizeCnpj(valorChave);

    let destino = await findContatoPorEmail(tabelaDestino.id, campoChaveDestino, valorChave);
    if (!destino) {
        destino = await createContato(tabelaDestino.id, registroOrigem.title, montarCamposValidos([
            { field_id: tabelaDestino.campoNome, field_value: registroOrigem.title },
            { field_id: campoChaveDestino, field_value: valorChave }
        ]));
    }
    return [destino.id];
}

async function gravarTransferencia(cardOrigemId, cardDestinoId) {
    const { sequelize } = require("../database");
    const { QueryTypes } = require("sequelize");
    await sequelize.query(
        `INSERT INTO bmax_pipefy_transferencias (card_origem, card_destino) VALUES (:origem, :destino)
         ON CONFLICT (card_origem) DO UPDATE SET card_destino = :destino`,
        { replacements: { origem: cardOrigemId, destino: cardDestinoId }, type: QueryTypes.INSERT }
    );
}

async function transferirCardParaIndustria(cardOrigemId, nomePipeOrigem, destino) {
    const configOrigem = configDoPipe(nomePipeOrigem);
    const configDestino = configDoPipe(destino.nomePipe);
    const pipeDestinoId = exigirConfig(configDestino.id, `o ID do pipe "${destino.nomePipe}" (pipes.${destino.nomePipe}.id)`);
    const faseDestinoId = exigirConfig(configDestino.fases[destino.nomeFase], `a fase "${destino.nomeFase}" (pipes.${destino.nomePipe}.fases)`);
    // "Título" é opcional (não existe no CRM BOXER SOLDAS — ver createLeadPipefy).
    const campoTituloDestino = configDestino.campos["Título"];
    const campoPciDestino = exigirConfig(configDestino.campos["PCI"], `o ID do campo PCI (pipes.${destino.nomePipe}.campos)`);

    const cardOrigem = await getCard(cardOrigemId);
    if (!cardOrigem) throw new Error(`transferirCardParaIndustria: card de origem "${cardOrigemId}" não encontrado no Pipefy`);

    const valorPorCampoId = {};
    const idsConectadosPorCampoId = {};
    for (const f of cardOrigem.fields || []) {
        valorPorCampoId[f.field.id] = f.value;
        const ids = idsConectadosPorCampo(f);
        if (ids.length) idsConectadosPorCampoId[f.field.id] = ids;
    }

    const camposNovoCard = [];
    if (campoTituloDestino) camposNovoCard.push({ field_id: campoTituloDestino, field_value: cardOrigem.title });
    const camposConectorSemId = [];

    for (const rotulo of CAMPOS_TRANSFERENCIA) {
        const campoOrigemId = configOrigem.campos[rotulo];
        const campoDestinoId = configDestino.campos[rotulo];
        if (!campoOrigemId || !campoDestinoId) continue;

        if (CAMPOS_CONECTOR.includes(rotulo)) {
            const idsOrigem = idsConectadosPorCampoId[campoOrigemId];
            if (!idsOrigem || !idsOrigem.length) {
                camposConectorSemId.push(rotulo);
                continue;
            }
            let ids;
            try {
                ids = await idsConectorNaBaseDoDestino(rotulo, idsOrigem, nomePipeOrigem, destino.nomePipe);
            } catch (e) {
                logger.warn({ message: "transferirCardParaIndustria: falha ao resolver conector na database do destino", rotulo, erro: e.message, cardOrigemId });
                ids = null;
            }
            if (!ids || !ids.length) {
                camposConectorSemId.push(rotulo);
                continue;
            }
            camposNovoCard.push({ field_id: campoDestinoId, field_value: ids });
            continue;
        }

        const valor = valorPorCampoId[campoOrigemId];
        if (valor === undefined || valor === null || valor === "") continue;
        // "Revenda/Loja" pode ter grafia diferente por pipe (confirmado no CRM
        // BOXER SOLDAS, ver pciParaPipefy/revendaParaPipefy) — origem (BMAX)
        // sempre grava na grafia formal, sem alias.
        const valorTraduzido = rotulo === "Revenda/Loja" ? revendaParaPipefy(destino.nomePipe, valor) : valor;
        camposNovoCard.push({ field_id: campoDestinoId, field_value: valorTraduzido });
    }

    // PCI é obrigatório no INDÚSTRIA - INTERNO — "Sem PCI" se a origem não tiver.
    // Origem (BMAX) sempre grava na grafia formal (PIPEFY_PCI_OPCOES, sem
    // alias) — pciParaPipefy traduz pro destino só quando o destino precisar
    // (hoje só CRM BOXER SOLDAS; demais pipes ficam como identidade).
    const campoPciOrigem = configOrigem.campos["PCI"];
    const pciOrigem = campoPciOrigem ? valorPorCampoId[campoPciOrigem] : null;
    camposNovoCard.push({ field_id: campoPciDestino, field_value: pciParaPipefy(destino.nomePipe, pciOrigem || "Sem PCI") });

    // Valor total e Data de criação no RD voltam do Pipefy em formato BR
    // (confirmado na conta real, 26/10/2026, testes manuais do 3º adendo) —
    // convertidos aqui antes de gravar no card novo, senão o painel (que
    // espera número puro/AAAA-MM-DD) os leria errado.
    const campoValorOrigem = configOrigem.campos["Valor total"];
    const campoValorDestino = configDestino.campos["Valor total"];
    if (campoValorOrigem && campoValorDestino && valorPorCampoId[campoValorOrigem]) {
        camposNovoCard.push({ field_id: campoValorDestino, field_value: String(parseValorMonetario(valorPorCampoId[campoValorOrigem])) });
    }

    const campoDataDestino = configDestino.campos["Data de criação no RD"];
    if (campoDataDestino) {
        const campoDataOrigem = configOrigem.campos["Data de criação no RD"];
        const dataBruta = campoDataOrigem ? valorPorCampoId[campoDataOrigem] : null;
        // Sem "Data de criação no RD" na origem (card nascido no Pipefy): usa
        // o created_at do próprio card de origem (a data que o painel usaria
        // de qualquer forma), só a parte da data.
        const dataIso = paraDataIso(dataBruta) || (cardOrigem.created_at ? cardOrigem.created_at.slice(0, 10) : null);
        if (dataIso) camposNovoCard.push({ field_id: campoDataDestino, field_value: dataIso.slice(0, 10) });
    }

    // Se a criação do card novo falhar, nada mais acontece — nem o card de
    // origem é movido, nem a ligação é gravada (decisão explícita do 3º
    // adendo) — o erro sobe direto, sem tratamento aqui.
    const cardNovo = await createCard(pipeDestinoId, faseDestinoId, cardOrigem.title, montarCamposValidos(camposNovoCard));

    if (camposConectorSemId.length) {
        logger.warn({ message: "transferirCardParaIndustria: campo(s) de conexão sem ID conectado no card de origem — não copiados pro card novo", campos: camposConectorSemId, cardOrigemId, cardNovoId: cardNovo.id });
    }

    // Daqui pra baixo, cada etapa tem sua própria falha só registrada em log
    // com os dois IDs, pra correção à mão — o card novo já existe, que é a
    // parte que importa.
    try {
        await createComment(cardOrigemId, `Transferido para o card ${cardNovo.id} do ${destino.nomePipe}`);
    } catch (e) {
        logger.error({ message: "transferirCardParaIndustria: falha ao comentar no card de origem", cardOrigemId, cardNovoId: cardNovo.id, error: e.message });
    }
    try {
        await createComment(cardNovo.id, `Transferido do card ${cardOrigemId} do BMAX`);
    } catch (e) {
        logger.error({ message: "transferirCardParaIndustria: falha ao comentar no card novo", cardOrigemId, cardNovoId: cardNovo.id, error: e.message });
    }
    try {
        // Responsável: o mesmo do card de origem — updateLeadPipefy (quem
        // chama esta função) aplica depois um owner_id diferente por cima,
        // se o body pedir.
        const assigneeIds = (cardOrigem.assignees || []).map(a => a.id).filter(Boolean);
        if (assigneeIds.length) await updateCardAssignees(cardNovo.id, assigneeIds);
    } catch (e) {
        logger.error({ message: "transferirCardParaIndustria: falha ao copiar o responsável pro card novo", cardOrigemId, cardNovoId: cardNovo.id, error: e.message });
    }
    try {
        const faseTransferidaId = exigirConfig(configOrigem.fases[FASE_ORIGEM_TRANSFERIDA], `a fase "${FASE_ORIGEM_TRANSFERIDA}" (pipes.${nomePipeOrigem}.fases)`);
        await moveCardToPhase(cardOrigemId, faseTransferidaId);
    } catch (e) {
        logger.error({ message: "transferirCardParaIndustria: falha ao mover o card de origem pra 'Transferido para a Indústria'", cardOrigemId, cardNovoId: cardNovo.id, error: e.message });
    }
    try {
        await gravarTransferencia(cardOrigemId, cardNovo.id);
    } catch (e) {
        logger.error({ message: "transferirCardParaIndustria: falha ao gravar a ligação em bmax_pipefy_transferencias", cardOrigemId, cardNovoId: cardNovo.id, error: e.message });
    }

    await atualizarCardNoCache(cardOrigemId);
    await atualizarCardNoCache(cardNovo.id);

    return cardNovo.id;
}

async function updateLeadPipefy(id, body) {
    // A1 (2º adendo, 23/10/2026): id recebido pode ser um ID do RD (vindo de
    // tabelas do BMAX como bmax_pci12_tracking/bmax_pci12a_prazo) — sem
    // resolver aqui, o Pipefy recebia o ID do RD direto e a chamada falhava.
    const cardId = await resolverCardId(id);
    // A3: etapa/campos têm que ser traduzidos pela tabela do pipe DO CARD,
    // não sempre BMAX — um card do INDÚSTRIA - INTERNO usa fases/campos
    // diferentes.
    const nomePipe = await nomePipeDoCard(cardId);
    const configPipe = configDoPipe(nomePipe);

    // Resolve a fase ANTES de qualquer gravação: uma etapa do RD sem fase
    // correspondente no pipe do card lança erro e não grava nada (nem o
    // responsável, nem os campos) — mudança deliberada (2º adendo, Tarefa
    // A3): antes só avisava em log e seguia gravando o resto, o que mascarava
    // o problema. Caso conhecido que passa a falhar alto aqui: aplicarCaminhoVenda
    // usa a etapa "Negociação" (caminho BOX+REV>IND), que no RD vive no
    // pipeline Indústria-Interno — um card do pipe BMAX do Pipefy não tem
    // fase equivalente (bloqueio de estrutura real, não um bug: a API do
    // Pipefy não tem mutation pra mover um card pra outro pipe; ver
    // moveCardToPhase). Resolver isso de fato depende de uma decisão de quem
    // desenha a estrutura no Pipefy.
    let faseId = null;
    if (body?.data?.stage_id) {
        const nomeFase = faseParaEtapaRdReversa(nomePipe, body.data.stage_id);
        faseId = nomeFase && configPipe.fases[nomeFase];
        if (!faseId) {
            // Tarefa B1 (3º adendo, 26/10/2026): a etapa pode não existir
            // neste pipe mas existir em OUTRO (hoje, só "Negociação" do
            // caminho BOX+REV>IND, que no BMAX não tem fase correspondente,
            // só no INDÚSTRIA - INTERNO) — nesse caso, transfere o card em
            // vez de lançar erro. O resto do body (campos/responsável) é
            // aplicado no card NOVO, não no de origem.
            const destino = DESTINO_TRANSFERENCIA_POR_ETAPA[nomePipe]?.[body.data.stage_id];
            if (destino) {
                const cardNovoId = await transferirCardParaIndustria(cardId, nomePipe, destino);
                try {
                    await updateLeadPipefy(cardNovoId, { ...body, data: { ...body.data, stage_id: undefined } });
                } catch (e) {
                    logger.error({ message: "updateLeadPipefy: falha ao aplicar o restante do body no card novo após a transferência", cardOrigemId: cardId, cardNovoId, error: e.message });
                }
                return { id: cardNovoId };
            }
            const nomeEtapa = RD_STAGES[body.data.stage_id] || body.data.stage_id;
            throw new Error(`updateLeadPipefy: etapa do RD "${nomeEtapa}" sem fase correspondente no pipe "${nomePipe}" do Pipefy — nada foi gravado`);
        }
    }

    if (body?.data?.owner_id) {
        try {
            const assigneeId = await resolverAssigneeId(body.data.owner_id);
            if (assigneeId) {
                await updateCardAssignees(cardId, [assigneeId]);
            } else {
                logger.warn({ message: "updateLeadPipefy: responsável sem membro correspondente no Pipefy — atribuição ignorada", cardId, owner: body.data.owner_id });
            }
        } catch (e) {
            logger.error({ message: "updateLeadPipefy: falha ao atribuir responsável", cardId, error: e.message });
        }
    }

    if (faseId) {
        await moveCardToPhase(cardId, faseId);
    }

    const pares = [];

    if (body?.data?.custom_fields) {
        for (const [slug, valor] of Object.entries(body.data.custom_fields)) {
            const rotuloPipefy = CAMPO_PIPEFY_POR_SLUG[slug];
            const campoId = rotuloPipefy && configPipe.campos[rotuloPipefy];
            if (!campoId) continue;
            if (slug === "perfil-pci") validarPci(valor);
            pares.push({ campoId, valor: typeof valor === "string" ? valor.trim() : valor });
        }
    }

    // amount_total vai no mesmo lote que os demais campos — campo "Valor
    // total" (Tarefa 6; sem equivalente confirmado no guia além deste, ver
    // conversão em parseValorMonetario pro sentido inverso de leitura).
    if (body?.data?.amount_total !== undefined && configPipe.campos["Valor total"]) {
        pares.push({ campoId: configPipe.campos["Valor total"], valor: String(body.data.amount_total) });
    }

    const paresValidos = pares.filter(({ valor }) => valor !== null && valor !== undefined && valor !== "");
    if (paresValidos.length) {
        await updateCardFieldsEmLote(cardId, paresValidos);
    }

    await atualizarCardNoCache(cardId);
    return { id: cardId };
}

// Tarefa/nota como comentário no card — o Pipefy não tem um conceito nativo
// de tarefa/atividade separado de comentário (guia não cobre isso). Grava
// também os campos "Próxima ação"/"Data da próxima ação" (existem no mapa
// BMAX), que são os únicos equivalentes a "o que fazer e quando" que
// sobrevivem fora do texto livre do comentário.
function textoTarefa(taskData) {
    const tipo = taskData.type || "task";
    const prazo = taskData.date || "sem prazo";
    const responsavel = nomeDoOwnerRd(taskData.owner_id || taskData.user_id) || "não informado";
    const assunto = taskData.name || taskData.subject || "";
    const notas = taskData.notes ? `\n${taskData.notes}` : "";
    return `[Tarefa · ${tipo} · prazo ${prazo} · responsável ${responsavel}]\n${assunto}${notas}`;
}

async function createTaskPipefy(taskData) {
    // A1: taskData.deal_id pode ser um ID do RD (bmax_pci12_tracking etc.).
    const cardId = await resolverCardId(taskData.deal_id);
    // A3: campos de "próxima ação" têm que ser os do pipe DO CARD.
    const configPipe = configDoPipe(await nomePipeDoCard(cardId));

    await createComment(cardId, textoTarefa(taskData));

    const pares = [];
    if (configPipe.campos["Próxima ação"]) pares.push({ campoId: configPipe.campos["Próxima ação"], valor: taskData.name || taskData.subject || "" });
    if (configPipe.campos["Data da próxima ação"] && taskData.date) pares.push({ campoId: configPipe.campos["Data da próxima ação"], valor: taskData.date });
    const paresValidos = pares.filter(({ valor }) => valor);
    if (paresValidos.length) await updateCardFieldsEmLote(cardId, paresValidos);

    return { skipped: false };
}

async function updateTaskPipefy(taskData, id) {
    const cardId = await resolverCardId(id); // A1
    const configPipe = configDoPipe(await nomePipeDoCard(cardId)); // A3

    const pares = [];
    if (configPipe.campos["Próxima ação"] && (taskData.subject || taskData.name)) {
        pares.push({ campoId: configPipe.campos["Próxima ação"], valor: taskData.subject || taskData.name });
    }
    if (configPipe.campos["Data da próxima ação"] && taskData.date) {
        pares.push({ campoId: configPipe.campos["Data da próxima ação"], valor: taskData.date });
    }
    if (pares.length) await updateCardFieldsEmLote(cardId, pares);
    return { id: cardId };
}

async function createNotePipefy(dealId, text) {
    const cardId = await resolverCardId(dealId); // A1
    return await createComment(cardId, text);
}

// Formato de retorno compatível com formatarHistoricoNotas
// (caminhoVenda.service.js), que já lê tanto `{annotations:[...]}` (RD V1)
// quanto `{data:[...]}` com cada item tendo `.text`/`.created_at` — exatamente
// a forma de um comentário do Pipefy, sem precisar mudar nada lá.
async function getLeadNotesPipefy(dealId) {
    const cardId = await resolverCardId(dealId); // A1
    const comments = await getCardComments(cardId);
    return { data: comments };
}

// Rename/reatribuição de representante/revenda no Pipefy (Tarefa 9,
// bmax_pipefy_correcoes_adendo.md, 19/10/2026) — equivalente a
// renomearRepresentanteNoRD/renomearRevendaNoRD/
// reatribuirRepresentanteDaRevendaNoRD (rd.leads.service.js), que varrem o
// RD inteiro reescrevendo um picklist estrito. No Pipefy, por pipe: (1)
// acrescenta a opção nova no campo de seleção se ainda não existir
// (updatePhaseField — "(conferir)", exige o uuid do campo, achado real do
// usuário na conta real); (2) acha os cards com o valor antigo
// (findCardsByFieldValue); (3) atualiza todos de uma vez
// (updateFieldEmVariosCards). NÃO tira a opção antiga do campo — decisão
// conservadora (o adendo diz "se for o caso"; fica como ação manual
// posterior, se necessário).
async function acrescentarOpcaoSeFaltar(nomePipe, rotuloCampo, valorNovo) {
    const configPipe = nomePipe === "BMAX"
        ? { id: PIPEFY_PIPE_BMAX, campos: PIPEFY_CAMPOS }
        : pipeConfig(nomePipe);
    const campoId = configPipe.campos[rotuloCampo];
    if (!campoId) return;

    const campos = await getStartFormFields(configPipe.id);
    const campo = campos.find(c => c.id === campoId);
    if (!campo) {
        logger.warn({ message: "acrescentarOpcaoSeFaltar: campo não encontrado no formulário inicial do pipe — opção não verificada/acrescentada", nomePipe, rotuloCampo });
        return;
    }
    const opcoesAtuais = campo.options || [];
    if (opcoesAtuais.includes(valorNovo)) return;

    await updatePhaseField(campo.id, campo.uuid, campo.label, [...opcoesAtuais, valorNovo]);
}

async function varrerEAtualizarCampoNoPipefy(nomesPipe, { campoBusca, valorBusca, campoGrava, valorGrava }, { dryRun = false } = {}) {
    let total = 0, updated = 0, failed = 0;

    for (const nomePipe of nomesPipe) {
        const configPipe = nomePipe === "BMAX"
            ? { id: PIPEFY_PIPE_BMAX, campos: PIPEFY_CAMPOS }
            : pipeConfig(nomePipe);
        const pipeId = exigirConfig(configPipe.id, `o ID do pipe "${nomePipe}" (pipes.${nomePipe}.id)`);
        const campoBuscaId = exigirConfig(configPipe.campos[campoBusca], `o ID do campo "${campoBusca}" (pipes.${nomePipe}.campos)`);
        const campoGravaId = exigirConfig(configPipe.campos[campoGrava], `o ID do campo "${campoGrava}" (pipes.${nomePipe}.campos)`);

        if (!dryRun) await acrescentarOpcaoSeFaltar(nomePipe, campoGrava, valorGrava);

        const cards = await findCardsByFieldValue(pipeId, campoBuscaId, valorBusca);
        total += cards.length;
        if (dryRun || !cards.length) continue;

        try {
            // Tarefa B1 (2º adendo): updateFieldEmVariosCards agora divide em
            // lotes e já devolve quantos atualizaram/falharam — não supõe mais
            // sucesso total só porque a chamada não lançou.
            const resultado = await updateFieldEmVariosCards(campoGravaId, valorGrava, cards.map(c => c.id));
            updated += resultado.atualizados;
            failed += resultado.falharam;
        } catch (e) {
            failed += cards.length;
            logger.error({ message: "Erro ao atualizar cards no Pipefy", nomePipe, campoGrava, error: e.message });
        }
    }

    // Só força incremental nos pipes que JÁ estão com cache aquecido (Tarefa
    // A5, 2º adendo 23/10/2026) — um pipe nunca lido não precisa de pressa, a
    // próxima leitura normal já começa do zero sozinha; forçar aqui só
    // gastaria uma leitura completa à toa.
    for (const nomePipe of nomesPipe) {
        if (_cachePorPipe[nomePipe]) {
            await obterCardsDoPipe(nomePipe, { forcarIncremental: true }).catch(e =>
                logger.warn({ message: "varrerEAtualizarCampoNoPipefy: falha ao atualizar cache depois da varredura", nomePipe, error: e.message })
            );
        }
    }
    return { done: true, total, updated, failed, ...(dryRun ? { dryRun: true } : {}) };
}

async function renomearRepresentanteNoPipefy(nomeAntigo, nomeNovo, opts = {}) {
    return varrerEAtualizarCampoNoPipefy(
        ["BMAX"],
        { campoBusca: "Representante", valorBusca: nomeAntigo, campoGrava: "Representante", valorGrava: nomeNovo },
        opts
    );
}

async function renomearRevendaNoPipefy(nomeAntigo, nomeNovo, opts = {}) {
    return varrerEAtualizarCampoNoPipefy(
        ["BMAX", "REVENDA - INTERNO"],
        { campoBusca: "Revenda/Loja", valorBusca: nomeAntigo, campoGrava: "Revenda/Loja", valorGrava: nomeNovo },
        opts
    );
}

async function reatribuirRepresentanteDaRevendaNoPipefy(revendaNome, novoRep, opts = {}) {
    // Mesmo cuidado de nome RD vs. cadastro que reatribuirRepresentanteDaRevendaNoRD
    // já faz (rd.leads.service.js:536-548).
    const { usernameToRd } = await getAliasMapsLazy();
    const repNoRd = novoRep ? (usernameToRd[novoRep] || novoRep) : novoRep;
    return varrerEAtualizarCampoNoPipefy(
        ["BMAX", "REVENDA - INTERNO"],
        { campoBusca: "Revenda/Loja", valorBusca: revendaNome, campoGrava: "Representante", valorGrava: repNoRd || "N/D" },
        opts
    );
}

// Sincronismo de picklist (Fase 6, 19/11/2026) — equivalente a
// syncRevendasToRD/syncRepresentantesToRD (rd.leads.service.js), que unem a
// lista de nomes ativos do Supabase com as opções que já existem no
// picklist do RD (nunca apagam nada). No Pipefy, mesma operação de
// acrescentarOpcaoSeFaltar (acima), só que com VÁRIAS opções de uma vez —
// uma leitura (getStartFormFields) + uma escrita (updatePhaseField, que
// SUBSTITUI a lista inteira, confirmado ao vivo 26/10/2026) por pipe, em
// vez de uma chamada por nome.
//
// Mesmo cuidado de dedupeCaseInsensitive do lado RD
// (rd.leads.service.js:655) — une sem derrubar uma grafia já existente no
// Pipefy por causa de maiúscula/minúscula ou espaço nas pontas vindos do
// Supabase, sempre preferindo a grafia que já existe de verdade no pipe.
function dedupeCaseInsensitive(existentes, novos) {
    const vistos = new Map();
    for (const o of existentes) vistos.set(o.trim().toLowerCase(), o);
    for (const n of novos) {
        const chave = n.trim().toLowerCase();
        if (!vistos.has(chave)) vistos.set(chave, n);
    }
    return [...vistos.values()];
}

async function sincronizarOpcoesCampoNoPipefy(nomesPipe, rotuloCampo, valoresNovos, { traduzirValor } = {}) {
    const porPipe = [];
    for (const nomePipe of nomesPipe) {
        const configPipe = configDoPipe(nomePipe);
        const campoId = configPipe.campos[rotuloCampo];
        if (!campoId) {
            logger.warn({ message: "sincronizarOpcoesCampoNoPipefy: pipe não tem esse campo configurado", nomePipe, rotuloCampo });
            porPipe.push({ nomePipe, skipped: true });
            continue;
        }

        const campos = await getStartFormFields(configPipe.id);
        const campo = campos.find(c => c.id === campoId);
        if (!campo) {
            logger.warn({ message: "sincronizarOpcoesCampoNoPipefy: campo não encontrado no formulário inicial do pipe", nomePipe, rotuloCampo });
            porPipe.push({ nomePipe, skipped: true });
            continue;
        }

        const existentes = campo.options || [];
        const novosTraduzidos = valoresNovos
            .filter(n => n && n.trim())
            .map(n => traduzirValor ? traduzirValor(nomePipe, n) : n);
        const unique = dedupeCaseInsensitive(existentes, novosTraduzidos);

        if (unique.length !== existentes.length) {
            await updatePhaseField(campo.id, campo.uuid, campo.label, unique);
        }
        porPipe.push({ nomePipe, synced: unique.length, adicionados: unique.length - existentes.length, fieldId: campo.id });
    }
    return { done: true, porPipe };
}

// CRM BOXER SOLDAS é o pipe centralizado de leads (Fase 5) — entra no sync
// de Representante/Revenda-Loja, além dos pipes que as 3 rotinas de rename
// acima já cobrem (decisão do usuário, 19/11/2026: estender as 3 rotinas de
// rename pra esse pipe também fica como ponto em aberto à parte, não faz
// parte desta sincronização).
async function syncRepresentantesToPipefy(repNomes) {
    return sincronizarOpcoesCampoNoPipefy(
        ["BMAX", "CRM BOXER SOLDAS"],
        "Representante",
        [...repNomes, "N/D"]
    );
}

async function syncRevendasToPipefy(revendaNomes) {
    return sincronizarOpcoesCampoNoPipefy(
        ["BMAX", "REVENDA - INTERNO", "CRM BOXER SOLDAS"],
        "Revenda/Loja",
        [...revendaNomes, "Sem Revenda"],
        { traduzirValor: revendaParaPipefy }
    );
}

module.exports = {
    fetchAllDealsPipefy,
    createLeadPipefy,
    updateLeadPipefy,
    getLeadByCnpjPipefy,
    createTaskPipefy,
    updateTaskPipefy,
    createNotePipefy,
    getLeadNotesPipefy,
    getDealByIdPipefy,
    resolverCardId,
    invalidarCachePipefy,
    renomearRepresentanteNoPipefy,
    renomearRevendaNoPipefy,
    reatribuirRepresentanteDaRevendaNoPipefy,
    syncRepresentantesToPipefy,
    syncRevendasToPipefy,
    getContatoPrincipalPipefy,
    fetchAllCardsConsultaLeadPipefy,
    // Exportadas só pro script de conferência (scripts/conferir-pipefy.js,
    // Tarefa C1 do 3º adendo) — não usadas por nenhum outro módulo.
    cardParaDealFake,
    paraDataIso,
    parseValorMonetario
};
