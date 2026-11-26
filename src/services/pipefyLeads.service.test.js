// Testa a tradução card do Pipefy -> objeto "deal" compatível com
// getCustomField/mapDealToCard/getLeads/caminhoVenda.service.js — sem
// chamar a API real do Pipefy (mock de pipefy.service.js).
//
// Mock padrão de "../database" (Tarefa A6, 2º adendo 23/10/2026): desde que
// o cache tentou persistir no banco, qualquer teste que não mocka
// "../database" explicitamente acabava batendo na conexão REAL (lenta e
// sempre falhando no ambiente de teste). Esse beforeEach de nível de arquivo
// roda ANTES do beforeEach de cada describe (que faz jest.resetModules()) —
// testes que precisam de um comportamento específico do banco (ex.: Tarefa 8,
// A1) chamam o próprio jest.doMock("../database", ...) dentro do `it`, que
// sobrepõe este default.
beforeEach(() => {
    jest.doMock("../database", () => ({ sequelize: { query: jest.fn().mockRejectedValue(new Error("../database não mockado neste teste")) } }));
});

const CAMPOS_COMPARTILHADOS = {
    "Título": "t_tulo",
    "PCI": "pci",
    "CNPJ": "cnpj",
    "Cidade": "cidade",
    "Revenda/Loja": "revenda_loja",
    "Representante": "representante",
    "Máquina de interesse": "m_quina_de_interesse",
    "Valor total": "valor_total",
    "Data de criação no RD": "data_de_cria_o_no_rd",
    "Data de fechamento no RD": "data_de_fechamento_no_rd",
    "Contato": "contato",
    "Empresa": "empresa",
    "Próxima ação": "pr_xima_a_o",
    "Data da próxima ação": "data_da_pr_xima_a_o",
    "ID no RD CRM": "id_no_rd_crm"
};

// CRM BOXER SOLDAS (Fase 5, 18/11/2026) tem um esquema de campos diferente
// dos outros 4 — "Título" apelidado pro campo real "Nome Fantasia"
// (OBRIGATÓRIO nesse pipe — achado real num teste ao vivo, 18/11/2026: sem
// esse apelido, toda criação de card falhava com "O campo Nome Fantasia é
// obrigatório"), "PCI" apelidado pro campo real "Perfil PCI 🤖" (id
// diferente, de propósito, pra provar que o apelido é resolvido por este
// mapa, não por coincidência de id).
const CAMPOS_CRM_BOXER_SOLDAS = {
    "Título": "nome_fantasia",
    "PCI": "perfil_pci",
    "CNPJ": "cnpj",
    "Cidade": "cidade",
    "Revenda/Loja": "revenda_loja",
    "Representante": "representante",
    "Máquina de interesse": "m_quina_de_interesse",
    "Valor total": "valor_total",
    "Data de criação no RD": "data_de_cria_o_rd",
    "Data de fechamento no RD": "data_de_fechamento",
    "Contato": "contatos",
    "Empresa": "empresa",
    "ID no RD CRM": "id_no_rd"
};

// No mapa_pipefy.json real, os 4 pipes compartilham os mesmos ids de campo
// (derivados do rótulo pelo Pipefy) — reproduzido aqui com CAMPOS_COMPARTILHADOS.
const MAPA_TESTE = {
    pipes: {
        "CRM BOXER SOLDAS": {
            id: "307242360",
            fases: {
                "Lead": "343660995",
                "Em contato": "343660996",
                "Negociação": "343660997",
                "Demonstração": "343660998",
                "Timming ": "344735863",
                "Venda Efetiva": "343660999",
                "Perdidos | Sem Perfil": "343661000",
                "ENTREGA TECNICA ": "344771651"
            },
            campos: CAMPOS_CRM_BOXER_SOLDAS
        },
        BMAX: {
            id: "307397065",
            fases: {
                "Leads Revenda": "344532516",
                "Prazo Vencido": "344532517",
                "Venda Efetivada": "344532518",
                "Perdido": "344532575",
                "Transferido para a Indústria": "344532599"
            },
            campos: CAMPOS_COMPARTILHADOS
        },
        "INDÚSTRIA - INTERNO": {
            id: "307397025",
            fases: {
                "LEAD": "344500001",
                "EM CONTATO": "344500002",
                "NEGOCIAÇÃO": "344500003",
                "DEMONSTRAÇÃO": "344500004",
                "VENDA EFETIVADA": "344500005",
                "ENTREGA TECNICA": "344500006",
                "PERDIDOS | SEM PERFIL": "344500007"
            },
            campos: CAMPOS_COMPARTILHADOS
        },
        "REVENDA - INTERNO": {
            id: "307397056",
            fases: {
                "LEADS": "344600001",
                "EM CONTATO": "344600002",
                "NEGOCIAÇÕES": "344600003",
                "VENDA EFETIVADA": "344600004",
                "PERDIDOS E SEM PERFIL": "344600005"
            },
            campos: CAMPOS_COMPARTILHADOS
        },
        // Id real confirmado no mapa_pipefy.json local — Fase 7, 19/11/2026
        // (Consulta de Lead do Motor passa a varrer esse pipe também).
        "FUNIL SDR": {
            id: "307397042",
            fases: {},
            campos: CAMPOS_COMPARTILHADOS
        }
    },
    contatos: { id: "CCt1tB1F", campos: { "Nome": "nome", "E-mail": "e_mail", "Telefone": "telefone" } },
    empresas: { id: "d-K0ZaIH", campos: { "Nome": "nome_empresa", "CNPJ": "cnpj_empresa" } },
    // Confirmado ao vivo (18/11/2026): "Empresa"/"Contatos" do CRM BOXER
    // SOLDAS ligam em databases DIFERENTES de Empresas Comercial/Contatos
    // Comercial — ids/rótulos de campo propositalmente diferentes dos de
    // cima, pra provar que tabelaEmpresaDoPipe/tabelaContatoDoPipe resolvem
    // a base certa por pipe, não por coincidência.
    contatosRD: { id: "contatosRdId", campos: { "Nome": "nome_rd", "E-mail": "e_mails_rd" } },
    empresasRD: { id: "empresasRdId", campos: { "Nome": "nome_rd", "CNPJ": "cnpj_rd" } },
    membros: { "ayrton.oliveira@boxersoldas.com.br": "307413540" }
};

function cardBase(overrides = {}) {
    return {
        id: "999",
        title: "Empresa Teste",
        // Depois do corte de 01/05/2026 que getLeads (rd.leads.service.js)
        // aplica — senão o teste de exclusão por fase filtraria tudo por
        // data, mascarando o que o teste realmente quer checar.
        // created_at/updated_at: nomes confirmados na conta real (20/10/2026,
        // bmax_pipefy_correcoes_adendo.md) — NÃO createdAt.
        created_at: "2026-06-01T10:00:00Z",
        updated_at: "2026-06-01T10:00:00+00:00",
        current_phase: { id: "x", name: "Leads Revenda" },
        labels: [{ name: "RD: Indústria" }],   // o Portal só considera cards com esta etiqueta
        fields: [
            { field: { id: "pci" }, value: "PCI 12" },
            { field: { id: "cnpj" }, value: "12345678000199" }
        ],
        assignees: [],
        ...overrides
    };
}

describe("pipefyLeads.service — cardParaDealFake / fetchAllDealsPipefy", () => {
    let RD_STAGE_ASSUMIDO, RD_STAGE_PERDIDO, RD_STAGE_VENDIDO;

    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
        // Testes aqui usam nomes de fase do pipe BMAX ("Leads Revenda" etc.) —
        // fixa o painel nesse pipe, independente do default real (Tarefa 11).
        process.env.PIPEFY_PIPES_PORTAL = "BMAX";
        ({ RD_STAGE_ASSUMIDO, RD_STAGE_PERDIDO, RD_STAGE_VENDIDO } = require("../config/constants"));
    });

    afterEach(() => {
        delete process.env.PIPEFY_PIPES_PORTAL;
    });

    function loadComMockDeCards(cards) {
        jest.doMock("./pipefy.service", () => ({
            allCardsInPipe: jest.fn().mockResolvedValue(cards)
        }));
        return require("./pipefyLeads.service");
    }

    it("traduz fase 'Leads Revenda' -> RD_STAGE_ASSUMIDO, win null", async () => {
        const { fetchAllDealsPipefy } = loadComMockDeCards([cardBase()]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.deal_stage.id).toBe(RD_STAGE_ASSUMIDO);
        expect(deal.deal_stage.name).toBe("Leads Revenda");
        expect(deal.win).toBeNull();
    });

    it("traduz fase 'Venda Efetivada' -> RD_STAGE_VENDIDO, win true, e lê 'Valor total'", async () => {
        const card = cardBase({
            current_phase: { id: "x", name: "Venda Efetivada" },
            fields: [
                { field: { id: "pci" }, value: "PCI 12b" },
                { field: { id: "valor_total" }, value: "R$ 1.234,56" }
            ]
        });
        const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.deal_stage.id).toBe(RD_STAGE_VENDIDO);
        expect(deal.win).toBe(true);
        expect(deal.amount_total).toBeCloseTo(1234.56);
    });

    it("traduz fase 'Prazo Vencido' -> RD_STAGE_PERDIDO, win null (não é perda genuína)", async () => {
        const card = cardBase({ current_phase: { id: "x", name: "Prazo Vencido" } });
        const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.deal_stage.id).toBe(RD_STAGE_PERDIDO);
        expect(deal.deal_stage.name).toBe("Prazo Vencido");
        expect(deal.win).toBeNull();
    });

    it("traduz fase 'Perdido' -> também RD_STAGE_PERDIDO (pra filtro/bloqueio), win false", async () => {
        const card = cardBase({ current_phase: { id: "x", name: "Perdido" } });
        const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.deal_stage.id).toBe(RD_STAGE_PERDIDO);
        expect(deal.deal_stage.name).toBe("Perdido");
        expect(deal.win).toBe(false);
    });

    it("usa o campo 'Data de criação no RD' quando presente (negociação migrada)", async () => {
        const card = cardBase({
            created_at: "2026-06-01T00:00:00Z",
            fields: [
                { field: { id: "pci" }, value: "PCI 12" },
                { field: { id: "data_de_cria_o_no_rd" }, value: "2024-03-15" }
            ]
        });
        const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.created_at).toBe("2024-03-15");
    });

    it("cai pro card.created_at quando não tem 'Data de criação no RD' (negociação nova)", async () => {
        const { fetchAllDealsPipefy } = loadComMockDeCards([cardBase()]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.created_at).toBe("2026-06-01T10:00:00Z");
    });

    describe.each([
        ["2026-05-12", "2026-05-12"],
        ["12/05/2026", "2026-05-12"],
        ["12/05/2026 10:30", "2026-05-12T10:30"],
        ["lixo", null]
    ])("'Data de criação no RD' = %s (Tarefa B4, 2º adendo)", (valorBruto, esperado) => {
        it(`vira ${esperado}`, async () => {
            const card = cardBase({
                fields: [
                    { field: { id: "pci" }, value: "PCI 12" },
                    { field: { id: "data_de_cria_o_no_rd" }, value: valorBruto }
                ]
            });
            const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
            const [deal] = await fetchAllDealsPipefy();

            if (esperado) {
                expect(deal.created_at).toBe(esperado);
            } else {
                // formato não reconhecido: cai pro created_at do card, não numa data errada silenciosa
                expect(deal.created_at).toBe(card.created_at);
            }
        });
    });

    it("usa o campo 'Data de fechamento no RD' pra preencher closed_at, quando presente (achado 23/11/2026 — sem isso, getLeads exclui negociação migrada vendida antes do corte)", async () => {
        const card = cardBase({
            current_phase: { id: "x", name: "Venda Efetivada" },
            fields: [
                { field: { id: "pci" }, value: "PCI 12" },
                { field: { id: "data_de_fechamento_no_rd" }, value: "2025-10-20" }
            ]
        });
        const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.closed_at).toBe("2025-10-20");
    });

    it("closed_at fica null sem 'Data de fechamento no RD' (negociação ainda aberta, ou nascida no Pipefy)", async () => {
        const { fetchAllDealsPipefy } = loadComMockDeCards([cardBase()]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.closed_at).toBeNull();
    });

    it("lê nome/e-mail do primeiro assignee como 'user'", async () => {
        const card = cardBase({ assignees: [{ id: "1", name: "Carlos", email: "carlos@boxersoldas.com.br" }] });
        const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.user).toEqual({ name: "Carlos", email: "carlos@boxersoldas.com.br" });
    });

    it("sem assignees, user é null (sem equivalente)", async () => {
        const { fetchAllDealsPipefy } = loadComMockDeCards([cardBase({ assignees: [] })]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.user).toBeNull();
    });

    it("amount_total aceita formato americano '1234.56'", async () => {
        const card = cardBase({ fields: [{ field: { id: "valor_total" }, value: "1234.56" }] });
        const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
        const [deal] = await fetchAllDealsPipefy();

        expect(deal.amount_total).toBeCloseTo(1234.56);
    });

    describe.each([
        ["1.234,56", 1234.56],
        ["1.234.567,89", 1234567.89],
        ["0,50", 0.5],
        ["1.000", 1000]
    ])("'Valor total' = %s (formato BR confirmado na conta real, 3º adendo 26/10/2026)", (valorBruto, esperado) => {
        it(`vira ${esperado}`, async () => {
            const card = cardBase({ fields: [{ field: { id: "valor_total" }, value: valorBruto }] });
            const { fetchAllDealsPipefy } = loadComMockDeCards([card]);
            const [deal] = await fetchAllDealsPipefy();

            expect(deal.amount_total).toBeCloseTo(esperado);
        });
    });

    it("getLeads (rd.leads.service, CRM_PROVIDER=pipefy) exclui leads em 'Prazo Vencido' e 'Perdido' do painel", async () => {
        process.env.CRM_PROVIDER = "pipefy";
        process.env.RD_CRM_TOKEN = "x";
        const cards = [
            cardBase({ id: "1", current_phase: { id: "x", name: "Leads Revenda" } }),
            cardBase({ id: "2", current_phase: { id: "x", name: "Prazo Vencido" } }),
            cardBase({ id: "3", current_phase: { id: "x", name: "Perdido" } }),
            cardBase({ id: "4", current_phase: { id: "x", name: "Venda Efetivada" } })
        ];
        jest.doMock("./pipefy.service", () => ({
            allCardsInPipe: jest.fn().mockResolvedValue(cards)
        }));
        const { getLeads } = require("./rd.leads.service");

        const leads = await getLeads("adm", "adm");

        const ids = leads.map(l => l.id).sort();
        expect(ids).toEqual(["1", "4"]);
    });
});

describe("pipefyLeads.service — cache de fetchAllDealsPipefy (Tarefa 4)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("duas chamadas seguidas fazem só UMA busca real (cache)", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase()]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        await fetchAllDealsPipefy();
        await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(1);
    });

    it("chamadas concorrentes deduplicam na mesma busca (sem cache ainda quente)", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase()]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        await Promise.all([fetchAllDealsPipefy(), fetchAllDealsPipefy(), fetchAllDealsPipefy()]);

        expect(allCardsInPipe).toHaveBeenCalledTimes(1);
    });

    it("invalidarCachePipefy força nova busca completa na próxima chamada", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase()]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy, invalidarCachePipefy } = require("./pipefyLeads.service");

        await fetchAllDealsPipefy();
        invalidarCachePipefy();
        await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(2);
    });

    it("leitura completa de novo depois de 24h, mesmo com cache ainda dentro do PIPEFY_CACHE_MIN", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase()]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde: jest.fn() }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const agora = Date.now();
        jest.spyOn(Date, "now").mockReturnValue(agora);
        await fetchAllDealsPipefy();
        jest.spyOn(Date, "now").mockReturnValue(agora + 25 * 60 * 60 * 1000); // +25h
        await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(2);
        Date.now.mockRestore();
    });

    it("entre a leitura inicial e as 24h, usa leitura incremental (allCardsAtualizadosDesde) em vez de completa", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ id: "1", updated_at: "2026-06-01T10:00:00+00:00" })]);
        const allCardsAtualizadosDesde = jest.fn().mockResolvedValue([cardBase({ id: "2" })]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const agora = Date.now();
        jest.spyOn(Date, "now").mockReturnValue(agora);
        await fetchAllDealsPipefy();
        process.env.PIPEFY_CACHE_MIN = "1";
        jest.spyOn(Date, "now").mockReturnValue(agora + 5 * 60 * 1000); // +5 min >= 1 min de cache
        const deals = await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(1);
        // A referência é o maior updated_at JÁ VISTO no cache (achado real,
        // 20/10/2026) — não a hora do relógio local (Date.now()).
        expect(allCardsAtualizadosDesde).toHaveBeenCalledWith("307242360", "2026-06-01T10:00:00+00:00");
        expect(deals.map(d => d.id).sort()).toEqual(["1", "2"]); // mescla com o que já tinha no cache
        Date.now.mockRestore();
        delete process.env.PIPEFY_CACHE_MIN;
    });

    it("sem nenhum updated_at no cache (pipe vazio na leitura inicial), não tenta o filtro incremental", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([]);
        const allCardsAtualizadosDesde = jest.fn();
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const agora = Date.now();
        jest.spyOn(Date, "now").mockReturnValue(agora);
        await fetchAllDealsPipefy();
        process.env.PIPEFY_CACHE_MIN = "1";
        jest.spyOn(Date, "now").mockReturnValue(agora + 5 * 60 * 1000);
        const deals = await fetchAllDealsPipefy();

        expect(allCardsAtualizadosDesde).not.toHaveBeenCalled();
        expect(allCardsInPipe).toHaveBeenCalledTimes(1);
        expect(deals).toEqual([]);
        Date.now.mockRestore();
        delete process.env.PIPEFY_CACHE_MIN;
    });

    it("se a leitura incremental falhar, cai pra leitura completa sem quebrar", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ id: "1" })]);
        const allCardsAtualizadosDesde = jest.fn().mockRejectedValue(new Error("filtro não suportado"));
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const agora = Date.now();
        jest.spyOn(Date, "now").mockReturnValue(agora);
        await fetchAllDealsPipefy();
        process.env.PIPEFY_CACHE_MIN = "1";
        jest.spyOn(Date, "now").mockReturnValue(agora + 5 * 60 * 1000);
        const deals = await fetchAllDealsPipefy();

        expect(allCardsAtualizadosDesde).toHaveBeenCalledTimes(1);
        expect(allCardsInPipe).toHaveBeenCalledTimes(2); // fallback: leitura completa de novo
        expect(deals.map(d => d.id)).toEqual(["1"]);
        Date.now.mockRestore();
        delete process.env.PIPEFY_CACHE_MIN;
    });

    it("createLeadPipefy atualiza só o card criado no cache, sem forçar nova leitura completa do pipe", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ id: "1" })]);
        const createCard = jest.fn().mockResolvedValue({ id: "novo-card" });
        const getCard = jest.fn().mockResolvedValue(cardBase({ id: "novo-card", pipe: { id: "307242360", name: "CRM BOXER SOLDAS" } }));
        const findContatoPorEmail = jest.fn().mockResolvedValue({ id: "empresa1" }); // Empresa já cadastrada por CNPJ
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, createCard, getCard, findContatoPorEmail, createContato: jest.fn() }));
        const { fetchAllDealsPipefy, createLeadPipefy } = require("./pipefyLeads.service");

        await fetchAllDealsPipefy(); // aquece o cache do pipe padrão (CRM BOXER SOLDAS)
        await createLeadPipefy({ nome: "Cliente X", cnpj: "11222333000144", role: "representante", funil: "industria" });
        const deals = await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(1); // sem releitura completa
        expect(getCard).toHaveBeenCalledWith("novo-card");
        expect(deals.map(d => d.id).sort()).toEqual(["1", "novo-card"]);
    });
});

describe("pipefyLeads.service — cache no banco, sobrevive a instância nova (Tarefa A6, 2º adendo)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("instância nova (cache em memória vazio) carrega do banco antes de chamar allCardsInPipe, e a 1ª listagem usa allCardsAtualizadosDesde", async () => {
        const agora = Date.now();
        const query = jest.fn().mockImplementation((sql) => {
            if (sql.includes("bmax_pipefy_cache_estado")) {
                return Promise.resolve([{ maior_updated_at: "2026-06-01T10:00:00+00:00", ultima_leitura_completa: new Date(agora - 60 * 60 * 1000) }]);
            }
            if (sql.includes("bmax_pipefy_cache_cards")) {
                return Promise.resolve([{ card_id: "1", card: JSON.stringify(cardBase({ id: "1" })) }]);
            }
            return Promise.resolve([]);
        });
        jest.doMock("../database", () => ({ sequelize: { query } }));
        const allCardsInPipe = jest.fn();
        const allCardsAtualizadosDesde = jest.fn().mockResolvedValue([]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        process.env.PIPEFY_CACHE_MIN = "1"; // cache do banco tem 1h, já vencido
        const deals = await fetchAllDealsPipefy();

        expect(allCardsInPipe).not.toHaveBeenCalled(); // não fez leitura completa
        expect(allCardsAtualizadosDesde).toHaveBeenCalledWith(expect.any(String), "2026-06-01T10:00:00+00:00"); // referência veio do banco
        expect(deals.map(d => d.id)).toEqual(["1"]); // card do banco apareceu no resultado
        delete process.env.PIPEFY_CACHE_MIN;
    });

    it("sem nada no banco (cold start de verdade), faz leitura completa normalmente e grava no banco depois", async () => {
        const query = jest.fn().mockResolvedValue([]); // SELECT não acha nada
        jest.doMock("../database", () => ({ sequelize: { query } }));
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ id: "1" })]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(1);
        const chamadasInsert = query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO bmax_pipefy_cache"));
        expect(chamadasInsert.length).toBeGreaterThan(0); // gravou estado e/ou cards no banco
    });

    it("falha do banco (query rejeita) não quebra a listagem — segue só com a memória", async () => {
        const query = jest.fn().mockRejectedValue(new Error("conexão recusada"));
        jest.doMock("../database", () => ({ sequelize: { query } }));
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ id: "1" })]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const deals = await fetchAllDealsPipefy();

        expect(deals.map(d => d.id)).toEqual(["1"]);
    });
});

describe("pipefyLeads.service — cache no banco em lotes e consistência (3º adendo, 23/10/2026)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("A1: grava o cache do banco em lotes de 100, não um card por vez", async () => {
        const cards = Array.from({ length: 250 }, (_, i) => cardBase({ id: String(i) }));
        const query = jest.fn().mockResolvedValue([]);
        jest.doMock("../database", () => ({ sequelize: { query } }));
        const allCardsInPipe = jest.fn().mockResolvedValue(cards);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        await fetchAllDealsPipefy();

        const inserts = query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO bmax_pipefy_cache_cards"));
        expect(inserts.length).toBe(3); // 100 + 100 + 50

        const idsGravados = inserts.flatMap(([, opts]) =>
            Object.entries(opts.replacements)
                .filter(([k]) => k.startsWith("id"))
                .map(([, v]) => v)
        );
        expect(idsGravados.length).toBe(250);
        expect(idsGravados.sort((a, b) => a - b)).toEqual(cards.map(c => c.id).sort((a, b) => a - b));
    });

    it("A2.1: a leitura completa de reserva SUBSTITUI o cache (não soma) — cards que sumiram saem", async () => {
        const allCardsInPipe = jest.fn()
            .mockResolvedValueOnce([cardBase({ id: "1" })]) // leitura inicial completa
            .mockResolvedValueOnce([cardBase({ id: "2" })]); // reserva (fallback): "1" sumiu
        const allCardsAtualizadosDesde = jest.fn().mockRejectedValue(new Error("filtro não suportado"));
        const query = jest.fn().mockResolvedValue([]);
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const agora = Date.now();
        jest.spyOn(Date, "now").mockReturnValue(agora);
        await fetchAllDealsPipefy();
        process.env.PIPEFY_CACHE_MIN = "1";
        jest.spyOn(Date, "now").mockReturnValue(agora + 5 * 60 * 1000);
        const deals = await fetchAllDealsPipefy();

        expect(deals.map(d => d.id)).toEqual(["2"]); // "1" não soma mais — saiu do cache
        const deletesPorSobra = query.mock.calls.filter(([sql]) => sql.includes("DELETE FROM bmax_pipefy_cache_cards") && sql.includes("NOT IN"));
        expect(deletesPorSobra.length).toBeGreaterThan(0); // também limpou do banco

        Date.now.mockRestore();
        delete process.env.PIPEFY_CACHE_MIN;
    });

    it("A2.2: atualizarCardNoCache apaga a linha do banco quando o card some do Pipefy", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ id: "1" })]);
        const getCard = jest.fn().mockResolvedValue(null); // card sumiu
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        const query = jest.fn().mockResolvedValue([]);
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, getCard, createCard, findContatoPorEmail: jest.fn().mockResolvedValue({ id: "empresa1" }), createContato: jest.fn() }));
        const { fetchAllDealsPipefy, createLeadPipefy } = require("./pipefyLeads.service");

        await fetchAllDealsPipefy(); // aquece o cache do pipe padrão
        query.mockClear();
        await createLeadPipefy({ nome: "Cliente W", cnpj: "11222333000144" }); // chama atualizarCardNoCache("1") internamente

        const deletesPontuais = query.mock.calls.filter(([sql]) => sql.includes("DELETE FROM bmax_pipefy_cache_cards") && sql.includes("card_id = :cardId"));
        expect(deletesPontuais.length).toBeGreaterThan(0);
    });
});

describe("pipefyLeads.service — valores válidos (Tarefa 5)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("createLeadPipefy não envia campos vazios (Revenda/Representante ausentes)", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail: jest.fn().mockResolvedValue({ id: "empresa1" }), createContato: jest.fn() }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Y", cnpj: "11222333000144" });

        const camposEnviados = createCard.mock.calls[0][3];
        const vazios = camposEnviados.filter(c => c.field_value === "" || c.field_value == null);
        expect(vazios).toEqual([]);
    });

    it("createLeadPipefy tira espaço nas pontas dos valores de texto", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail: jest.fn().mockResolvedValue({ id: "empresa1" }), createContato: jest.fn() }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Z", cnpj: "11222333000144", revenda: "  Soldas Parana  " });

        const camposEnviados = createCard.mock.calls[0][3];
        const revenda = camposEnviados.find(c => c.field_id === "revenda_loja");
        expect(revenda.field_value).toBe("Soldas Parana");
    });

    // Achado real (26/10/2026): createLeadPipefy nunca ligava Empresa nenhuma
    // — um card sem Empresa não tem o que a transferência BOX+REV>IND copiar
    // nesse campo. Corrigido com o mesmo padrão do Contato, mas achando/
    // criando por CNPJ (sempre presente no formulário, ao contrário do e-mail).
    it("createLeadPipefy acha a Empresa existente pelo CNPJ e liga ao card, sem criar outra", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        const findContatoPorEmail = jest.fn().mockResolvedValue({ id: "empresa-existente" });
        const createContato = jest.fn();
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail, createContato }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Empresa", cnpj: "11222333000144" });

        expect(findContatoPorEmail).toHaveBeenCalledWith("empresasRdId", "cnpj_rd", "11222333000144");
        expect(createContato).not.toHaveBeenCalled();
        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados).toEqual(expect.arrayContaining([{ field_id: "empresa", field_value: ["empresa-existente"] }]));
    });

    // Achado real (26/10/2026): o database Empresas Comercial grava CNPJ só
    // com números (confirmado consultando a conta real). O formulário de Nova
    // Negociação aceita CNPJ com pontuação — sem normalizar, uma empresa
    // gravada como "11222333000181" nunca batia com uma negociação digitada
    // como "11.222.333/0001-81", e criava um registro duplicado.
    it("normaliza o CNPJ (com pontuação) antes de achar/criar a Empresa, achando a gravada só com números", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        const findContatoPorEmail = jest.fn().mockResolvedValue({ id: "empresa-existente" });
        const createContato = jest.fn();
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail, createContato }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Empresa Pontuada", cnpj: "11.222.333/0001-81" });

        expect(findContatoPorEmail).toHaveBeenCalledWith("empresasRdId", "cnpj_rd", "11222333000181");
        expect(createContato).not.toHaveBeenCalled();
        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados).toEqual(expect.arrayContaining([{ field_id: "empresa", field_value: ["empresa-existente"] }]));
    });

    it("createLeadPipefy cria a Empresa quando não acha pelo CNPJ, e liga a recém-criada", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        const findContatoPorEmail = jest.fn().mockResolvedValue(null);
        const createContato = jest.fn().mockResolvedValue({ id: "empresa-nova" });
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail, createContato }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Empresa Nova", cnpj: "99888777000166" });

        expect(createContato).toHaveBeenCalledWith("empresasRdId", "Cliente Empresa Nova", expect.arrayContaining([
            { field_id: "nome_rd", field_value: "Cliente Empresa Nova" },
            { field_id: "cnpj_rd", field_value: "99888777000166" }
        ]));
        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados).toEqual(expect.arrayContaining([{ field_id: "empresa", field_value: ["empresa-nova"] }]));
    });

    it("sem CNPJ, não liga Empresa nenhuma (sem chamar findContatoPorEmail/createContato pro database de Empresas)", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        const findContatoPorEmail = jest.fn();
        const createContato = jest.fn();
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail, createContato }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Sem CNPJ" });

        expect(findContatoPorEmail).not.toHaveBeenCalled();
        expect(createContato).not.toHaveBeenCalled();
        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "empresa")).toBeUndefined();
    });

    // Achado real (26/10/2026): achar/criar a Empresa nunca pode impedir a
    // negociação de ser registrada — se o Pipefy falhar nessa etapa, o card
    // ainda deve ser criado (só sem a Empresa vinculada).
    it("se achar/criar a Empresa falhar, cria o card do mesmo jeito, sem o campo Empresa", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        const findContatoPorEmail = jest.fn().mockRejectedValue(new Error("Pipefy fora do ar"));
        const createContato = jest.fn();
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail, createContato }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await expect(createLeadPipefy({ nome: "Cliente Empresa Falha", cnpj: "11222333000144" })).resolves.toEqual({ id: "1" });

        expect(createCard).toHaveBeenCalled();
        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "empresa")).toBeUndefined();
    });

    it("updateLeadPipefy recusa PCI fora das 21 opções válidas, sem chamar o Pipefy", async () => {
        const updateCardFieldsEmLote = jest.fn();
        jest.doMock("./pipefy.service", () => ({ updateCardFieldsEmLote, moveCardToPhase: jest.fn(), getCard: jest.fn() }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await expect(updateLeadPipefy("123", { data: { custom_fields: { "perfil-pci": "PCI inválido" } } }))
            .rejects.toThrow("PCI inválido para o Pipefy");

        expect(updateCardFieldsEmLote).not.toHaveBeenCalled();
    });

    it("updateLeadPipefy aceita um PCI válido normalmente", async () => {
        const updateCardFieldsEmLote = jest.fn().mockResolvedValue({ success: true });
        jest.doMock("./pipefy.service", () => ({ updateCardFieldsEmLote, moveCardToPhase: jest.fn(), getCard: jest.fn().mockResolvedValue(null) }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await updateLeadPipefy("123", { data: { custom_fields: { "perfil-pci": "PCI 12a" } } });

        expect(updateCardFieldsEmLote).toHaveBeenCalledWith("123", [{ campoId: "pci", valor: "PCI 12a" }]);
    });
});

describe("pipefyLeads.service — valor e responsável em updateLeadPipefy (Tarefa 6)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("grava amount_total no campo 'Valor total', junto com os demais no mesmo lote", async () => {
        const updateCardFieldsEmLote = jest.fn().mockResolvedValue({ success: true });
        jest.doMock("./pipefy.service", () => ({ updateCardFieldsEmLote, moveCardToPhase: jest.fn(), getCard: jest.fn().mockResolvedValue(null) }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await updateLeadPipefy("123", { data: { amount_total: 1500.5, custom_fields: { "perfil-pci": "PCI 12b" } } });

        expect(updateCardFieldsEmLote).toHaveBeenCalledTimes(1);
        const pares = updateCardFieldsEmLote.mock.calls[0][1];
        expect(pares).toEqual(expect.arrayContaining([
            { campoId: "pci", valor: "PCI 12b" },
            { campoId: "valor_total", valor: "1500.5" }
        ]));
    });

    it("traduz owner_id do RD -> e-mail -> membro do Pipefy e atribui o card", async () => {
        const updateCardAssignees = jest.fn().mockResolvedValue({ success: true });
        jest.doMock("./pipefy.service", () => ({ updateCardAssignees, moveCardToPhase: jest.fn(), updateCardFieldsEmLote: jest.fn(), getCard: jest.fn().mockResolvedValue(null) }));
        jest.doMock("./rd.leads.service", () => ({
            getAliasMaps: jest.fn().mockResolvedValue({ rdToEmail: { "Carlos": "ayrton.oliveira@boxersoldas.com.br" } })
        }));
        const { RD_OWNERS } = require("../config/constants");
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await updateLeadPipefy("123", { data: { owner_id: RD_OWNERS["Carlos"] } });

        expect(updateCardAssignees).toHaveBeenCalledWith("123", ["307413540"]);
    });

    it("sem membro do Pipefy correspondente ao e-mail, só avisa e não falha", async () => {
        const updateCardAssignees = jest.fn();
        jest.doMock("./pipefy.service", () => ({ updateCardAssignees, moveCardToPhase: jest.fn(), updateCardFieldsEmLote: jest.fn(), getCard: jest.fn().mockResolvedValue(null) }));
        jest.doMock("./rd.leads.service", () => ({
            getAliasMaps: jest.fn().mockResolvedValue({ rdToEmail: { "Carlos": "carlos@naoemembro.com" } })
        }));
        const { RD_OWNERS } = require("../config/constants");
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await expect(updateLeadPipefy("123", { data: { owner_id: RD_OWNERS["Carlos"] } })).resolves.toEqual({ id: "123" });
        expect(updateCardAssignees).not.toHaveBeenCalled();
    });
});

describe("pipefyLeads.service — tarefas/notas como comentário (Tarefa 7)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("createTaskPipefy cria um comentário com tipo/prazo/assunto e grava os campos de próxima ação", async () => {
        const createComment = jest.fn().mockResolvedValue({ id: "c1" });
        const updateCardFieldsEmLote = jest.fn().mockResolvedValue({ success: true });
        const getCard = jest.fn().mockResolvedValue(null); // "123" não parece ID do RD: resolverCardId nem chama getCard; nomePipeDoCard chama pra descobrir o pipe (cai no fallback "BMAX")
        jest.doMock("./pipefy.service", () => ({ createComment, updateCardFieldsEmLote, getCard }));
        const { createTaskPipefy } = require("./pipefyLeads.service");

        await createTaskPipefy({ deal_id: "123", name: "Ligar pro cliente", date: "2026-12-01", notes: "Combinar entrega" });

        expect(createComment).toHaveBeenCalledWith("123", expect.stringContaining("Ligar pro cliente"));
        expect(createComment).toHaveBeenCalledWith("123", expect.stringContaining("Combinar entrega"));
        expect(updateCardFieldsEmLote).toHaveBeenCalledWith("123", expect.arrayContaining([
            { campoId: "pr_xima_a_o", valor: "Ligar pro cliente" },
            { campoId: "data_da_pr_xima_a_o", valor: "2026-12-01" }
        ]));
    });

    it("createNotePipefy grava o texto como comentário no card", async () => {
        const createComment = jest.fn().mockResolvedValue({ id: "c2", text: "Nota qualquer" });
        jest.doMock("./pipefy.service", () => ({ createComment }));
        const { createNotePipefy } = require("./pipefyLeads.service");

        const resultado = await createNotePipefy("123", "Nota qualquer");

        expect(createComment).toHaveBeenCalledWith("123", "Nota qualquer");
        expect(resultado).toEqual({ id: "c2", text: "Nota qualquer" });
    });

    it("getLeadNotesPipefy devolve os comentários no formato {data:[...]} que formatarHistoricoNotas já lê", async () => {
        const getCardComments = jest.fn().mockResolvedValue([
            { text: "Comentário 1", created_at: "2026-01-01", author: { name: "Carlos" } }
        ]);
        jest.doMock("./pipefy.service", () => ({ getCardComments }));
        const { getLeadNotesPipefy } = require("./pipefyLeads.service");

        const resultado = await getLeadNotesPipefy("123");

        expect(resultado).toEqual({ data: [{ text: "Comentário 1", created_at: "2026-01-01", author: { name: "Carlos" } }] });
    });

    it("updateTaskPipefy atualiza só os campos de próxima ação informados", async () => {
        const updateCardFieldsEmLote = jest.fn().mockResolvedValue({ success: true });
        const getCard = jest.fn().mockResolvedValue(null);
        jest.doMock("./pipefy.service", () => ({ updateCardFieldsEmLote, getCard }));
        const { updateTaskPipefy } = require("./pipefyLeads.service");

        await updateTaskPipefy({ subject: "Novo assunto", date: "2026-12-10" }, "123");

        expect(updateCardFieldsEmLote).toHaveBeenCalledWith("123", [
            { campoId: "pr_xima_a_o", valor: "Novo assunto" },
            { campoId: "data_da_pr_xima_a_o", valor: "2026-12-10" }
        ]);
    });
});

describe("pipefyLeads.service — pipes configuráveis (Tarefa 11)", () => {
    afterEach(() => {
        delete process.env.PIPEFY_PIPES_PORTAL;
    });

    it("padrão (sem PIPEFY_PIPES_PORTAL): lê só o pipe CRM BOXER SOLDAS (Fase 5 — substitui INDÚSTRIA - INTERNO)", async () => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase()]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(1);
        expect(allCardsInPipe).toHaveBeenCalledWith("307242360");
    });

    it("com PIPEFY_PIPES_PORTAL=BMAX,FUNIL SDR: lê os dois pipes e junta os resultados", async () => {
        jest.resetModules();
        process.env.PIPEFY_PIPES_PORTAL = "BMAX,FUNIL SDR";
        const mapaComDoisPipes = {
            ...MAPA_TESTE,
            pipes: {
                ...MAPA_TESTE.pipes,
                "FUNIL SDR": { id: "307397042", fases: {}, campos: MAPA_TESTE.pipes.BMAX.campos }
            }
        };
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(mapaComDoisPipes);
        const allCardsInPipe = jest.fn()
            .mockResolvedValueOnce([cardBase({ id: "1" })])
            .mockResolvedValueOnce([cardBase({ id: "2" })]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const deals = await fetchAllDealsPipefy();

        expect(allCardsInPipe).toHaveBeenCalledTimes(2);
        expect(allCardsInPipe).toHaveBeenCalledWith("307397065");
        expect(allCardsInPipe).toHaveBeenCalledWith("307397042");
        expect(deals.map(d => d.id).sort()).toEqual(["1", "2"]);
    });

    it("pipe sem tabela fase->etapa RD configurada fica com deal_stage.id null (e avisa em log)", async () => {
        jest.resetModules();
        // "PIPE FUTURO" — nome fictício, de propósito: desde a Fase 7
        // (19/11/2026), FUNIL SDR e REVENDA - INTERNO ganharam entradas
        // VAZIAS (não ausentes) em PIPEFY_FASE_PARA_ETAPA_RD só pra
        // silenciar este mesmo aviso durante a Consulta de Lead do Motor —
        // precisa de um pipe genuinamente sem entrada nenhuma pra exercitar
        // o código deste teste.
        process.env.PIPEFY_PIPES_PORTAL = "PIPE FUTURO";
        const mapaOutroPipe = {
            pipes: { "PIPE FUTURO": { id: "307397042", fases: {}, campos: MAPA_TESTE.pipes.BMAX.campos } },
            contatos: MAPA_TESTE.contatos,
            empresas: MAPA_TESTE.empresas
        };
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(mapaOutroPipe);
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase()]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { fetchAllDealsPipefy } = require("./pipefyLeads.service");

        const [deal] = await fetchAllDealsPipefy();

        expect(deal.deal_stage.id).toBeNull();
    });
});

describe("pipefyLeads.service — CRM BOXER SOLDAS (Fase 5, 18/11/2026)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });
    afterEach(() => {
        delete process.env.PIPEFY_PIPES_PORTAL;
    });

    it("cardParaDealFake traduz PCI 12A/12B (maiúsculo, só opção desse pipe) para a grafia formal 12a/12b", () => {
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe: jest.fn() }));
        const { cardParaDealFake } = require("./pipefyLeads.service");

        const card = cardBase({
            fields: [{ field: { id: "perfil_pci" }, value: "PCI 12B" }]
        });

        const deal = cardParaDealFake(card, "CRM BOXER SOLDAS");

        const pci = deal.deal_custom_fields.find(cf => cf.custom_field.label === "PERFIL PCI");
        expect(pci.value).toBe("PCI 12b");
    });

    it("cardParaDealFake traduz 'Sem revenda' (grafia real do CRM BOXER SOLDAS) de volta pra 'Sem Revenda' (grafia formal)", () => {
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe: jest.fn() }));
        const { cardParaDealFake } = require("./pipefyLeads.service");

        const card = cardBase({
            fields: [{ field: { id: "revenda_loja" }, value: "Sem revenda" }]
        });

        const deal = cardParaDealFake(card, "CRM BOXER SOLDAS");

        const revenda = deal.deal_custom_fields.find(cf => cf.custom_field.label === "REVENDA/LOJA");
        expect(revenda.value).toBe("Sem Revenda");
    });

    it("createLeadPipefy (funil industria) cria no pipe CRM BOXER SOLDAS/fase Lead, com 'Título' apelidado pro campo real 'Nome Fantasia' (obrigatório nesse pipe)", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail: jest.fn().mockResolvedValue({ id: "empresa1" }), createContato: jest.fn() }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Indústria", cnpj: "11222333000144", role: "representante", funil: "industria" });

        expect(createCard).toHaveBeenCalledWith("307242360", "343660995", "Cliente Indústria", expect.any(Array));
        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "nome_fantasia")?.field_value).toBe("Cliente Indústria");
    });

    it("createLeadPipefy (funil industria) traduz 'Sem Revenda' pra 'Sem revenda' (grafia real do campo nesse pipe, achado ao vivo 18/11/2026)", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail: jest.fn().mockResolvedValue({ id: "empresa1" }), createContato: jest.fn() }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Sem Revenda", cnpj: "11222333000144", role: "representante", funil: "industria", revenda: "Sem Revenda" });

        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "revenda_loja").field_value).toBe("Sem revenda");
    });

    it("createLeadPipefy (funil industria) sem PCI informado envia 'Sem PCI' (opção adicionada ao campo, 19/11/2026)", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail: jest.fn().mockResolvedValue({ id: "empresa1" }), createContato: jest.fn() }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({ nome: "Cliente Sem PCI", cnpj: "11222333000144", role: "representante", funil: "industria" });

        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "perfil_pci").field_value).toBe("Sem PCI");
    });

    it("createLeadPipefy (funil industria) liga Empresa/Contato nas databases 'Empresas (RD)'/'Contatos (RD)', não Empresas/Contatos Comercial (achado ao vivo 18/11/2026)", async () => {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        const findContatoPorEmail = jest.fn().mockResolvedValue(null);
        const createContato = jest.fn()
            .mockResolvedValueOnce({ id: "contatoRD1" })
            .mockResolvedValueOnce({ id: "empresaRD1" });
        jest.doMock("./pipefy.service", () => ({ createCard, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail, createContato }));
        const { createLeadPipefy } = require("./pipefyLeads.service");

        await createLeadPipefy({
            nome: "Cliente RD", cnpj: "11222333000144", email: "cliente@exemplo.com",
            role: "representante", funil: "industria"
        });

        // achar contato/empresa: sempre na tabela RD, nunca na Comercial
        expect(findContatoPorEmail).toHaveBeenCalledWith("contatosRdId", "e_mails_rd", "cliente@exemplo.com");
        expect(findContatoPorEmail).toHaveBeenCalledWith("empresasRdId", "cnpj_rd", "11222333000144");
        expect(createContato).toHaveBeenCalledWith("contatosRdId", "Cliente RD", expect.any(Array));
        expect(createContato).toHaveBeenCalledWith("empresasRdId", "Cliente RD", expect.any(Array));

        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "contatos").field_value).toEqual(["contatoRD1"]);
        expect(camposEnviados.find(c => c.field_id === "empresa").field_value).toEqual(["empresaRD1"]);
    });

    it("PIPEFY_FASE_PARA_ETAPA_RD cobre as 8 fases do CRM BOXER SOLDAS, incluindo nomes com espaço no final", () => {
        const { PIPEFY_FASE_PARA_ETAPA_RD } = require("../config/pipefyConstants");
        const tabela = PIPEFY_FASE_PARA_ETAPA_RD["CRM BOXER SOLDAS"];

        expect(Object.keys(tabela)).toEqual(expect.arrayContaining([
            "Lead", "Em contato", "Negociação", "Demonstração", "Timming ", "Venda Efetiva", "ENTREGA TECNICA ", "Perdidos | Sem Perfil"
        ]));
        expect(tabela["Venda Efetiva"].win).toBe(true);
    });

    it("fase 'Timming ' fica fora do painel e da checagem de duplicidade (Comercial confirmou 19/11/2026: fora do BMAX)", () => {
        const { PIPEFY_FASE_PARA_ETAPA_RD } = require("../config/pipefyConstants");
        const { RD_STAGE_EXCLUIDO } = require("../config/constants");
        const infoTimming = PIPEFY_FASE_PARA_ETAPA_RD["CRM BOXER SOLDAS"]["Timming "];

        expect(infoTimming).toEqual({ etapa: RD_STAGE_EXCLUIDO, win: false });
    });
});

describe("pipefyLeads.service — re-busca antes de confirmar duplicata (Tarefa 10)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    // Desde a Tarefa 5/6 (bmax_pipefy_correcoes_adendo.md), a checagem de
    // duplicata varre PIPEFY_PIPES_PORTAL (padrão só "CRM BOXER SOLDAS",
    // id "307242360", desde a Fase 5) + "BMAX" (id "307397065") sempre — os 2
    // pipes onde createLeadPipefy pode criar o card.

    it("encontrou em qualquer um dos pipes verificados: não faz segunda rodada de busca", async () => {
        const allCardsInPipe = jest.fn().mockImplementation((pipeId) => Promise.resolve(
            pipeId === "307397065" // BMAX
                ? [cardBase({ fields: [{ field: { id: "cnpj" }, value: "11222333000144" }] })]
                : []
        ));
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { getLeadByCnpjPipefy } = require("./pipefyLeads.service");

        const encontrado = await getLeadByCnpjPipefy("11222333000144");

        expect(encontrado).not.toBeNull();
        expect(allCardsInPipe).toHaveBeenCalledTimes(2); // 1 por pipe verificado, sem re-busca
    });

    it("não encontrou em nenhum pipe: a re-busca é INCREMENTAL, não completa (Tarefa A5, 2º adendo)", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ fields: [{ field: { id: "cnpj" }, value: "00000000000000" }] })]);
        const allCardsAtualizadosDesde = jest.fn().mockResolvedValue([]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde }));
        const { getLeadByCnpjPipefy } = require("./pipefyLeads.service");

        const encontrado = await getLeadByCnpjPipefy("11222333000144");

        expect(encontrado).toBeNull();
        expect(allCardsInPipe).toHaveBeenCalledTimes(2); // só a leitura completa inicial, 1 por pipe
        expect(allCardsAtualizadosDesde).toHaveBeenCalledTimes(2); // re-busca força incremental, não completa de novo
    });

    it("não encontrou em nenhum pipe (sem allCardsAtualizadosDesde mockado): cai pra completa de novo como fallback", async () => {
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase({ fields: [{ field: { id: "cnpj" }, value: "00000000000000" }] })]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { getLeadByCnpjPipefy } = require("./pipefyLeads.service");

        const encontrado = await getLeadByCnpjPipefy("11222333000144");

        expect(encontrado).toBeNull();
        expect(allCardsInPipe).toHaveBeenCalledTimes(4); // 2 pipes x 2 rodadas (cache + fallback da re-busca)
    });

    it("duplicata criada após a primeira busca aparece na segunda (re-busca)", async () => {
        const chamadasPorPipe = {};
        const allCardsInPipe = jest.fn().mockImplementation((pipeId) => {
            chamadasPorPipe[pipeId] = (chamadasPorPipe[pipeId] || 0) + 1;
            if (pipeId === "307397065" && chamadasPorPipe[pipeId] === 2) {
                return Promise.resolve([cardBase({ fields: [{ field: { id: "cnpj" }, value: "11222333000144" }] })]);
            }
            return Promise.resolve([]);
        });
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        const { getLeadByCnpjPipefy } = require("./pipefyLeads.service");

        const encontrado = await getLeadByCnpjPipefy("11222333000144");

        expect(encontrado).not.toBeNull();
        expect(allCardsInPipe).toHaveBeenCalledTimes(4);
    });
});

describe("pipefyLeads.service — resolução de ID RD <-> Pipefy (Tarefa 8)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("id que já parece card do Pipefy (só dígitos) é devolvido direto, sem consultar o banco nem o Pipefy", async () => {
        const query = jest.fn();
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId: jest.fn(), getCard: jest.fn().mockResolvedValue(cardBase()) }));
        const { resolverCardId } = require("./pipefyLeads.service");

        const cardId = await resolverCardId("555222");

        expect(cardId).toBe("555222");
        expect(query).not.toHaveBeenCalled();
    });

    it("id do RD já mapeado na tabela devolve o card id sem chamar findCardByRdId", async () => {
        const query = jest.fn().mockImplementation((sql) => {
            if (sql.includes("bmax_rd_pipefy_map")) return Promise.resolve([{ pipefy_card_id: "999888" }]);
            return Promise.resolve([]); // bmax_pipefy_transferencias: sem ligação
        });
        const findCardByRdId = jest.fn();
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId, getCard: jest.fn() }));
        const { resolverCardId } = require("./pipefyLeads.service");

        const cardId = await resolverCardId("66151c1470449b000d54e919");

        expect(cardId).toBe("999888");
        expect(findCardByRdId).not.toHaveBeenCalled();
    });

    it("id do RD ainda não mapeado busca via findCardByRdId no primeiro pipe (padrão: CRM BOXER SOLDAS) e grava na tabela", async () => {
        const query = jest.fn().mockResolvedValue([]); // SELECT não acha nada (nem rd_pipefy_map, nem transferencias)
        const findCardByRdId = jest.fn().mockResolvedValue({ id: "777666" });
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId, getCard: jest.fn() }));
        const { resolverCardId } = require("./pipefyLeads.service");

        const cardId = await resolverCardId("66151c1470449b000d54e919");

        expect(cardId).toBe("777666");
        expect(findCardByRdId).toHaveBeenCalledWith("307242360", "id_no_rd", "66151c1470449b000d54e919");
        // 1ª chamada = SELECT bmax_rd_pipefy_map, 2ª = INSERT ... ON CONFLICT,
        // 3ª = SELECT bmax_pipefy_transferencias (Tarefa B1)
        expect(query).toHaveBeenCalledTimes(3);
    });

    it("id do RD não encontrado no 1º pipe (CRM BOXER SOLDAS) é procurado no 2º (BMAX) — Tarefa A2, 2º adendo", async () => {
        const query = jest.fn().mockResolvedValue([]);
        const findCardByRdId = jest.fn()
            .mockImplementation((pipeId) => Promise.resolve(pipeId === "307397065" ? { id: "888999" } : null));
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId, getCard: jest.fn() }));
        const { resolverCardId } = require("./pipefyLeads.service");

        const cardId = await resolverCardId("66151c1470449b000d54e919");

        expect(cardId).toBe("888999");
        expect(findCardByRdId).toHaveBeenCalledWith("307242360", "id_no_rd", "66151c1470449b000d54e919"); // tentou CRM BOXER SOLDAS primeiro
        expect(findCardByRdId).toHaveBeenCalledWith("307397065", "id_no_rd_crm", "66151c1470449b000d54e919"); // achou no BMAX
    });

    // Tarefa B1 (3º adendo, 26/10/2026): depois de resolver um id do RD já
    // mapeado, segue a cadeia de bmax_pipefy_transferencias (gravada por uma
    // transferência BOX+REV>IND anterior) até o card VIVO — mesmo com mais de
    // um salto na cadeia.
    it("id do RD já mapeado, mas o card foi transferido: resolverCardId segue a cadeia até o card vivo", async () => {
        const query = jest.fn().mockImplementation((sql, opts) => {
            if (sql.includes("bmax_rd_pipefy_map")) return Promise.resolve([{ pipefy_card_id: "9001" }]);
            if (sql.includes("bmax_pipefy_transferencias")) {
                const origem = opts.replacements.origem;
                if (origem === "9001") return Promise.resolve([{ card_destino: "9002" }]);
                if (origem === "9002") return Promise.resolve([{ card_destino: "9003" }]);
                return Promise.resolve([]); // "9003" é o card vivo, sem transferência adiante
            }
            return Promise.resolve([]);
        });
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId: jest.fn(), getCard: jest.fn() }));
        const { resolverCardId } = require("./pipefyLeads.service");

        const cardId = await resolverCardId("66151c1470449b000d54e919");

        expect(cardId).toBe("9003");
    });

    it("id do RD sem card correspondente no Pipefy lança erro claro", async () => {
        const query = jest.fn().mockResolvedValue([]);
        const findCardByRdId = jest.fn().mockResolvedValue(null);
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId, getCard: jest.fn() }));
        const { resolverCardId } = require("./pipefyLeads.service");

        await expect(resolverCardId("66151c1470449b000d54e919")).rejects.toThrow("Nenhum card do Pipefy encontrado");
    });

    it("getDealByIdPipefy resolve o id e devolve o card traduzido", async () => {
        const query = jest.fn().mockImplementation((sql) =>
            sql.includes("bmax_rd_pipefy_map") ? Promise.resolve([{ pipefy_card_id: "555222" }]) : Promise.resolve([]));
        const getCard = jest.fn().mockResolvedValue(cardBase({ id: "555222" }));
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId: jest.fn(), getCard }));
        const { getDealByIdPipefy } = require("./pipefyLeads.service");

        const deal = await getDealByIdPipefy("66151c1470449b000d54e919");

        expect(getCard).toHaveBeenCalledWith("555222");
        expect(deal.id).toBe("555222");
    });

    it("getDealByIdPipefy traduz pela tabela do pipe DO CARD, não sempre BMAX (Tarefa A2, 2º adendo)", async () => {
        const query = jest.fn().mockImplementation((sql) =>
            sql.includes("bmax_rd_pipefy_map") ? Promise.resolve([{ pipefy_card_id: "555222" }]) : Promise.resolve([]));
        const card = cardBase({
            id: "555222",
            pipe: { id: "307397025", name: "INDÚSTRIA - INTERNO" },
            current_phase: { id: "x", name: "VENDA EFETIVADA" }
        });
        const getCard = jest.fn().mockResolvedValue(card);
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ findCardByRdId: jest.fn(), getCard }));
        const { getDealByIdPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_VENDA_EFETIVADA } = require("../config/constants");

        const deal = await getDealByIdPipefy("66151c1470449b000d54e919");

        expect(deal.deal_stage.id).toBe(RD_STAGE_VENDA_EFETIVADA);
        expect(deal.win).toBe(true);
    });
});

describe("pipefyLeads.service — getContatoPrincipalPipefy (Fase 6, 19/11/2026)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("lê nome/telefone do registro conectado ao campo Contato, na database Comercial (BMAX)", async () => {
        const card = cardBase({
            id: "9001",
            pipe: { id: "307397065", name: "BMAX" },
            fields: [{
                field: { id: "contato" }, name: "Contato", value: '["Fulano de Tal"]',
                array_value: ["555111"],
                connectedRepoItems: [{ __typename: "PublicTableRecord", id: "555111" }]
            }]
        });
        const getCard = jest.fn().mockResolvedValue(card);
        const getTableRecord = jest.fn().mockResolvedValue({
            id: "555111", title: "Fulano de Tal",
            record_fields: [
                { field: { id: "nome" }, value: "Fulano de Tal" },
                { field: { id: "telefone" }, value: "11999998888" }
            ]
        });
        jest.doMock("./pipefy.service", () => ({ getCard, getTableRecord }));
        const { getContatoPrincipalPipefy } = require("./pipefyLeads.service");

        const contato = await getContatoPrincipalPipefy("9001");

        expect(getTableRecord).toHaveBeenCalledWith("555111");
        expect(contato).toEqual({ nome: "Fulano de Tal", telefone: "11999998888" });
    });

    it("CRM BOXER SOLDAS usa a database Contatos (RD) — sem campo de telefone no mapa, só o nome vem preenchido", async () => {
        const card = cardBase({
            id: "9002",
            pipe: { id: "307242360", name: "CRM BOXER SOLDAS" },
            fields: [{
                field: { id: "contatos" }, name: "Contatos", value: '["Ciclano"]',
                array_value: ["777"],
                connectedRepoItems: [{ __typename: "PublicTableRecord", id: "777" }]
            }]
        });
        const getCard = jest.fn().mockResolvedValue(card);
        const getTableRecord = jest.fn().mockResolvedValue({
            id: "777", title: "Ciclano",
            record_fields: [{ field: { id: "nome_rd" }, value: "Ciclano" }]
        });
        jest.doMock("./pipefy.service", () => ({ getCard, getTableRecord }));
        const { getContatoPrincipalPipefy } = require("./pipefyLeads.service");

        const contato = await getContatoPrincipalPipefy("9002");

        expect(getTableRecord).toHaveBeenCalledWith("777");
        expect(contato).toEqual({ nome: "Ciclano", telefone: null });
    });

    it("sem nenhum ID conectado no campo Contato, devolve null sem chamar getTableRecord", async () => {
        const card = cardBase({
            id: "9003",
            pipe: { id: "307397065", name: "BMAX" },
            fields: [{ field: { id: "contato" }, name: "Contato", value: "", array_value: null, connectedRepoItems: null }]
        });
        const getCard = jest.fn().mockResolvedValue(card);
        const getTableRecord = jest.fn();
        jest.doMock("./pipefy.service", () => ({ getCard, getTableRecord }));
        const { getContatoPrincipalPipefy } = require("./pipefyLeads.service");

        const contato = await getContatoPrincipalPipefy("9003");

        expect(getTableRecord).not.toHaveBeenCalled();
        expect(contato).toBeNull();
    });

    it("card não encontrado no Pipefy devolve null sem lançar", async () => {
        const getCard = jest.fn().mockResolvedValue(null);
        jest.doMock("./pipefy.service", () => ({ getCard, getTableRecord: jest.fn() }));
        const { getContatoPrincipalPipefy } = require("./pipefyLeads.service");

        await expect(getContatoPrincipalPipefy("9004")).resolves.toBeNull();
    });

    it("erro inesperado (ex.: Pipefy fora do ar) é capturado e devolve null, nunca derruba o chamador", async () => {
        const getCard = jest.fn().mockRejectedValue(new Error("Pipefy fora do ar"));
        jest.doMock("./pipefy.service", () => ({ getCard, getTableRecord: jest.fn() }));
        const { getContatoPrincipalPipefy } = require("./pipefyLeads.service");

        await expect(getContatoPrincipalPipefy("9005")).resolves.toBeNull();
    });
});

describe("rd.leads.service — getContatoPrincipal despacha pro Pipefy (Fase 6, 19/11/2026)", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.unmock("./rd.leads.service");
        process.env.CRM_PROVIDER = "pipefy";
        process.env.RD_CRM_TOKEN = "x";
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    afterEach(() => {
        delete process.env.CRM_PROVIDER;
    });

    it("usa o dealId (ignora organizationId, conceito que não existe no Pipefy) e nunca chama o RD", async () => {
        const card = cardBase({
            id: "9001",
            pipe: { id: "307397065", name: "BMAX" },
            fields: [{
                field: { id: "contato" }, name: "Contato", value: '["Fulano de Tal"]',
                array_value: ["555111"],
                connectedRepoItems: [{ __typename: "PublicTableRecord", id: "555111" }]
            }]
        });
        const getCard = jest.fn().mockResolvedValue(card);
        const getTableRecord = jest.fn().mockResolvedValue({
            id: "555111", title: "Fulano de Tal",
            record_fields: [{ field: { id: "nome" }, value: "Fulano de Tal" }, { field: { id: "telefone" }, value: "11999998888" }]
        });
        jest.doMock("./pipefy.service", () => ({ getCard, getTableRecord }));
        const { getContatoPrincipal } = require("./rd.leads.service");

        const contato = await getContatoPrincipal("qualquer-org-id-irrelevante", "9001");

        expect(contato).toEqual({ nome: "Fulano de Tal", telefone: "11999998888" });
    });
});

describe("pipefyLeads.service — Consulta de Lead do Motor no Pipefy (Fase 7, 19/11/2026)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    function mockPipefyService(cardsPorPipeId) {
        const allCardsInPipe = jest.fn().mockImplementation((pipeId) => Promise.resolve(cardsPorPipeId[pipeId] || []));
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        return allCardsInPipe;
    }

    it("varre os 4 pipes ativos (não INDÚSTRIA - INTERNO) e tagueia _pipelineNome certo em cada deal", async () => {
        const allCardsInPipe = mockPipefyService({
            "307242360": [cardBase({ id: "1" })], // CRM BOXER SOLDAS
            "307397065": [cardBase({ id: "2" })], // BMAX
            "307397056": [cardBase({ id: "3" })], // REVENDA - INTERNO
            "307397042": [cardBase({ id: "4" })]  // FUNIL SDR
        });
        const { fetchAllCardsConsultaLeadPipefy } = require("./pipefyLeads.service");

        const deals = await fetchAllCardsConsultaLeadPipefy();

        expect(allCardsInPipe).not.toHaveBeenCalledWith("307397025"); // INDÚSTRIA - INTERNO
        expect(deals.map(d => d._pipelineNome).sort()).toEqual(["BMAX", "CRM BOXER SOLDAS", "FUNIL SDR", "REVENDA - INTERNO"]);
    });

    it("repassa { forcarIncremental: true } pra obterCardsDoPipe (busca por CNPJ precisa do estado mais atual)", async () => {
        // 1ª leitura (cold start) sempre completa, independente de forcarIncremental — e
        // precisa devolver ALGUM card (com updated_at) pra existir uma referência
        // (maiorUpdatedAt); só com isso a 2ª chamada decide entre incremental/completa.
        const allCardsInPipe = jest.fn().mockResolvedValue([cardBase()]);
        const allCardsAtualizadosDesde = jest.fn().mockResolvedValue([]);
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe, allCardsAtualizadosDesde }));
        const { fetchAllCardsConsultaLeadPipefy } = require("./pipefyLeads.service");

        await fetchAllCardsConsultaLeadPipefy();
        await fetchAllCardsConsultaLeadPipefy({ forcarIncremental: true });

        expect(allCardsAtualizadosDesde).toHaveBeenCalled();
    });

    it("card em REVENDA - INTERNO/FUNIL SDR não gera aviso de 'pipe sem tabela configurada' (entradas vazias em PIPEFY_FASE_PARA_ETAPA_RD)", async () => {
        mockPipefyService({
            "307242360": [], "307397065": [],
            "307397056": [cardBase({ id: "3" })],
            "307397042": [cardBase({ id: "4" })]
        });
        const { logger } = require("../logger");
        const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
        const { fetchAllCardsConsultaLeadPipefy } = require("./pipefyLeads.service");

        await fetchAllCardsConsultaLeadPipefy();

        expect(warnSpy).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("pipe sem tabela fase->etapa RD configurada") }));
        warnSpy.mockRestore();
    });
});

describe("rd.leads.service — Consulta de Lead do Motor despacha pro Pipefy (Fase 7, 19/11/2026)", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.unmock("./rd.leads.service");
        process.env.CRM_PROVIDER = "pipefy";
        process.env.RD_CRM_TOKEN = "x";
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    afterEach(() => {
        delete process.env.CRM_PROVIDER;
    });

    function mockPipefyService(cardsPorPipeId) {
        const allCardsInPipe = jest.fn().mockImplementation((pipeId) => Promise.resolve(cardsPorPipeId[pipeId] || []));
        jest.doMock("./pipefy.service", () => ({ allCardsInPipe }));
        return allCardsInPipe;
    }

    it("buildConsultaLeadIndex grava no leads_cache com emFunilBmax certo por pipe, sem chamar o RD", async () => {
        mockPipefyService({
            "307242360": [cardBase({ id: "1", title: "Cliente CRM" })], // CRM BOXER SOLDAS
            "307397065": [cardBase({ id: "2", title: "Cliente BMAX" })], // BMAX
            "307397056": [], "307397042": []
        });
        const setCachedLeads = jest.fn().mockResolvedValue();
        jest.doMock("./cache.service", () => ({ setCachedLeads, getCachedLeads: jest.fn(), invalidateLeadsCache: jest.fn() }));
        const { buildConsultaLeadIndex } = require("./rd.leads.service");

        const total = await buildConsultaLeadIndex();

        expect(total).toBe(2);
        const [, resultados] = setCachedLeads.mock.calls[0];
        expect(resultados.find(r => r.nome === "Cliente CRM").emFunilBmax).toBe(false);
        expect(resultados.find(r => r.nome === "Cliente BMAX").emFunilBmax).toBe(true);
    });

    it("buscarLead por CNPJ busca fresco (forcarIncremental) e calcula bloqueiaNovaNegociacao certo", async () => {
        const cardAberto = cardBase({
            id: "1", title: "Cliente Aberto",
            current_phase: { id: "x", name: "Leads Revenda" }, // BMAX — win null (não finalizado)
            fields: [{ field: { id: "cnpj" }, value: "12345678000199" }]
        });
        // CRM BOXER SOLDAS/"Venda Efetiva" mapeia pra RD_STAGE_VENDA_EFETIVADA —
        // a única etapa de venda que dealBloqueiaDuplicata (rd.leads.service.js)
        // reconhece como "não bloqueia" (RD_STAGE_VENDIDO, a etapa de venda do
        // BMAX, não está nessa lista — comportamento já existente, não mexido
        // aqui; por isso o card "vendido" deste teste usa o outro pipe).
        const cardVendido = cardBase({
            id: "2", title: "Cliente Vendido",
            current_phase: { id: "x", name: "Venda Efetiva" },
            fields: [{ field: { id: "cnpj" }, value: "12345678000199" }]
        });
        mockPipefyService({ "307242360": [cardVendido], "307397065": [cardAberto], "307397056": [], "307397042": [] });
        const { buscarLead } = require("./rd.leads.service");

        const resultado = await buscarLead("12.345.678/0001-99");

        expect(resultado.total).toBe(2);
        expect(resultado.bloqueiaNovaNegociacao).toBe(true); // pelo menos um aberto
        expect(resultado.resultados.find(r => r.nome === "Cliente Aberto").bloqueiaNovaNegociacao).toBe(true);
        expect(resultado.resultados.find(r => r.nome === "Cliente Vendido").bloqueiaNovaNegociacao).toBe(false);
    });
});

describe("pipefyLeads.service — traduz ID do RD em toda operação (Tarefa A1, 2º adendo)", () => {
    const RD_ID = "66151c1470449b000d54e919"; // 24 chars hex
    const CARD_ID = "444555";

    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    function mockBancoComMapa() {
        const query = jest.fn().mockImplementation((sql) =>
            sql.includes("bmax_rd_pipefy_map") ? Promise.resolve([{ pipefy_card_id: CARD_ID }]) : Promise.resolve([])); // já mapeado; sem transferência registrada
        jest.doMock("../database", () => ({ sequelize: { query } }));
        return query;
    }

    it("updateLeadPipefy resolve o ID do RD antes de chamar o Pipefy", async () => {
        mockBancoComMapa();
        const updateCardFieldsEmLote = jest.fn().mockResolvedValue({ success: true });
        const getCard = jest.fn().mockResolvedValue(null); // sem cache: cai no fallback "BMAX"
        jest.doMock("./pipefy.service", () => ({ updateCardFieldsEmLote, moveCardToPhase: jest.fn(), getCard }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await updateLeadPipefy(RD_ID, { data: { custom_fields: { "perfil-pci": "PCI 12a" } } });

        expect(updateCardFieldsEmLote).toHaveBeenCalledWith(CARD_ID, [{ campoId: "pci", valor: "PCI 12a" }]);
    });

    it("createTaskPipefy resolve taskData.deal_id (ID do RD) antes de chamar o Pipefy", async () => {
        mockBancoComMapa();
        const createComment = jest.fn().mockResolvedValue({ id: "c1" });
        const updateCardFieldsEmLote = jest.fn().mockResolvedValue({ success: true });
        const getCard = jest.fn().mockResolvedValue(null);
        jest.doMock("./pipefy.service", () => ({ createComment, updateCardFieldsEmLote, getCard }));
        const { createTaskPipefy } = require("./pipefyLeads.service");

        await createTaskPipefy({ deal_id: RD_ID, name: "Ligar" });

        expect(createComment).toHaveBeenCalledWith(CARD_ID, expect.stringContaining("Ligar"));
    });

    it("updateTaskPipefy resolve o ID do RD antes de chamar o Pipefy", async () => {
        mockBancoComMapa();
        const updateCardFieldsEmLote = jest.fn().mockResolvedValue({ success: true });
        const getCard = jest.fn().mockResolvedValue(null);
        jest.doMock("./pipefy.service", () => ({ updateCardFieldsEmLote, getCard }));
        const { updateTaskPipefy } = require("./pipefyLeads.service");

        await updateTaskPipefy({ subject: "x" }, RD_ID);

        expect(updateCardFieldsEmLote).toHaveBeenCalledWith(CARD_ID, expect.anything());
    });

    it("createNotePipefy resolve o ID do RD antes de chamar o Pipefy", async () => {
        mockBancoComMapa();
        const createComment = jest.fn().mockResolvedValue({ id: "c1" });
        jest.doMock("./pipefy.service", () => ({ createComment }));
        const { createNotePipefy } = require("./pipefyLeads.service");

        await createNotePipefy(RD_ID, "texto");

        expect(createComment).toHaveBeenCalledWith(CARD_ID, "texto");
    });

    it("getLeadNotesPipefy resolve o ID do RD antes de chamar o Pipefy", async () => {
        mockBancoComMapa();
        const getCardComments = jest.fn().mockResolvedValue([]);
        jest.doMock("./pipefy.service", () => ({ getCardComments }));
        const { getLeadNotesPipefy } = require("./pipefyLeads.service");

        await getLeadNotesPipefy(RD_ID);

        expect(getCardComments).toHaveBeenCalledWith(CARD_ID);
    });
});

describe("pipefyLeads.service — updateLeadPipefy ciente do pipe do card (Tarefa A3, 2º adendo)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    it("move um card do INDÚSTRIA - INTERNO pra fase certa (RD_STAGE_NEGOCIACAO -> NEGOCIAÇÃO)", async () => {
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");
        const moveCardToPhase = jest.fn().mockResolvedValue({ success: true });
        const getCard = jest.fn().mockResolvedValue(cardBase({ id: "1", pipe: { id: "307397025", name: "INDÚSTRIA - INTERNO" } }));
        jest.doMock("./pipefy.service", () => ({ moveCardToPhase, updateCardFieldsEmLote: jest.fn(), getCard }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await updateLeadPipefy("1", { data: { stage_id: RD_STAGE_NEGOCIACAO } });

        expect(moveCardToPhase).toHaveBeenCalledWith("1", "344500003"); // id da fase "NEGOCIAÇÃO" no fixture
    });

    it("move um card do BMAX pra 'Prazo Vencido' (não 'Perdido') quando a etapa é RD_STAGE_PERDIDO", async () => {
        const { RD_STAGE_PERDIDO } = require("../config/constants");
        const moveCardToPhase = jest.fn().mockResolvedValue({ success: true });
        const getCard = jest.fn().mockResolvedValue(cardBase({ id: "2", pipe: { id: "307397065", name: "BMAX" } }));
        jest.doMock("./pipefy.service", () => ({ moveCardToPhase, updateCardFieldsEmLote: jest.fn(), getCard }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await updateLeadPipefy("2", { data: { stage_id: RD_STAGE_PERDIDO } });

        expect(moveCardToPhase).toHaveBeenCalledWith("2", "344532517"); // id da fase "Prazo Vencido" no fixture
    });

    it("etapa do RD sem fase correspondente no pipe do card lança erro e não chama o Pipefy", async () => {
        const { RD_STAGE_LEAD } = require("../config/constants"); // não existe no BMAX
        const moveCardToPhase = jest.fn();
        const updateCardFieldsEmLote = jest.fn();
        const getCard = jest.fn().mockResolvedValue(cardBase({ id: "3", pipe: { id: "307397065", name: "BMAX" } }));
        jest.doMock("./pipefy.service", () => ({ moveCardToPhase, updateCardFieldsEmLote, getCard }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");

        await expect(updateLeadPipefy("3", { data: { stage_id: RD_STAGE_LEAD, custom_fields: { "perfil-pci": "PCI 12" } } }))
            .rejects.toThrow("sem fase correspondente");

        expect(moveCardToPhase).not.toHaveBeenCalled();
        expect(updateCardFieldsEmLote).not.toHaveBeenCalled();
    });
});

describe("pipefyLeads.service — transferência BOX+REV>IND pro CRM BOXER SOLDAS (Tarefa B1, 3º adendo 26/10/2026; destino atualizado na Fase 5)", () => {
    beforeEach(() => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    function cardOrigemBmax(overrides = {}) {
        return cardBase({
            id: "9001",
            title: "Empresa Alfa",
            pipe: { id: "307397065", name: "BMAX" },
            fields: [
                { field: { id: "pci" }, value: "PCI 5" },
                { field: { id: "cnpj" }, value: "11222333000144" },
                { field: { id: "valor_total" }, value: "1.234,56" },
                { field: { id: "data_de_cria_o_no_rd" }, value: "12/05/2026" }
            ],
            assignees: [{ id: "member1", name: "Carlos", email: "carlos@boxersoldas.com.br" }],
            ...overrides
        });
    }

    it("critério de aceite: cria o card no CRM BOXER SOLDAS na fase 'Negociação' com o PCI, move a origem pra 'Transferido para a Indústria' e grava a ligação", async () => {
        const cardOrigem = cardOrigemBmax();
        const getCard = jest.fn().mockImplementation((id) =>
            Promise.resolve(id === "9001" ? cardOrigem : cardBase({ id, pipe: { id: "307242360", name: "CRM BOXER SOLDAS" } })));
        const createCard = jest.fn().mockResolvedValue({ id: "novo1" });
        const createComment = jest.fn().mockResolvedValue({ id: "c" });
        const moveCardToPhase = jest.fn().mockResolvedValue({ success: true });
        const updateCardAssignees = jest.fn().mockResolvedValue({ success: true });
        const query = jest.fn().mockResolvedValue([]); // sem transferência registrada ainda; INSERT ok
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ getCard, createCard, createComment, moveCardToPhase, updateCardAssignees, updateCardFieldsEmLote: jest.fn() }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");

        const resultado = await updateLeadPipefy("9001", { data: { stage_id: RD_STAGE_NEGOCIACAO } });

        expect(createCard).toHaveBeenCalledWith(
            "307242360", // pipe CRM BOXER SOLDAS
            "343660997", // fase Negociação
            "Empresa Alfa",
            expect.arrayContaining([
                { field_id: "nome_fantasia", field_value: "Empresa Alfa" }, // "Título" apelidado — obrigatório nesse pipe
                { field_id: "cnpj", field_value: "11222333000144" },
                { field_id: "perfil_pci", field_value: "PCI 5" }
            ])
        );
        expect(moveCardToPhase).toHaveBeenCalledWith("9001", "344532599"); // "Transferido para a Indústria"
        expect(updateCardAssignees).toHaveBeenCalledWith("novo1", ["member1"]);
        expect(createComment).toHaveBeenCalledWith("9001", expect.stringContaining("novo1"));
        expect(createComment).toHaveBeenCalledWith("novo1", expect.stringContaining("9001"));

        const inserts = query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO bmax_pipefy_transferencias"));
        expect(inserts).toHaveLength(1);
        expect(inserts[0][1].replacements).toEqual({ origem: "9001", destino: "novo1" });

        expect(resultado).toEqual({ id: "novo1" });
    });

    // Achado real na conta (26/10/2026): `value` de um campo de CONEXÃO
    // (Contato/Empresa) traz os TÍTULOS dos registros ligados, não os IDs —
    // gravar isso de volta faz o Pipefy ignorar a conexão em silêncio. Os
    // IDs de verdade vêm de `connectedRepoItems[].id` (ou `array_value`
    // como reserva).
    it("card com Contato/Empresa conectados, databases DIFERENTES no destino (BMAX -> CRM BOXER SOLDAS): acha/cria o equivalente por e-mail/CNPJ", async () => {
        const cardOrigem = cardOrigemBmax({
            fields: [
                { field: { id: "cnpj" }, value: "11222333000144" },
                {
                    field: { id: "contato" }, name: "Contato", value: '["Fulano de Tal"]',
                    array_value: ["555111"],
                    connectedRepoItems: [{ __typename: "PublicTableRecord", id: "555111" }]
                },
                {
                    field: { id: "empresa" }, name: "Empresa", value: '["Empresa Alfa Ltda"]',
                    array_value: ["555222"],
                    connectedRepoItems: [{ __typename: "PublicTableRecord", id: "555222" }]
                }
            ]
        });
        const getCard = jest.fn().mockImplementation((id) =>
            Promise.resolve(id === "9001" ? cardOrigem : cardBase({ id, pipe: { id: "307242360", name: "CRM BOXER SOLDAS" } })));
        const createCard = jest.fn().mockResolvedValue({ id: "novo4" });
        const getTableRecord = jest.fn().mockImplementation((id) => Promise.resolve(
            id === "555111"
                ? { id, title: "Fulano de Tal", record_fields: [{ field: { id: "e_mail" }, value: "fulano@exemplo.com" }] }
                : { id, title: "Empresa Alfa Ltda", record_fields: [{ field: { id: "cnpj_empresa" }, value: "11222333000144" }] }
        ));
        const findContatoPorEmail = jest.fn().mockResolvedValue(null); // não existe ainda na base RD
        const createContato = jest.fn()
            .mockResolvedValueOnce({ id: "contatoRdNovo" })
            .mockResolvedValueOnce({ id: "empresaRdNovo" });
        jest.doMock("../database", () => ({ sequelize: { query: jest.fn().mockResolvedValue([]) } }));
        jest.doMock("./pipefy.service", () => ({
            getCard, createCard, getTableRecord, findContatoPorEmail, createContato,
            createComment: jest.fn().mockResolvedValue({}), moveCardToPhase: jest.fn().mockResolvedValue({}),
            updateCardAssignees: jest.fn(), updateCardFieldsEmLote: jest.fn()
        }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");

        await updateLeadPipefy("9001", { data: { stage_id: RD_STAGE_NEGOCIACAO } });

        expect(getTableRecord).toHaveBeenCalledWith("555111");
        expect(getTableRecord).toHaveBeenCalledWith("555222");
        expect(findContatoPorEmail).toHaveBeenCalledWith("contatosRdId", "e_mails_rd", "fulano@exemplo.com");
        expect(findContatoPorEmail).toHaveBeenCalledWith("empresasRdId", "cnpj_rd", "11222333000144");
        expect(createContato).toHaveBeenCalledWith("contatosRdId", "Fulano de Tal", expect.any(Array));
        expect(createContato).toHaveBeenCalledWith("empresasRdId", "Empresa Alfa Ltda", expect.any(Array));

        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados).toEqual(expect.arrayContaining([
            { field_id: "contatos", field_value: ["contatoRdNovo"] },
            { field_id: "empresa", field_value: ["empresaRdNovo"] }
        ]));
    });

    it("card sem Contato/Empresa conectados (só o título como value, sem connectedRepoItems/array_value): não envia esses campos", async () => {
        const cardOrigem = cardOrigemBmax({
            fields: [
                { field: { id: "cnpj" }, value: "11222333000144" },
                { field: { id: "contato" }, name: "Contato", value: "", array_value: null, connectedRepoItems: null }
            ]
        });
        const getCard = jest.fn().mockImplementation((id) =>
            Promise.resolve(id === "9001" ? cardOrigem : cardBase({ id, pipe: { id: "307242360", name: "CRM BOXER SOLDAS" } })));
        const createCard = jest.fn().mockResolvedValue({ id: "novo5" });
        jest.doMock("../database", () => ({ sequelize: { query: jest.fn().mockResolvedValue([]) } }));
        jest.doMock("./pipefy.service", () => ({
            getCard, createCard,
            createComment: jest.fn().mockResolvedValue({}), moveCardToPhase: jest.fn().mockResolvedValue({}),
            updateCardAssignees: jest.fn(), updateCardFieldsEmLote: jest.fn()
        }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");

        await updateLeadPipefy("9001", { data: { stage_id: RD_STAGE_NEGOCIACAO } });

        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "contatos")).toBeUndefined();
        expect(camposEnviados.find(c => c.field_id === "empresa")).toBeUndefined();
    });

    it("sem PCI no card de origem, envia 'Sem PCI' pro destino (opção adicionada ao campo, 19/11/2026)", async () => {
        const cardOrigem = cardOrigemBmax({ fields: [{ field: { id: "cnpj" }, value: "11222333000144" }] });
        const getCard = jest.fn().mockImplementation((id) =>
            Promise.resolve(id === "9001" ? cardOrigem : cardBase({ id, pipe: { id: "307242360", name: "CRM BOXER SOLDAS" } })));
        const createCard = jest.fn().mockResolvedValue({ id: "novo1" });
        jest.doMock("../database", () => ({ sequelize: { query: jest.fn().mockResolvedValue([]) } }));
        jest.doMock("./pipefy.service", () => ({
            getCard, createCard,
            createComment: jest.fn().mockResolvedValue({}), moveCardToPhase: jest.fn().mockResolvedValue({}),
            updateCardAssignees: jest.fn(), updateCardFieldsEmLote: jest.fn()
        }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");

        await updateLeadPipefy("9001", { data: { stage_id: RD_STAGE_NEGOCIACAO } });

        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados.find(c => c.field_id === "perfil_pci").field_value).toBe("Sem PCI");
    });

    it("converte 'Valor total' e 'Data de criação no RD' do formato BR do Pipefy pro formato interno antes de gravar no card novo", async () => {
        const cardOrigem = cardOrigemBmax({
            fields: [
                { field: { id: "valor_total" }, value: "1.234,56" },
                { field: { id: "data_de_cria_o_no_rd" }, value: "12/05/2026" }
            ]
        });
        const getCard = jest.fn().mockImplementation((id) =>
            Promise.resolve(id === "9001" ? cardOrigem : cardBase({ id, pipe: { id: "307242360", name: "CRM BOXER SOLDAS" } })));
        const createCard = jest.fn().mockResolvedValue({ id: "novo2" });
        jest.doMock("../database", () => ({ sequelize: { query: jest.fn().mockResolvedValue([]) } }));
        jest.doMock("./pipefy.service", () => ({
            getCard, createCard,
            createComment: jest.fn().mockResolvedValue({}), moveCardToPhase: jest.fn().mockResolvedValue({}),
            updateCardAssignees: jest.fn(), updateCardFieldsEmLote: jest.fn()
        }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");

        await updateLeadPipefy("9001", { data: { stage_id: RD_STAGE_NEGOCIACAO } });

        const camposEnviados = createCard.mock.calls[0][3];
        // "Data de criação no RD" é apelidado pro campo "Data de criação (RD)"
        // do CRM BOXER SOLDAS — id diferente do usado na origem (BMAX).
        expect(camposEnviados).toEqual(expect.arrayContaining([
            { field_id: "valor_total", field_value: "1234.56" },
            { field_id: "data_de_cria_o_rd", field_value: "2026-05-12" }
        ]));
    });

    it("sem 'Data de criação no RD' na origem (negociação nascida no Pipefy), usa o created_at do card (só a data)", async () => {
        const cardOrigem = cardOrigemBmax({
            created_at: "2026-03-10T14:00:00+00:00",
            fields: [{ field: { id: "cnpj" }, value: "11222333000144" }]
        });
        const getCard = jest.fn().mockImplementation((id) =>
            Promise.resolve(id === "9001" ? cardOrigem : cardBase({ id, pipe: { id: "307242360", name: "CRM BOXER SOLDAS" } })));
        const createCard = jest.fn().mockResolvedValue({ id: "novo3" });
        jest.doMock("../database", () => ({ sequelize: { query: jest.fn().mockResolvedValue([]) } }));
        jest.doMock("./pipefy.service", () => ({
            getCard, createCard,
            createComment: jest.fn().mockResolvedValue({}), moveCardToPhase: jest.fn().mockResolvedValue({}),
            updateCardAssignees: jest.fn(), updateCardFieldsEmLote: jest.fn()
        }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");

        await updateLeadPipefy("9001", { data: { stage_id: RD_STAGE_NEGOCIACAO } });

        const camposEnviados = createCard.mock.calls[0][3];
        expect(camposEnviados).toEqual(expect.arrayContaining([{ field_id: "data_de_cria_o_rd", field_value: "2026-03-10" }]));
    });

    it("se a criação do card novo falhar, nada mais acontece — origem não é movida, ligação não é gravada, erro sobe", async () => {
        const cardOrigem = cardOrigemBmax();
        const getCard = jest.fn().mockResolvedValue(cardOrigem);
        const createCard = jest.fn().mockRejectedValue(new Error("Pipefy fora do ar"));
        const createComment = jest.fn();
        const moveCardToPhase = jest.fn();
        const updateCardAssignees = jest.fn();
        const query = jest.fn().mockResolvedValue([]);
        jest.doMock("../database", () => ({ sequelize: { query } }));
        jest.doMock("./pipefy.service", () => ({ getCard, createCard, createComment, moveCardToPhase, updateCardAssignees, updateCardFieldsEmLote: jest.fn() }));
        const { updateLeadPipefy } = require("./pipefyLeads.service");
        const { RD_STAGE_NEGOCIACAO } = require("../config/constants");

        await expect(updateLeadPipefy("9001", { data: { stage_id: RD_STAGE_NEGOCIACAO } }))
            .rejects.toThrow("Pipefy fora do ar");

        expect(createComment).not.toHaveBeenCalled();
        expect(moveCardToPhase).not.toHaveBeenCalled();
        expect(updateCardAssignees).not.toHaveBeenCalled();
        const inserts = query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO bmax_pipefy_transferencias"));
        expect(inserts).toHaveLength(0);
    });
});

describe("rd.leads.service — rename/reatribuição de representante/revenda no Pipefy (Tarefa 9)", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.unmock("./rd.leads.service");
        process.env.CRM_PROVIDER = "pipefy";
        process.env.RD_CRM_TOKEN = "x";
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    afterEach(() => {
        delete process.env.CRM_PROVIDER;
    });

    it("renomearRepresentanteNoRD despacha pro Pipefy (nunca chama o RD) e varre só BMAX", async () => {
        const getStartFormFields = jest.fn().mockResolvedValue([{ id: "representante", uuid: "uuid-rep", label: "Representante", options: ["Antigo"] }]);
        const updatePhaseField = jest.fn().mockResolvedValue({ id: "representante", label: "Representante" });
        const findCardsByFieldValue = jest.fn().mockResolvedValue([{ id: "1" }, { id: "2" }]);
        const updateFieldEmVariosCards = jest.fn().mockResolvedValue({ success: true, atualizados: 2, falharam: 0 });
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField, findCardsByFieldValue, updateFieldEmVariosCards }));
        const { renomearRepresentanteNoRD } = require("./rd.leads.service");

        const resultado = await renomearRepresentanteNoRD("Antigo", "Novo");

        expect(findCardsByFieldValue).toHaveBeenCalledTimes(1);
        expect(findCardsByFieldValue).toHaveBeenCalledWith("307397065", "representante", "Antigo");
        expect(updatePhaseField).toHaveBeenCalledWith("representante", "uuid-rep", "Representante", ["Antigo", "Novo"]);
        expect(updateFieldEmVariosCards).toHaveBeenCalledWith("representante", "Novo", ["1", "2"]);
        expect(resultado).toEqual({ done: true, total: 2, updated: 2, failed: 0 });
    });

    // 3º adendo, 26/10/2026 (teste manual confirmou: updatePhaseField com
    // options SUBSTITUI a lista inteira — mandar a lista completa mantém as
    // antigas e não muda a obrigatoriedade do campo). Confirma que a
    // varredura sempre lê a lista ATUAL do campo (getStartFormFields) e
    // manda todas as opções de volta, não só a nova — com 3 opções
    // existentes, as outras 2 (não envolvidas no rename) continuam na lista
    // enviada.
    it("ao renomear uma opção num campo com três opções, as outras duas continuam na lista enviada", async () => {
        const getStartFormFields = jest.fn().mockResolvedValue([{ id: "representante", uuid: "uuid-rep", label: "Representante", options: ["Carlos", "Ana", "Bruno"] }]);
        const updatePhaseField = jest.fn().mockResolvedValue({});
        const findCardsByFieldValue = jest.fn().mockResolvedValue([{ id: "1" }]);
        const updateFieldEmVariosCards = jest.fn().mockResolvedValue({ success: true, atualizados: 1, falharam: 0 });
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField, findCardsByFieldValue, updateFieldEmVariosCards }));
        const { renomearRepresentanteNoRD } = require("./rd.leads.service");

        await renomearRepresentanteNoRD("Carlos", "Carlos Eduardo");

        expect(updatePhaseField).toHaveBeenCalledWith("representante", "uuid-rep", "Representante", ["Carlos", "Ana", "Bruno", "Carlos Eduardo"]);
    });

    it("não acrescenta a opção de novo se ela já existir no campo", async () => {
        const getStartFormFields = jest.fn().mockResolvedValue([{ id: "representante", uuid: "uuid-rep", label: "Representante", options: ["Antigo", "Novo"] }]);
        const updatePhaseField = jest.fn();
        const findCardsByFieldValue = jest.fn().mockResolvedValue([]);
        const updateFieldEmVariosCards = jest.fn();
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField, findCardsByFieldValue, updateFieldEmVariosCards }));
        const { renomearRepresentanteNoRD } = require("./rd.leads.service");

        await renomearRepresentanteNoRD("Antigo", "Novo");

        expect(updatePhaseField).not.toHaveBeenCalled();
    });

    it("renomearRevendaNoRD varre BMAX e REVENDA - INTERNO", async () => {
        const getStartFormFields = jest.fn().mockResolvedValue([{ id: "revenda_loja", uuid: "uuid-rev", label: "Revenda/Loja", options: ["Antiga"] }]);
        const updatePhaseField = jest.fn().mockResolvedValue({});
        const findCardsByFieldValue = jest.fn().mockResolvedValue([{ id: "9" }]);
        const updateFieldEmVariosCards = jest.fn().mockResolvedValue({ success: true, atualizados: 1, falharam: 0 });
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField, findCardsByFieldValue, updateFieldEmVariosCards }));
        const { renomearRevendaNoRD } = require("./rd.leads.service");

        const resultado = await renomearRevendaNoRD("Antiga", "Nova");

        expect(findCardsByFieldValue).toHaveBeenCalledWith("307397065", "revenda_loja", "Antiga"); // BMAX
        expect(findCardsByFieldValue).toHaveBeenCalledWith("307397056", "revenda_loja", "Antiga"); // REVENDA - INTERNO
        expect(resultado).toEqual({ done: true, total: 2, updated: 2, failed: 0 });
    });

    // Tarefa C1 (2º adendo, 23/10/2026): antes, esse teste mockava
    // sbSistemasService como `{}` (não uma função) — getAliasMaps real caía
    // no catch, devolvia mapas vazios, e repNoRd virava sempre o próprio
    // `novoRep` sem passar pela tradução de verdade. Agora mocka
    // sbSistemasService como função de verdade, com um representante cujo
    // nome de cadastro difere do alias usado no RD (mesmo exemplo real
    // documentado em rd.leads.service.js: "Caio P Mancini" -> RD "Caio
    // Tito") — prova que a tradução nome->alias realmente acontece.
    it("reatribuirRepresentanteDaRevendaNoRD traduz o nome de cadastro pro alias do RD antes de gravar", async () => {
        const getStartFormFields = jest.fn().mockResolvedValue([{ id: "representante", uuid: "uuid-rep", label: "Representante", options: [] }]);
        const updatePhaseField = jest.fn().mockResolvedValue({});
        const findCardsByFieldValue = jest.fn().mockResolvedValue([{ id: "5" }]);
        const updateFieldEmVariosCards = jest.fn().mockResolvedValue({ success: true, atualizados: 1, falharam: 0 });
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField, findCardsByFieldValue, updateFieldEmVariosCards }));
        const sbSistemasService = jest.fn().mockResolvedValue([
            { nome: "Caio P Mancini", email: "caio@boxersoldas.com.br", rd_alias: "Caio Tito", ativo: true }
        ]);
        jest.doMock("../config/supabaseSistemas", () => ({ sbSistemasAnon: {}, sbSistemasService }));
        const { reatribuirRepresentanteDaRevendaNoRD } = require("./rd.leads.service");

        await reatribuirRepresentanteDaRevendaNoRD("Revenda X", "Caio P Mancini");

        expect(findCardsByFieldValue).toHaveBeenCalledWith("307397065", "revenda_loja", "Revenda X");
        // grava o ALIAS do RD ("Caio Tito"), não o nome de cadastro recebido
        expect(updateFieldEmVariosCards).toHaveBeenCalledWith("representante", "Caio Tito", ["5"]);
    });

    it("dryRun só conta, sem chamar updatePhaseField/updateFieldEmVariosCards", async () => {
        const getStartFormFields = jest.fn();
        const updatePhaseField = jest.fn();
        const findCardsByFieldValue = jest.fn().mockResolvedValue([{ id: "1" }, { id: "2" }]);
        const updateFieldEmVariosCards = jest.fn();
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField, findCardsByFieldValue, updateFieldEmVariosCards }));
        const { renomearRepresentanteNoRD } = require("./rd.leads.service");

        const resultado = await renomearRepresentanteNoRD("Antigo", "Novo", { dryRun: true });

        expect(updatePhaseField).not.toHaveBeenCalled();
        expect(updateFieldEmVariosCards).not.toHaveBeenCalled();
        expect(resultado).toEqual({ done: true, total: 2, updated: 0, failed: 0, dryRun: true }); // só BMAX é varrido por renomearRepresentanteNoRD
    });
});

describe("rd.leads.service — sincronismo de picklist revenda/representante no Pipefy (Fase 6)", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.unmock("./rd.leads.service");
        process.env.CRM_PROVIDER = "pipefy";
        process.env.RD_CRM_TOKEN = "x";
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
    });

    afterEach(() => {
        delete process.env.CRM_PROVIDER;
    });

    it("syncRepresentantesToRD une a lista nova com as opções atuais de BMAX e CRM BOXER SOLDAS, uma escrita por pipe", async () => {
        const getStartFormFields = jest.fn()
            .mockResolvedValueOnce([{ id: "representante", uuid: "uuid-rep-bmax", label: "Representante", options: ["Carlos"] }])
            .mockResolvedValueOnce([{ id: "representante", uuid: "uuid-rep-crm", label: "Representante", options: ["Ana"] }]);
        const updatePhaseField = jest.fn().mockResolvedValue({});
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField }));
        const { syncRepresentantesToRD } = require("./rd.leads.service");

        const resultado = await syncRepresentantesToRD(["Bruno"]);

        expect(getStartFormFields).toHaveBeenCalledWith("307397065"); // BMAX
        expect(getStartFormFields).toHaveBeenCalledWith("307242360"); // CRM BOXER SOLDAS
        expect(updatePhaseField).toHaveBeenCalledWith("representante", "uuid-rep-bmax", "Representante", ["Carlos", "Bruno", "N/D"]);
        expect(updatePhaseField).toHaveBeenCalledWith("representante", "uuid-rep-crm", "Representante", ["Ana", "Bruno", "N/D"]);
        expect(resultado).toEqual({
            done: true,
            porPipe: [
                { nomePipe: "BMAX", synced: 3, adicionados: 2, fieldId: "representante" },
                { nomePipe: "CRM BOXER SOLDAS", synced: 3, adicionados: 2, fieldId: "representante" }
            ]
        });
    });

    it("syncRevendasToRD varre BMAX, REVENDA - INTERNO e CRM BOXER SOLDAS, traduzindo 'Sem Revenda' só no CRM BOXER SOLDAS", async () => {
        const getStartFormFields = jest.fn()
            .mockResolvedValueOnce([{ id: "revenda_loja", uuid: "uuid-rev-bmax", label: "Revenda/Loja", options: [] }])
            .mockResolvedValueOnce([{ id: "revenda_loja", uuid: "uuid-rev-rev", label: "Revenda/Loja", options: [] }])
            .mockResolvedValueOnce([{ id: "revenda_loja", uuid: "uuid-rev-crm", label: "Revenda/Loja", options: [] }]);
        const updatePhaseField = jest.fn().mockResolvedValue({});
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField }));
        const { syncRevendasToRD } = require("./rd.leads.service");

        await syncRevendasToRD(["Via Soldas"]);

        expect(updatePhaseField).toHaveBeenCalledWith("revenda_loja", "uuid-rev-bmax", "Revenda/Loja", ["Via Soldas", "Sem Revenda"]);
        expect(updatePhaseField).toHaveBeenCalledWith("revenda_loja", "uuid-rev-rev", "Revenda/Loja", ["Via Soldas", "Sem Revenda"]);
        // CRM BOXER SOLDAS: grafia traduzida (revendaParaPipefy), minúsculo
        expect(updatePhaseField).toHaveBeenCalledWith("revenda_loja", "uuid-rev-crm", "Revenda/Loja", ["Via Soldas", "Sem revenda"]);
    });

    it("não escreve de novo num pipe se todos os nomes já existirem (case/trim-insensitive)", async () => {
        const getStartFormFields = jest.fn()
            .mockResolvedValueOnce([{ id: "representante", uuid: "uuid-rep-bmax", label: "Representante", options: ["Bruno", "N/D"] }])
            .mockResolvedValueOnce([{ id: "representante", uuid: "uuid-rep-crm", label: "Representante", options: ["bruno ", " N/D"] }]);
        const updatePhaseField = jest.fn();
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField }));
        const { syncRepresentantesToRD } = require("./rd.leads.service");

        const resultado = await syncRepresentantesToRD(["Bruno"]);

        expect(updatePhaseField).not.toHaveBeenCalled();
        expect(resultado.porPipe.every(p => p.adicionados === 0)).toBe(true);
    });

    it("pipe sem o campo no formulário inicial não derruba os outros — marcado como skipped", async () => {
        const getStartFormFields = jest.fn()
            .mockResolvedValueOnce([]) // BMAX: campo não encontrado no formulário
            .mockResolvedValueOnce([{ id: "representante", uuid: "uuid-rep-crm", label: "Representante", options: [] }]);
        const updatePhaseField = jest.fn().mockResolvedValue({});
        jest.doMock("./pipefy.service", () => ({ getStartFormFields, updatePhaseField }));
        const { syncRepresentantesToRD } = require("./rd.leads.service");

        const resultado = await syncRepresentantesToRD(["Bruno"]);

        expect(resultado.porPipe[0]).toEqual({ nomePipe: "BMAX", skipped: true });
        expect(updatePhaseField).toHaveBeenCalledTimes(1);
    });
});

describe("rd.leads.service — despacho de tarefas/notas pro Pipefy (Tarefa 7)", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.unmock("./rd.leads.service"); // um describe anterior mockou este módulo
        process.env.CRM_PROVIDER = "pipefy";
        process.env.RD_CRM_TOKEN = "x";
    });

    afterEach(() => {
        delete process.env.CRM_PROVIDER;
    });

    it("createTask em modo pipefy nunca chama o RD", async () => {
        const createTaskPipefy = jest.fn().mockResolvedValue({ skipped: false });
        jest.doMock("./pipefyLeads.service", () => ({ createTaskPipefy }));
        const { createTask } = require("./rd.leads.service");

        await createTask({ deal_id: "123", name: "Tarefa" });

        expect(createTaskPipefy).toHaveBeenCalledWith({ deal_id: "123", name: "Tarefa" });
    });

    it("createNote em modo pipefy nunca chama o RD", async () => {
        const createNotePipefy = jest.fn().mockResolvedValue({ id: "c1" });
        jest.doMock("./pipefyLeads.service", () => ({ createNotePipefy }));
        const { createNote } = require("./rd.leads.service");

        await createNote("123", "texto");

        expect(createNotePipefy).toHaveBeenCalledWith("123", "texto");
    });

    it("getLeadNotes em modo pipefy nunca chama o RD", async () => {
        const getLeadNotesPipefy = jest.fn().mockResolvedValue({ data: [] });
        jest.doMock("./pipefyLeads.service", () => ({ getLeadNotesPipefy }));
        const { getLeadNotes } = require("./rd.leads.service");

        await getLeadNotes("123");

        expect(getLeadNotesPipefy).toHaveBeenCalledWith("123");
    });

    it("updateTask em modo pipefy nunca chama o RD", async () => {
        const updateTaskPipefy = jest.fn().mockResolvedValue({ id: "123" });
        jest.doMock("./pipefyLeads.service", () => ({ updateTaskPipefy }));
        const { updateTask } = require("./rd.leads.service");

        await updateTask({ subject: "x" }, "123");

        expect(updateTaskPipefy).toHaveBeenCalledWith({ subject: "x" }, "123");
    });
});

describe("Nova Negociação: etiqueta do funil (25/11/2026)", () => {
    beforeEach(() => { jest.resetModules(); jest.unmock("./pipefyLeads.service"); process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE); });
    const labels = [{ id: "lbl-ind", name: "RD: Indústria" }, { id: "lbl-bmax", name: "RD: BMAX" }, { id: "lbl-sdr", name: "RD: SDR" }];
    function carregar(getPipeLabels) {
        const createCard = jest.fn().mockResolvedValue({ id: "1" });
        jest.doMock("./pipefy.service", () => ({ createCard, getPipeLabels, allCardsInPipe: jest.fn(), getCard: jest.fn().mockResolvedValue(null), findContatoPorEmail: jest.fn().mockResolvedValue({ id: "x" }), createContato: jest.fn() }));
        const mod = require("./pipefyLeads.service");
        if (!mod.createLeadPipefy) throw new Error("exports: " + Object.keys(mod).join(","));
        return { createCard, createLeadPipefy: mod.createLeadPipefy };
    }
    it("revenda que vende sozinha (BOX>REV) cria no CRM com a etiqueta RD: BMAX", async () => {
        const { createCard, createLeadPipefy } = carregar(jest.fn().mockResolvedValue(labels));
        await createLeadPipefy({ nome: "Cliente BMAX", cnpj: "11222333000144", role: "revenda", caminho: "BOX>REV", atendimento: "revenda" });
        expect(createCard.mock.calls[0][0]).toBe("307242360");
        expect(createCard.mock.calls[0][4]).toEqual(["lbl-bmax"]);
    });
    it("Boxer atende (BOX+REV>IND) cria no CRM com a etiqueta RD: Indústria", async () => {
        const { createCard, createLeadPipefy } = carregar(jest.fn().mockResolvedValue(labels));
        await createLeadPipefy({ nome: "Cliente IND", cnpj: "11222333000144", role: "revenda", caminho: "BOX+REV>IND", atendimento: "boxer" });
        expect(createCard.mock.calls[0][4]).toEqual(["lbl-ind"]);
    });
    it("lead Indústria do admin/representante (funil industria) leva RD: Indústria", async () => {
        const { createCard, createLeadPipefy } = carregar(jest.fn().mockResolvedValue(labels));
        await createLeadPipefy({ nome: "Cliente 12", cnpj: "11222333000144", role: "representante", funil: "industria" });
        expect(createCard.mock.calls[0][4]).toEqual(["lbl-ind"]);
    });
    it("etiqueta inexistente no pipe: falha ALTO e não cria card sem etiqueta", async () => {
        const { createCard, createLeadPipefy } = carregar(jest.fn().mockResolvedValue([{ id: "lbl-sdr", name: "RD: SDR" }]));
        await expect(createLeadPipefy({ nome: "Cliente", cnpj: "11222333000144", role: "revenda", caminho: "BOX>REV", atendimento: "revenda" })).rejects.toThrow(/etiqueta/i);
        expect(createCard).not.toHaveBeenCalled();
    });
});

describe("Portal só considera cards com a etiqueta RD: Indústria", () => {
    it("ehFunilPortal", () => {
        jest.resetModules(); jest.unmock("./rd.leads.service"); jest.doMock("./pipefy.service", () => ({}));
        const { ehFunilPortal } = require("./rd.leads.service");
        expect(ehFunilPortal({ etiquetas: ["RD: Indústria"] })).toBe(true);
        for (const e of [["RD: BMAX"], ["RD: SDR"], ["RD: Revenda"], [], ["Qualificado"]]) expect(ehFunilPortal({ etiquetas: e })).toBe(false);
        expect(ehFunilPortal({})).toBe(true);   // leitura do RD (sem etiquetas): o funil já vem filtrado
    });
});
describe("dono do RD x responsável do Pipefy (troca de responsável do PCI12)", () => {
    const C = require("../config/constants");
    it("André, Carlos, Max e Lucas Ferreira têm e-mail de membro e voltam ao ID do dono do RD", () => {
        for (const [chave, mail] of Object.entries(C.PIPEFY_EMAIL_POR_DONO_RD)) expect(C.donoRdPorEmail(mail)).toBe(C.RD_OWNERS[chave]);
        expect(C.donoRdPorEmail("ANDRE.COELHO@boxersoldas.com.br")).toBe(C.RD_OWNERS["Revenda"]);
        expect(C.EMAIL_ANDRE).toBe("andre.coelho@boxersoldas.com.br");
    });
    it("responsável fora dos donos mapeados não tem ID de dono (null)", () => {
        expect(C.donoRdPorEmail("marketing@boxersoldas.com.br")).toBeNull();
        expect(C.donoRdPorEmail("")).toBeNull();
    });
    it("cardParaDealFake preenche user.id com o dono do RD quando o responsável é André", () => {
        jest.resetModules();
        process.env.PIPEFY_MAPA_JSON = JSON.stringify(MAPA_TESTE);
        const { cardParaDealFake } = require("./pipefyLeads.service");
        const C2 = require("../config/constants");
        const deal = cardParaDealFake(cardBase({ assignees: [{ id: "1", name: "André Coelho", email: "andre.coelho@boxersoldas.com.br" }] }), "BMAX");
        expect(deal.user.id).toBe(C2.RD_OWNERS["Revenda"]);
        const outro = cardParaDealFake(cardBase({ assignees: [{ id: "2", name: "Goy Almeida", email: "marketing@boxersoldas.com.br" }] }), "BMAX");
        expect(outro.user.id).toBeUndefined();
        expect(outro.user.email).toBe("marketing@boxersoldas.com.br");
    });
});
