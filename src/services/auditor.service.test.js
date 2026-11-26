jest.mock("../database", () => ({ sequelize: { query: jest.fn() } }));
jest.mock("./email.service", () => ({ sendEmail: jest.fn() }));
jest.mock("./roboMonitor.service", () => ({ ESPERADOS: { "robo-a": 30 }, LIM_CREDITOS_24H: 40, LIM_VALOR_24H: 25000 }));

const { reconciliar, montarEmail, CHECAGENS } = require("./auditor.service");

const ach = (chave, checagem = "saldo_vs_razao", extra = {}) => ({ chave, checagem, grupo: "dinheiro", severidade: "media", titulo: `t ${chave}`, ...extra });
const aberto = (chave, checagem = "saldo_vs_razao", ultimoAviso = null) => ({ chave, checagem, grupo: "dinheiro", titulo: `t ${chave}`, ultimo_aviso_em: ultimoAviso });
const AGORA = new Date("2026-11-25T12:00:00Z");
const diasAtras = n => new Date(AGORA.getTime() - n * 86400000).toISOString();

describe("reconciliar: o que é novo, o que continua e o que foi resolvido", () => {
    test("achado que não estava aberto é NOVO e vai para o e-mail", () => {
        const r = reconciliar([ach("a")], [], ["saldo_vs_razao"], AGORA);
        expect(r.novos.map(x => x.chave)).toEqual(["a"]);
        expect(r.paraAvisar.map(x => x.chave)).toEqual(["a"]);
    });

    test("achado que continua aberto e foi avisado há pouco NÃO volta ao e-mail", () => {
        const r = reconciliar([ach("a")], [aberto("a", "saldo_vs_razao", diasAtras(2))], ["saldo_vs_razao"], AGORA);
        expect(r.persistentes).toHaveLength(1);
        expect(r.novos).toHaveLength(0);
        expect(r.paraAvisar).toHaveLength(0);
    });

    test("achado aberto avisado há 7 dias ou mais volta como lembrete semanal", () => {
        const r = reconciliar([ach("a")], [aberto("a", "saldo_vs_razao", diasAtras(8))], ["saldo_vs_razao"], AGORA);
        expect(r.lembretes.map(x => x.chave)).toEqual(["a"]);
        expect(r.paraAvisar.map(x => x.chave)).toEqual(["a"]);
    });

    test("achado aberto que nunca chegou a ser avisado também entra", () => {
        const r = reconciliar([ach("a")], [aberto("a", "saldo_vs_razao", null)], ["saldo_vs_razao"], AGORA);
        expect(r.paraAvisar).toHaveLength(1);
    });

    test("achado que sumiu é RESOLVIDO quando a checagem rodou bem", () => {
        const r = reconciliar([], [aberto("a")], ["saldo_vs_razao"], AGORA);
        expect(r.resolvidos.map(x => x.chave)).toEqual(["a"]);
        expect(r.paraAvisar).toHaveLength(0);   // só resolvido não gera e-mail
    });

    test("checagem que FALHOU ao rodar nunca resolve os achados dela", () => {
        const r = reconciliar([], [aberto("a", "saldo_vs_razao")], ["creditos_anormais"], AGORA);
        expect(r.resolvidos).toHaveLength(0);
    });

    test("achado 'checagem falhou' é resolvido quando aquela checagem volta a rodar bem", () => {
        const falhou = aberto("auditor_checagem_falhou:saldo_vs_razao", "auditor_checagem_falhou");
        expect(reconciliar([], [falhou], ["auditor_checagem_falhou:saldo_vs_razao"], AGORA).resolvidos).toHaveLength(1);
        expect(reconciliar([], [falhou], ["auditor_checagem_falhou:robos"], AGORA).resolvidos).toHaveLength(0);
    });

    test("sem nenhum achado e nada aberto: silêncio total (nenhum e-mail)", () => {
        const r = reconciliar([], [], ["saldo_vs_razao"], AGORA);
        expect(r.paraAvisar).toHaveLength(0);
        expect(r.resolvidos).toHaveLength(0);
    });
});

describe("e-mail do auditor", () => {
    test("traz novos, lembretes e resolvidos, agrupados, sem deixar HTML injetado passar", () => {
        const { assunto, html } = montarEmail({
            novos: [ach("a", "x", { titulo: 'Carteira "<b>X</b>" difere', acao: "conferir", link: "https://exemplo.com/c" })],
            lembretes: [ach("b")], resolvidos: [aberto("c")], abertosTotal: 2,
        });
        expect(assunto).toContain("1 novo(s)");
        expect(assunto).toContain("2 em aberto");
        expect(html).toContain("Novos (1)");
        expect(html).toContain("Continuam abertos (lembrete semanal) (1)");
        expect(html).toContain("Resolvidos desde a última rodada (1)");
        expect(html).toContain("&lt;b&gt;X&lt;/b&gt;");
        expect(html).not.toContain("<b>X</b>");
        expect(html).toContain("nunca corrige nada");
    });
});

describe("checagens de cards (com contexto falso)", () => {
    const C = require("../config/constants");
    const { checarVendaSemDados, checarPciXProduto, checarMudancasCampos, checarPci12aSemResposta } = require("./auditor.service");
    const card = (o = {}) => ({ id: "100", rdId: null, nome: "Card", pci: "PCI 6", segmento: "Laser", classe: "Classe 3", revenda: "Luitex", representante: "Victor", maquina: "", valor: 1000, etapaId: C.RD_STAGE_VENDIDO, criadoEm: null, deal: {}, ...o });
    const ctxCom = (cards, db = {}, extra = {}) => ({ dryRun: false, avisos: [], cards: async () => cards, db, desfechoDoCard: () => null, ...extra });

    test("venda sem PCI e classe vira achado ALTO; venda completa e card aberto não", async () => {
        const r = await checarVendaSemDados(ctxCom([card({ id: "1", pci: "Sem PCI", classe: "" }), card({ id: "2" }), card({ id: "3", pci: "", etapaId: "outra" })]));
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ chave: "venda_sem_dados:1", severidade: "alta" });
        expect(r[0].titulo).toContain("PCI, Classe de preço");
    });

    test("só revenda faltando: gravidade média", async () => {
        const r = await checarVendaSemDados(ctxCom([card({ id: "1", revenda: "?????" })]));
        expect(r[0].severidade).toBe("media");
    });

    test("PCI x produto: acusa incompatível e ignora o que combina", async () => {
        const r = await checarPciXProduto(ctxCom([card({ id: "1", pci: "PCI 13", segmento: "Laser" }), card({ id: "2" })]));
        expect(r.map(a => a.chave)).toEqual(["pci_x_produto:1"]);
        expect(r[0].severidade).toBe("media");
    });

    test("mudanças: 1ª rodada só grava a linha de base e não acusa nada", async () => {
        const gravar = jest.fn();
        const r = await checarMudancasCampos(ctxCom([card({ id: "1" })], { snapshot: async () => new Map(), gravar }));
        expect(r).toEqual([]);
        expect(gravar).toHaveBeenCalledWith([], [expect.objectContaining({ card_id: "1", pci: "PCI6" })]);
    });

    test("mudanças: PCI trocado em venda já creditada é ALTO e grava a mudança", async () => {
        const gravar = jest.fn();
        const db = {
            snapshot: async () => new Map([["1", { card_id: "1", pci: "PCI9", produto: "laser", classe: "3" }]]),
            creditados: async () => new Set(["1"]), gravar, mudancasRecentes: async () => [],
        };
        await checarMudancasCampos(ctxCom([card({ id: "1" })], db));
        const mud = gravar.mock.calls[0][0];
        expect(mud).toEqual([expect.objectContaining({ card_id: "1", campo: "pci", antes: "PCI9", depois: "PCI6", severidade: "alta" })]);
    });

    test("mudanças: sem alteração não grava nem acusa", async () => {
        const gravar = jest.fn();
        const db = { snapshot: async () => new Map([["1", { card_id: "1", pci: "PCI6", produto: "laser", classe: "3" }]]), creditados: async () => new Set(), gravar, mudancasRecentes: async () => [] };
        expect(await checarMudancasCampos(ctxCom([card({ id: "1" })], db))).toEqual([]);
        expect(gravar).not.toHaveBeenCalled();
    });

    test("mudanças em simulação: não grava nada, mas mostra a mudança", async () => {
        const gravar = jest.fn();
        const db = { snapshot: async () => new Map([["1", { card_id: "1", pci: "PCI9", produto: "laser", classe: "3" }]]), creditados: async () => new Set(), gravar, mudancasRecentes: async () => [] };
        const r = await checarMudancasCampos(ctxCom([card({ id: "1" })], db, { dryRun: true }));
        expect(gravar).not.toHaveBeenCalled();
        expect(r).toHaveLength(1);
    });

    test("PCI12a sem resposta: agrupa por revenda, casa os dois ids e ignora quem já respondeu ou tem desfecho", async () => {
        const c = (o) => card({ pci: "PCI 12a", etapaId: "x", ...o });
        const cards = [c({ id: "1", rdId: "rd1" }), c({ id: "2" }), c({ id: "3", rdId: "rd3" }), c({ id: "4" })];
        const db = {
            prazos12a: async () => new Map([["rd1", { assumido_em: new Date(Date.now() - 40 * 86400000) }], ["4", { resultado: "venda" }]]),
            andamentos: async () => new Map([["rd3", { tipo: "status", status: "Em contato" }]]),
        };
        const r = await checarPci12aSemResposta(ctxCom(cards, db));
        expect(r).toHaveLength(1);
        expect(r[0].detalhe).toMatchObject({ revenda: "Luitex", total: 2, maisAntigoDias: 40 });
    });

    test("PCI12 com responsável errado: acusa aberto, ignora vendido e o que está com André", async () => {
        const { checarPci12Responsavel } = require("./auditor.service");
        const r = await checarPci12Responsavel(ctxCom([
            card({ id: "1", pci: "PCI 12a", etapaId: "x", responsavel: "Carlos Alberto Fernandes" }),
            card({ id: "2", pci: "PCI 12a", etapaId: "x", responsavel: "André Coelho" }),
            card({ id: "3", pci: "PCI 12", etapaId: C.RD_STAGE_VENDIDO, responsavel: "Carlos Alberto Fernandes" }),
            card({ id: "4", pci: "PCI 6", etapaId: "x", responsavel: "Carlos Alberto Fernandes" }),
        ]));
        expect(r.map(a => a.chave)).toEqual(["pci12_responsavel:1", "pci12_em_venda:3"]);
        expect(r[0].severidade).toBe("media");
    });

    test("achados de card trazem o nome do responsável no título", async () => {
        const { checarVendaSemDados } = require("./auditor.service");
        const r = await checarVendaSemDados(ctxCom([
            card({ id: "1", pci: "", etapaId: C.RD_STAGE_VENDIDO, valor: 100, responsavel: "Carlos Alberto Fernandes" }),
            card({ id: "2", pci: "", etapaId: C.RD_STAGE_VENDIDO, valor: 100, responsavel: "" }),
        ]));
        expect(r[0].titulo).toContain("· responsável: Carlos Alberto Fernandes");
        expect(r[1].titulo).toContain("· responsável: (ninguém)");
    });

    test("vendido: PCI12 puro é erro de PCI; 12b com vendedor Boxer e 12a com André ficam como estão", async () => {
        const { checarPci12Responsavel } = require("./auditor.service");
        const r = await checarPci12Responsavel(ctxCom([
            card({ id: "1", pci: "PCI 12b", etapaId: C.RD_STAGE_VENDIDO, responsavel: "Carlos Alberto Fernandes" }),
            card({ id: "2", pci: "PCI 12a", etapaId: C.RD_STAGE_VENDIDO, responsavel: "André Coelho" }),
            card({ id: "3", pci: "PCI 12", etapaId: C.RD_STAGE_VENDIDO, responsavel: "" }),
        ]));
        expect(r.map(a => a.chave)).toEqual(["pci12_em_venda:3"]);
        expect(r[0].titulo).toContain("PCI12a ou PCI12b");
    });

    test("e-mail traz o bloco de cobrança por representante e por revenda, e corta listas longas", () => {
        const cobranca = { chave: "p:Luitex", grupo: "prazos", checagem: "pci12a_sem_resposta", severidade: "media", titulo: "Luitex",
            detalhe: { revenda: "Luitex", total: 3, maisAntigoDias: 55, representantes: { Victor: 2, Caio: 1 },
                cards: [{ id: "11", nome: "Card A", dias: 55, representante: "Victor" }, { id: "12", nome: "Card B", dias: 10, representante: "Victor" }, { id: "13", nome: "Card C", dias: 5, representante: "Caio" }] } };
        const muitos = Array.from({ length: 20 }, (_, i) => ach(`v${i}`, "venda_sem_dados", { grupo: "cards" }));
        const { html } = montarEmail({ novos: [cobranca, ...muitos], lembretes: [], resolvidos: [], abertosTotal: 21, atuais: [cobranca] });
        expect(html).toContain("Por representante");
        expect(html).toContain("Victor</strong>: 2 card(s)");
        expect(html).toContain("https://app.pipefy.com/open-cards/11");   // cada card da cobrança tem link
        expect(html).toContain("perto dos 60 dias");
        expect(html).toContain("e mais 8 do mesmo tipo");
    });
});

describe("rodada do auditor que não aconteceu", () => {
    const { checarRodadaPerdida } = require("./auditor.service");
    const ctx = (rodada, horasAtras, dryRun = false) => ({ rodada, dryRun, db: { ultimaRodadaAgendada: async () => horasAtras == null ? null : new Date(Date.now() - horasAtras * 3600000) } });
    test("intervalo normal (17h) não acusa; 30h acusa", async () => {
        expect(await checarRodadaPerdida(ctx("manha", 17))).toEqual([]);
        const r = await checarRodadaPerdida(ctx("tarde", 30));
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ checagem: "auditor_rodada_perdida", severidade: "media" });
    });
    test("primeira rodada agendada, rodada manual e simulação nunca acusam", async () => {
        expect(await checarRodadaPerdida(ctx("manha", null))).toEqual([]);
        expect(await checarRodadaPerdida(ctx("manual", 30))).toEqual([]);
        expect(await checarRodadaPerdida(ctx("manha", 30, true))).toEqual([]);
    });
});

describe("ordem dos temas no e-mail", () => {
    test("dinheiro, robôs, vendas sem dados, mudanças, PCI x produto e cobrança, nessa ordem, e gravidade alta antes", () => {
        const mk = (checagem, sev, t) => ({ chave: checagem + t, checagem, grupo: "x", severidade: sev, titulo: t });
        const { html } = montarEmail({ novos: [mk("pci_x_produto", "media", "P"), mk("venda_sem_dados", "media", "VM"), mk("venda_sem_dados", "alta", "VA"), mk("robo_sem_sucesso", "alta", "R"), mk("saldo_vs_razao", "alta", "S")], lembretes: [], resolvidos: [], abertosTotal: 5 });
        const pos = t => html.indexOf(t);
        expect(pos("Saldo diferente")).toBeLessThan(pos("Robôs sem sucesso"));
        expect(pos("Robôs sem sucesso")).toBeLessThan(pos("Vendas com dados faltando"));
        expect(pos("Vendas com dados faltando")).toBeLessThan(pos("PCI que não combina"));
        expect(pos("VA")).toBeLessThan(pos("VM"));
    });
});

describe("registro das checagens", () => {
    test("cada checagem declara o que cobre e ids são únicos", () => {
        const ids = CHECAGENS.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const c of CHECAGENS) { expect(Array.isArray(c.cobre) && c.cobre.length > 0).toBe(true); expect(typeof c.roda).toBe("function"); }
    });
});
