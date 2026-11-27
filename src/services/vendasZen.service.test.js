const { avaliarVenda, avaliarVendas, ehTeste, produtoCompativel } = require("./vendasZen.service");
const C = require("../config/constants");

const card = (o = {}) => ({ id: "1", nome: "Cliente", cnpj: "11222333000181", valor: 10000, criadoEm: "2026-11-01", fechadoEm: "2026-11-10", ...o });
const nf = (numero, total, data = "2026-11-10") => ({ numero, total, data });

describe("avaliarVenda", () => {
    test("nota de valor igual confirma", () => {
        expect(avaliarVenda(card(), [nf("1", 10000)]).estado).toBe("ok");
    });
    test("soma de notas do mesmo pedido confirma", () => {
        const r = avaliarVenda(card(), [nf("1", 6000), nf("2", 4000), nf("3", 999)]);
        expect(r.estado).toBe("ok_soma");
        expect(r.nota).toBe("1 + 2");
    });
    test("até 1% de diferença é aceita", () => {
        expect(avaliarVenda(card(), [nf("1", 10090)]).estado).toBe("ok");
        expect(avaliarVenda(card(), [nf("1", 9910)]).estado).toBe("ok");
    });
    test("acima de 1% e até 4% é erro e traz valor sugerido", () => {
        const r = avaliarVenda(card(), [nf("1", 10300)]);
        expect(r.estado).toBe("valor_diverge");
        expect(r.sugerido).toBe(10300);
    });
    test("acima de 4% não sugere ajuste", () => {
        const r = avaliarVenda(card(), [nf("1", 6000)]);
        expect(r.estado).toBe("valor_diverge");
        expect(r.sugerido).toBeNull();
    });
    test("sem nota na janela", () => {
        expect(avaliarVenda(card(), []).estado).toBe("sem_nota");
        expect(avaliarVenda(card(), [nf("1", 10000, "2025-01-01")]).estado).toBe("sem_nota");
    });
});

describe("avaliarVendas", () => {
    test("duas vendas do mesmo cliente não disputam a mesma nota", () => {
        const cards = [card({ id: "a", fechadoEm: "2026-11-05" }), card({ id: "b", fechadoEm: "2026-11-12" })];
        const r = avaliarVendas(cards, new Map([["11222333000181", [nf("1", 10000, "2026-11-05")]]]));
        expect(r.get("a").estado).toBe("ok");
        expect(r.get("b").estado).toBe("sem_nota");
    });
});

test("card de teste é ignorado", () => {
    expect(ehTeste({ nome: "testeSC" })).toBe(true);
    expect(ehTeste({ nome: "Cliente real" })).toBe(false);
});

describe("produtoCompativel", () => {
    const tab = new Map([["999", "LQ1250 Laser 1250W"]]);
    test("laser LQ casa com descrição genérica de laser", () => {
        expect(produtoCompativel("Solda a laser 3000 watts", "Laser", [{ codigo: "1", descricao: "LQ3050 fonte" }], null).ok).toBe(true);
    });
    test("pelo modelo da Tabela BMax quando a descrição não ajuda", () => {
        expect(produtoCompativel("LQ 1250", "", [{ codigo: "999", descricao: "Equipamento" }], tab).ok).toBe(true);
    });
    test("Zimernox: card LQ2000 e nota Tigon320P não bate", () => {
        expect(produtoCompativel("Lq2000", "", [{ codigo: "3005025", descricao: "TIGON320P Inversor Tig 320A" }], null).ok).toBe(false);
    });
    test("card sem máquina não dá para julgar", () => {
        expect(produtoCompativel("", "", [{ codigo: "1", descricao: "X" }], null).ok).toBeNull();
    });
});

describe("checarVendasZen (auditor)", () => {
    const { checarVendasZen } = require("./auditor.service");
    const dias = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const c = (o = {}) => ({ id: "10", nome: "Cliente", pci: "PCI 6", revenda: "Luitex", responsavel: "Carlos", valor: 10000, maquina: "Hardmig 325", segmento: "Máquinas", etapaId: C.RD_STAGE_VENDIDO, cnpj: "11222333000181", criadoEm: dias(20), fechadoEm: dias(10), ...o });
    const itensOk = [{ codigo: "1", descricao: "HARDMIG325FLEX Multi-processo" }];
    const ctx = (cards, notas, cfg = true, itens = itensOk) => ({ dryRun: false, avisos: [], cards: async () => cards, zen: { configurado: () => cfg, notasDoCnpj: async () => notas, itensDaNota: async () => itens, tabelaBmax: async () => new Map() } });

    test("sem nota e valor acima de 1% viram achados de gravidade média", async () => {
        expect((await checarVendasZen(ctx([c()], [])))[0].checagem).toBe("venda_sem_nota_zen");
        const sug = await checarVendasZen(ctx([c()], [{ id: 5, numero: "5", total: 10200, data: dias(10) }]));
        expect(sug[0]).toMatchObject({ checagem: "venda_valor_zen", severidade: "media" });
        expect(sug[0].detalhe.valorSugerido).toBe(10200);
        const grande = await checarVendasZen(ctx([c()], [{ id: 5, numero: "5", total: 5000, data: dias(10) }]));
        expect(grande[0].detalhe.valorSugerido).toBeNull();
    });
    test("diferença de até 1% e produto compatível não geram achado", async () => {
        expect(await checarVendasZen(ctx([c()], [{ id: 5, numero: "5", total: 10050, data: dias(10) }]))).toHaveLength(0);
    });
    test("produto diferente com valor igual gera achado de produto", async () => {
        const r = await checarVendasZen(ctx([c({ maquina: "Lq2000" })], [{ id: 5, numero: "5", total: 10000, data: dias(10) }], true, [{ codigo: "3005025", descricao: "TIGON320P Inversor Tig" }]));
        expect(r).toHaveLength(1);
        expect(r[0].checagem).toBe("venda_produto_zen");
    });
    test("olha TODAS as vendas, inclusive antigas; ignora teste, aberto, PCI12a e recém-fechada", async () => {
        expect(await checarVendasZen(ctx([c({ fechadoEm: dias(120), criadoEm: dias(130) })], []))).toHaveLength(1);
        expect(await checarVendasZen(ctx([c({ nome: "testePR" }), c({ id: "11", etapaId: "outra" }), c({ id: "12", pci: "PCI 12a" }), c({ id: "14", fechadoEm: dias(1) })], []))).toHaveLength(0);
    });
    test("sem credenciais do ZEN a checagem falha (não finge que está tudo certo)", async () => {
        await expect(checarVendasZen(ctx([c()], [], false))).rejects.toThrow(/ZEN/);
    });
});
