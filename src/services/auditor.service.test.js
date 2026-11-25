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

describe("registro das checagens", () => {
    test("cada checagem declara o que cobre e ids são únicos", () => {
        const ids = CHECAGENS.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const c of CHECAGENS) { expect(Array.isArray(c.cobre) && c.cobre.length > 0).toBe(true); expect(typeof c.roda).toBe("function"); }
    });
});
