// Cliente de baixo nível pra API GraphQL do Pipefy — ver guia_bmax_pipefy.md
// (raiz do repo) seção 5. Cada função aqui espelha um exemplo do guia; as
// marcadas (conferir) não foram testadas na conta real da Boxer e devem ser
// validadas contra a referência (https://api-docs.pipefy.com) antes do uso
// em produção. Desativado por padrão — só é chamado quando CRM_PROVIDER=pipefy
// (ver rd.leads.service.js).
const { logger } = require("../logger");

const PIPEFY_URL = "https://api.pipefy.com/graphql";
const MAX_PAGINAS = 200; // teto de segurança contra paginação inconsistente da API, mesma ideia do RD_MAX_PAGES

// Contador de chamadas por dia, só em memória (reseta a cada cold start da
// função serverless — não é um substituto de métrica de verdade, só dá pra
// acompanhar consumo dentro de uma instância viva). O limite real (10 mil
// chamadas/mês pra empresa inteira, guia seção 3) precisa ser acompanhado
// no painel do Pipefy; isso aqui é só um log de apoio pra primeira semana.
let _chamadasHoje = { dia: null, total: 0 };
function contarChamadaPipefy() {
    const hoje = new Date().toISOString().slice(0, 10);
    if (_chamadasHoje.dia !== hoje) _chamadasHoje = { dia: hoje, total: 0 };
    _chamadasHoje.total++;
    // Tarefa C2 (2º adendo, 23/10/2026): toda chamada em debug (não polui o
    // log padrão, nível "info"); só a 1ª do dia e a cada 50 chamadas sobem
    // pra info, suficiente pra acompanhar o consumo sem logar cada uma.
    const primeiraDoDia = _chamadasHoje.total === 1;
    const marco = _chamadasHoje.total % 50 === 0;
    const nivel = primeiraDoDia || marco ? "info" : "debug";
    logger[nivel]({ message: "Chamada ao Pipefy", dia: hoje, totalHoje: _chamadasHoje.total });
}

async function pipefyFetch(query, variables = {}) {
    const token = process.env.PIPEFY_TOKEN;
    if (!token) throw new Error("PIPEFY_TOKEN não configurada");

    contarChamadaPipefy();

    const res = await fetch(PIPEFY_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ query, variables })
    });

    if (res.status === 429) {
        throw new Error("Limite de chamadas do Pipefy atingido (429); tentar mais tarde");
    }

    const corpo = await res.json();

    if (!res.ok) {
        logger.error({ message: "Erro na resposta do Pipefy", status: res.status, body: corpo });
        throw new Error(`Erro Pipefy ${res.status}: ${JSON.stringify(corpo)}`);
    }

    if (corpo.errors?.length) {
        throw new Error(corpo.errors.map(e => e.message).join("; "));
    }

    return corpo.data;
}

// Guia 5.1 (conferir) — acha card(s) por um valor exato de campo. Usada por
// findCardByRdId (achar UM card pelo "ID no RD CRM") e, desde a Tarefa 9
// (bmax_pipefy_correcoes_adendo.md, 19/10/2026), pelas rotinas de
// renomear/reatribuir representante/revenda (achar TODOS os cards com o
// valor antigo num campo de seleção). Pagina do mesmo jeito que
// allCardsInPipe — não confirmado se `findCards` aceita `first`/`after` na
// prática. Se o Pipefy recusar esses argumentos (Tarefa B2, 2º adendo
// 23/10/2026), repete numa única chamada sem paginação (uma página só) em
// vez de quebrar a busca por ID do RD/as varreduras de renomear.
async function findCardsByFieldValue(pipeId, campoId, valor) {
    try {
        return await findCardsByFieldValuePaginado(pipeId, campoId, valor);
    } catch (e) {
        if (/\bfirst\b|\bafter\b/i.test(e.message)) {
            logger.warn({ message: "findCardsByFieldValue: Pipefy não aceita first/after — repetindo sem paginação (só 1 página)", pipeId, error: e.message });
            return await findCardsByFieldValueSemPaginacao(pipeId, campoId, valor);
        }
        throw e;
    }
}

async function findCardsByFieldValuePaginado(pipeId, campoId, valor) {
    const QUERY = `
        query($pipeId: ID!, $campo: String!, $valor: String!, $cursor: String) {
            findCards(pipeId: $pipeId, search: { fieldId: $campo, fieldValue: $valor }, first: 50, after: $cursor) {
                edges { node { id title current_phase { name } } }
                pageInfo { hasNextPage endCursor }
            }
        }`;
    let cards = [];
    let cursor = null;
    let hasNext = true;
    let paginas = 0;
    while (hasNext && paginas < MAX_PAGINAS) {
        const dados = await pipefyFetch(QUERY, { pipeId, campo: campoId, valor: String(valor), cursor });
        const pagina = dados.findCards;
        cards = cards.concat(pagina.edges.map(e => e.node));
        hasNext = pagina.pageInfo.hasNextPage;
        cursor = pagina.pageInfo.endCursor;
        paginas++;
    }
    return cards;
}

async function findCardsByFieldValueSemPaginacao(pipeId, campoId, valor) {
    const QUERY = `
        query($pipeId: ID!, $campo: String!, $valor: String!) {
            findCards(pipeId: $pipeId, search: { fieldId: $campo, fieldValue: $valor }) {
                edges { node { id title current_phase { name } } }
            }
        }`;
    const dados = await pipefyFetch(QUERY, { pipeId, campo: campoId, valor: String(valor) });
    return dados.findCards.edges.map(e => e.node);
}

async function findCardByRdId(pipeId, campoId, rdDealId) {
    const cards = await findCardsByFieldValue(pipeId, campoId, rdDealId);
    return cards[0] || null;
}

// Guia 5.2 — lê o card inteiro (fase atual + todos os campos). `created_at`/
// `updated_at` (nome confirmado na conta real, 20/10/2026 —
// bmax_pipefy_correcoes_adendo.md: é `created_at`, NÃO `createdAt` como o
// documento original dizia), `assignees` e `pipe` (conferir — não estão no
// guia) alimentam `created_at`/`user` em cardParaDealFake e a identificação
// de qual pipe um card pertence em atualizarCardNoCache (ambos em
// pipefyLeads.service.js), já que o card em si não tem um campo de
// "valor"/"responsável" nativo equivalente ao do RD.
// `array_value`/`connectedRepoItems` (Tarefa B1-fix, 3º adendo, 26/10/2026):
// confirmado na conta real que, num campo de CONEXÃO (ex.: "Contato",
// "Empresa"), `value` traz os TÍTULOS dos registros conectados (ex.:
// '["Nome do contato"]'), não os IDs — gravar isso de volta num field_value
// faz o Pipefy ignorar a conexão em silêncio, sem erro algum (achado real,
// transferirCardParaIndustria em pipefyLeads.service.js nascia sem
// Contato/Empresa). `array_value` e `connectedRepoItems[].id` trazem o(s)
// ID(s) de verdade (confirmados iguais na conta real) — `__typename`
// confirmado como `PublicTableRecord` pra registro de database; `PublicCard`
// fica como fragmento defensivo pra uma eventual conexão card-a-card (não
// testado, nenhum campo usado hoje conecta cards entre si).
async function getCard(cardId) {
    const QUERY = `
        query($id: ID!) {
            card(id: $id) {
                id
                title
                created_at
                updated_at
                pipe { id name }
                current_phase { id name }
                fields {
                    field { id }
                    name
                    value
                    array_value
                    connectedRepoItems {
                        __typename
                        ... on PublicTableRecord { id }
                        ... on PublicCard { id }
                    }
                }
                assignees { id name email }
            }
        }`;
    const dados = await pipefyFetch(QUERY, { id: cardId });
    return dados.card;
}

// Guia 5.3 — grava um único campo (testado na conta).
async function updateCardField(cardId, campoId, valor) {
    const MUTATION = `
        mutation($card: ID!, $campo: ID!, $valor: [UndefinedInput]) {
            updateCardField(input: { card_id: $card, field_id: $campo, new_value: $valor }) { success }
        }`;
    return await pipefyFetch(MUTATION, { card: cardId, campo: campoId, valor });
}

// Move o card pra outra fase — mutation separada de updateCardField (ver
// guia seção 1, link "Mover card para outra fase").
async function moveCardToPhase(cardId, faseId) {
    const MUTATION = `
        mutation($card: ID!, $fase: ID!) {
            moveCardToPhase(input: { card_id: $card, destination_phase_id: $fase }) {
                card { id current_phase { id name } }
            }
        }`;
    return await pipefyFetch(MUTATION, { card: cardId, fase: faseId });
}

// (conferir) — não está no guia nem foi testado na conta. Troca o(s)
// responsável(eis) por um card — equivalente ao `user_id`/owner do RD.
// Validar o nome exato da mutation/argumento contra a referência
// (https://api-docs.pipefy.com) antes de usar em produção.
async function updateCardAssignees(cardId, assigneeIds) {
    const MUTATION = `
        mutation($card: ID!, $assignees: [ID]!) {
            updateCard(input: { id: $card, assignee_ids: $assignees }) {
                card { id }
            }
        }`;
    return await pipefyFetch(MUTATION, { card: cardId, assignees: assigneeIds });
}

// Testado na conta real (revisão 15/10/2026, bmax_pipefy_correcoes.md) —
// comentário no card. Equivalente a tarefa/nota do RD (createTask/createNote
// em rd.leads.service.js), já que o Pipefy não tem um conceito nativo de
// tarefa/atividade separado de comentário.
async function createComment(cardId, texto) {
    const MUTATION = `
        mutation($card: ID!, $texto: String!) {
            createComment(input: { card_id: $card, text: $texto }) {
                comment { id text }
            }
        }`;
    const dados = await pipefyFetch(MUTATION, { card: cardId, texto });
    return dados.createComment.comment;
}

// (conferir) — não está no guia. Lê os comentários de um card, pra
// getLeadNotesPipefy devolver no formato que o Portal espera.
async function getCardComments(cardId) {
    const QUERY = `
        query($id: ID!) {
            card(id: $id) {
                comments { text created_at author { name } }
            }
        }`;
    const dados = await pipefyFetch(QUERY, { id: cardId });
    return dados.card?.comments || [];
}

// Erro de TRANSPORTE (limite de chamadas, instabilidade, HTTP != 2xx) — ver
// pipefyFetch. Bissectar não ajuda aqui: o problema não está em nenhum item
// específico do lote, e tentar de novo só multiplicaria chamadas à toa
// (orçamento mensal é compartilhado com a empresa inteira). Bissecção (ver
// executarMutationsComBisseccao, abaixo) é só pra isolar um erro de
// VALIDAÇÃO do Pipefy (ex.: "O campo X é obrigatório", valor fora das
// opções) misturado com itens válidos no mesmo lote — aprendizados-
// integracao-pipefy.md, seção 6.5 ("se o lote inteiro for recusado, divida
// ao meio e tente de novo, até isolar o item defeituoso").
function erroDeTransporte(mensagem) {
    return /^Limite de chamadas do Pipefy atingido|^Erro Pipefy \d+:/.test(mensagem || "");
}

// Executa um conjunto de mutations com apelido (`m0: ..., m1: ...`) numa
// única chamada; se o Pipefy recusar o lote inteiro por um erro de
// VALIDAÇÃO (não de transporte), divide os índices ao meio e tenta cada
// metade separadamente, recursivamente, até isolar o(s) índice(s) com
// problema — os itens válidos do lote não ficam reféns de um item ruim.
// `mutacoesPorIndice`: { [indice]: "m<indice>: mutation(...) { ... }" }.
async function executarMutationsComBisseccao(mutacoesPorIndice) {
    const indices = Object.keys(mutacoesPorIndice).map(Number);
    if (!indices.length) return { ok: [], falhas: {} };

    const MUTATION = `mutation { ${indices.map(i => mutacoesPorIndice[i]).join("\n")} }`;
    try {
        await pipefyFetch(MUTATION);
        return { ok: indices, falhas: {} };
    } catch (e) {
        if (indices.length === 1 || erroDeTransporte(e.message)) {
            const falhas = {};
            indices.forEach(i => { falhas[i] = e.message; });
            return { ok: [], falhas };
        }
        const meio = Math.floor(indices.length / 2);
        const primeiraMetade = {};
        const segundaMetade = {};
        indices.slice(0, meio).forEach(i => { primeiraMetade[i] = mutacoesPorIndice[i]; });
        indices.slice(meio).forEach(i => { segundaMetade[i] = mutacoesPorIndice[i]; });
        const r1 = await executarMutationsComBisseccao(primeiraMetade);
        const r2 = await executarMutationsComBisseccao(segundaMetade);
        return { ok: [...r1.ok, ...r2.ok], falhas: { ...r1.falhas, ...r2.falhas } };
    }
}

// Guia 5.7 (testado na conta) — várias gravações de campo num card só, numa
// única chamada (conta como 1 pro limite mensal, salvo bissecção acima), via
// aliases na mutation.
async function updateCardFieldsEmLote(cardId, pares) {
    if (!pares.length) return { success: true };
    const mutacoesPorIndice = {};
    pares.forEach(({ campoId, valor }, i) => {
        mutacoesPorIndice[i] = `m${i}: updateCardField(input: { card_id: "${cardId}", field_id: "${campoId}", new_value: ${JSON.stringify(valor)} }) { success }`;
    });
    const { falhas } = await executarMutationsComBisseccao(mutacoesPorIndice);
    const qtdFalhas = Object.keys(falhas).length;
    if (qtdFalhas) {
        logger.error({
            message: "updateCardFieldsEmLote: campo(s) recusado(s) isolado(s) por bissecção — os demais foram gravados normalmente",
            cardId,
            falhas: Object.entries(falhas).map(([i, erro]) => ({ campoId: pares[i].campoId, erro }))
        });
    }
    return { success: qtdFalhas === 0 };
}

// Guia 5.4 (testado na conta) — cria um registro no database de Contatos Comercial.
async function createContato(tabelaId, titulo, campos) {
    const MUTATION = `
        mutation($tabela: ID!, $titulo: String!, $campos: [FieldValueInput]) {
            createTableRecord(input: { table_id: $tabela, title: $titulo, fields_attributes: $campos }) {
                table_record { id }
            }
        }`;
    const dados = await pipefyFetch(MUTATION, { tabela: tabelaId, titulo, campos });
    return dados.createTableRecord.table_record;
}

// Guia 5.4 (testado na conta) — cria o card já na fase desejada, ligado ao contato.
// Etiquetas (labels) do pipe: { id, name }. Cache de 10 min — mudam raramente.
const _cacheEtiquetas = new Map();
async function getPipeLabels(pipeId) {
    const c = _cacheEtiquetas.get(String(pipeId));
    if (c && Date.now() - c.ts < 10 * 60 * 1000) return c.lista;
    const dados = await pipefyFetch(`query($id: ID!) { pipe(id: $id) { labels { id name } } }`, { id: pipeId });
    const lista = (dados.pipe && dados.pipe.labels) || [];
    _cacheEtiquetas.set(String(pipeId), { ts: Date.now(), lista });
    return lista;
}

async function createCard(pipeId, faseId, titulo, campos, labelIds = []) {
    const comEtiqueta = Array.isArray(labelIds) && labelIds.length > 0;
    const MUTATION = `
        mutation($pipe: ID!, $fase: ID!, $titulo: String!, $campos: [FieldValueInput]${comEtiqueta ? ", $labels: [ID]" : ""}) {
            createCard(input: { pipe_id: $pipe, phase_id: $fase, title: $titulo, fields_attributes: $campos${comEtiqueta ? ", label_ids: $labels" : ""} }) {
                card { id }
            }
        }`;
    const dados = await pipefyFetch(MUTATION, { pipe: pipeId, fase: faseId, titulo, campos, ...(comEtiqueta ? { labels: labelIds } : {}) });
    return dados.createCard.card;
}

// (conferir) — não está no guia. Lê um registro de database (Contato ou
// Empresa) pelo ID, com seus próprios campos — usado por
// transferirCardParaIndustria (pipefyLeads.service.js, achado real
// 18/11/2026) pra descobrir o e-mail do Contato de origem antes de
// achar/criar o equivalente na database do pipe de destino, quando os dois
// pipes usam databases diferentes (ex.: BMAX usa Contatos Comercial, CRM
// BOXER SOLDAS usa Contatos (RD)).
async function getTableRecord(recordId) {
    const QUERY = `
        query($id: ID!) {
            table_record(id: $id) { id title record_fields { field { id } name value } }
        }`;
    const dados = await pipefyFetch(QUERY, { id: recordId });
    return dados.table_record;
}

// Guia 5.5 — procura um contato pelo e-mail, pra não duplicar antes de criar
// um novo (guia seção 5.4: "Antes de criar o contato, procure-o pelo
// e-mail"). Testado na conta real (revisão 15/10/2026): findRecords exige
// `tableId: String!`, não `ID!` — erro real confirmado ("Type mismatch on
// variable $t and argument tableId (ID! / String!)").
async function findContatoPorEmail(tabelaId, campoId, email) {
    const QUERY = `
        query($tabela: String!, $campo: String!, $valor: String!) {
            findRecords(tableId: $tabela, search: { fieldId: $campo, fieldValue: $valor }) {
                edges { node { id title } }
            }
        }`;
    const dados = await pipefyFetch(QUERY, { tabela: tabelaId, campo: campoId, valor: email });
    return dados.findRecords.edges[0]?.node || null;
}

const CAMPOS_CARD_LISTAGEM = `
    id
    title
    created_at
    updated_at
    pipe { id name }
    current_phase { id name }
    labels { name }
    fields { field { id } name value }
    assignees { id name email }`;

// (conferir) — não está no guia. Pagina todos os cards de um pipe (query
// padrão da API do Pipefy, https://api-docs.pipefy.com) — é a base do
// dashboard de leads (equivalente a fetchAllDealsFromRD). Validar contra a
// conta real antes de confiar no formato de retorno.
async function allCardsInPipe(pipeId) {
    const QUERY = `
        query($pipeId: ID!, $cursor: String) {
            allCards(pipeId: $pipeId, first: 50, after: $cursor) {
                edges { node { ${CAMPOS_CARD_LISTAGEM} } }
                pageInfo { hasNextPage endCursor }
            }
        }`;

    let cards = [];
    let cursor = null;
    let hasNext = true;
    let paginas = 0;

    while (hasNext && paginas < MAX_PAGINAS) {
        const dados = await pipefyFetch(QUERY, { pipeId, cursor });
        const pagina = dados.allCards;
        cards = cards.concat(pagina.edges.map(e => e.node));
        hasNext = pagina.pageInfo.hasNextPage;
        cursor = pagina.pageInfo.endCursor;
        paginas++;
    }
    if (paginas >= MAX_PAGINAS) {
        logger.error({ message: "allCardsInPipe atingiu o teto de páginas — dados podem estar incompletos", pipeId, maxPaginas: MAX_PAGINAS });
    }
    return cards;
}

// Testado na conta real (20/10/2026, bmax_pipefy_correcoes_adendo.md) —
// leitura incremental: só cards alterados desde `desde` (string ISO 8601
// COM FUSO, ex. "2026-10-20T10:54:17+00:00" — é como o Pipefy devolve
// `updated_at`), pra não precisar reler o pipe inteiro a cada atualização do
// cache (ver pipefyLeads.service.js). Confirmado na conta: `allCards` só
// filtra por `updated_at` (nenhum campo personalizado — pra isso é
// `findCards`), e um comentário no card também atualiza `updated_at` (um
// card só comentado reaparece aqui — esperado, inofensivo). Operador `gt`
// (maior que), não `gte`: a referência que `pipefyLeads.service.js` passa é
// o maior `updated_at` já visto no cache, então um card com ESSE updated_at
// exato já está no cache — não precisa vir de novo (`gte` arriscaria uma
// paginação sempre reincluindo o mesmo último card a cada rodada).
async function allCardsAtualizadosDesde(pipeId, desde) {
    const QUERY = `
        query($pipeId: ID!, $cursor: String, $desde: String!) {
            allCards(pipeId: $pipeId, first: 50, after: $cursor, filter: { field: "updated_at", operator: gt, value: $desde }) {
                edges { node { ${CAMPOS_CARD_LISTAGEM} } }
                pageInfo { hasNextPage endCursor }
            }
        }`;

    let cards = [];
    let cursor = null;
    let hasNext = true;
    let paginas = 0;

    while (hasNext && paginas < MAX_PAGINAS) {
        const dados = await pipefyFetch(QUERY, { pipeId, cursor, desde });
        const pagina = dados.allCards;
        cards = cards.concat(pagina.edges.map(e => e.node));
        hasNext = pagina.pageInfo.hasNextPage;
        cursor = pagina.pageInfo.endCursor;
        paginas++;
    }
    return cards;
}

// (conferir) — não está no guia. Lê os campos do formulário inicial de um
// pipe (id + uuid + rótulo), necessário pra updatePhaseField (Tarefa 9): sem
// o uuid, o Pipefy recusa a gravação com "Acesso negado" (testado na conta
// real pelo usuário, ver bmax_pipefy_correcoes_adendo.md).
async function getStartFormFields(pipeId) {
    const QUERY = `
        query($id: ID!) {
            pipe(id: $id) { start_form_fields { id uuid label type required options } }
        }`;
    const dados = await pipefyFetch(QUERY, { id: pipeId });
    return dados.pipe?.start_form_fields || [];
}

// (conferir) — renomeia ou acrescenta opção num campo de seleção (picklist)
// do formulário inicial de um pipe. `uuid` obrigatório (achado real do
// usuário na conta, ver getStartFormFields acima); a doc pública confirma
// `id`/`uuid`/`label`, mas não confirma `options` pra alterar a lista de
// valores de um campo de seleção — usar com cautela (Tarefa 9).
async function updatePhaseField(fieldId, fieldUuid, label, options) {
    const MUTATION = `
        mutation($id: ID!, $uuid: ID!, $label: String!, $options: [String]) {
            updatePhaseField(input: { id: $id, uuid: $uuid, label: $label, options: $options }) {
                phase_field { id label }
            }
        }`;
    const dados = await pipefyFetch(MUTATION, { id: fieldId, uuid: fieldUuid, label, options });
    return dados.updatePhaseField.phase_field;
}

const LOTE_UPDATE_CAMPO = 30; // teto de segurança — um pedido com centenas de cards pode passar do tamanho/complexidade que o Pipefy aceita (Tarefa B1, 2º adendo 23/10/2026)

// (conferir) — mesma ideia de updateCardFieldsEmLote, mas pra gravar o MESMO
// campo em VÁRIOS cards diferentes (Tarefa 9: renomear representante/revenda
// em todos os cards que tinham o valor antigo). Divide em lotes de
// LOTE_UPDATE_CAMPO cards por chamada; dentro de cada lote, um erro de
// VALIDAÇÃO (não de transporte) é isolado por bissecção
// (executarMutationsComBisseccao) — um card com valor problemático não
// derruba os outros 29 do mesmo lote. Devolve quantos foram atualizados e
// quantos falharam, em vez de só repassar o retorno cru do Pipefy (Tarefa B1).
async function updateFieldEmVariosCards(campoId, valorNovo, cardIds) {
    if (!cardIds.length) return { success: true, atualizados: 0, falharam: 0 };

    let atualizados = 0, falharam = 0;
    for (let i = 0; i < cardIds.length; i += LOTE_UPDATE_CAMPO) {
        const lote = cardIds.slice(i, i + LOTE_UPDATE_CAMPO);
        const mutacoesPorIndice = {};
        lote.forEach((cardId, j) => {
            mutacoesPorIndice[j] = `m${j}: updateCardField(input: { card_id: "${cardId}", field_id: "${campoId}", new_value: ${JSON.stringify(valorNovo)} }) { success }`;
        });
        const { ok, falhas } = await executarMutationsComBisseccao(mutacoesPorIndice);
        atualizados += ok.length;
        const qtdFalhas = Object.keys(falhas).length;
        falharam += qtdFalhas;
        if (qtdFalhas) {
            logger.error({
                message: "updateFieldEmVariosCards: card(s) recusado(s) nesse lote",
                campoId,
                cardsComFalha: Object.entries(falhas).map(([j, erro]) => ({ cardId: lote[j], erro }))
            });
        }
    }
    return { success: falharam === 0, atualizados, falharam };
}

module.exports = {
    pipefyFetch,
    getPipeLabels,
    findCardByRdId,
    findCardsByFieldValue,
    getCard,
    updateCardField,
    moveCardToPhase,
    updateCardAssignees,
    updateCardFieldsEmLote,
    updateFieldEmVariosCards,
    getStartFormFields,
    updatePhaseField,
    createContato,
    createCard,
    createComment,
    getCardComments,
    findContatoPorEmail,
    getTableRecord,
    allCardsInPipe,
    allCardsAtualizadosDesde
};
