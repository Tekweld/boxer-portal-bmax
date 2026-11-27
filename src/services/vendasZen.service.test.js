const { avaliarVenda, avaliarVendas, ehTeste } = require("./vendasZen.service");
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
    test("até 4% de diferença vira valor sugerido", () => {
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

describe("checarVendasZen (auditor)", () => {
    const { checarVendasZen } = require("./auditor.service");
    const hoje = new Date().toISOString().slice(0, 10);
    const dias = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const c = (o = {}) => ({ id: "10", nome: "Cliente", pci: "PCI 6", revenda: "Luitex", responsavel: "Carlos", valor: 10000, etapaId: C.RD_STAGE_VENDIDO, cnpj: "11222333000181", criadoEm: dias(20), fechadoEm: dias(10), ...o });
    const ctx = (cards, notas, cfg = true) => ({ dryRun: false, avisos: [], cards: async () => cards, zen: { configurado: () => cfg, notasDoCnpj: async () => notas } });

    test("sem nota, valor sugerido e valor divergente viram achados com gravidade certa", async () => {
        const semNota = await checarVendasZen(ctx([c()], []));
        expect(semNota[0].checagem).toBe("venda_sem_nota_zen");
        const sug = await checarVendasZen(ctx([c()], [nf("5", 10200, dias(10))]));
        expect(sug[0]).toMatchObject({ checagem: "venda_valor_zen", severidade: "baixa" });
        expect(sug[0].detalhe.valorSugerido).toBe(10200);
        const grande = await checarVendasZen(ctx([c()], [nf("5", 5000, dias(10))]));
        expect(grande[0].severidade).toBe("media");
    });
    test("venda confirmada, teste, aberto, PCI12a, antiga e recém-fechada não geram achado", async () => {
        expect(await checarVendasZen(ctx([c()], [nf("5", 10000, dias(10))]))).toHaveLength(0);
        expect(await checarVendasZen(ctx([c({ nome: "testePR" }), c({ id: "11", etapaId: "outra" }), c({ id: "12", pci: "PCI 12a" }), c({ id: "13", fechadoEm: dias(60) }), c({ id: "14", fechadoEm: dias(1) })], []))).toHaveLength(0);
    });
    test("sem credenciais do ZEN a checagem falha (não finge que está tudo certo)", async () => {
        await expect(checarVendasZen(ctx([c()], [], false))).rejects.toThrow(/ZEN/);
    });
});
