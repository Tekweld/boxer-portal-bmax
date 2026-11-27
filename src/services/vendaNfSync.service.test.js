const { notasParaDetalhar, prepararRegistros } = require("./vendaNfSync.service");
const C = require("../config/constants");

const cab = { numero: 152311, serie: "1", data_emissao: "2026-11-18", status: "SHIPMENT", devolvida: false, total: 55000, tags: "#nfe,bmax", chave_acesso: "35...", pedido_id: "58944", tipo_frete: "ISSUER",
    comissao_vendedor_zen: 2.1, cliente: { id: 7, nome: "Clac Pipocas", documento: "50895481000119" }, vendedor: { id: 9, nome: "Maxmiller", categoria1: null } };
const nota = { id: 78007, numero: 152311, data: "2026-11-18", total: 55000, cab };
const item = { item_id: 1, sequencia: 1, codigo: "99289", descricao: "LQ1550", quantidade: 1, valor_unitario: 55000, valor_total: 55000, imposto_incluso: 9935.11, imposto_fora: 0, outros_valores: {} };
const card = { id: "1479806928", nome: "CLAC", cnpj: "50.895.481/0001-19", valor: 55000, fechadoEm: "2026-11-17T10:00:00Z" };

describe("vendaNfSync: só guarda, sem calcular", () => {
    test("monta vínculo, nota, itens e cliente como vieram do ZEN", () => {
        const r = prepararRegistros({ vinculos: [{ card, res: { estado: "ok", usadas: [nota] } }], itensPorNf: new Map([["78007", [item]]]), pedidos: new Map([["58944", { status: "FINISHED", total: 55000, custo_total: 0 }]]), tabela: new Map([["99289", "LQ1550 - Refrigerado"]]) });
        expect(r.vinculos[0]).toMatchObject({ card_id: "1479806928", cnpj: "50895481000119", estado: "ok", card_valor: 55000, card_fechado_em: "2026-11-17", nf_ids: [78007], nf_numeros: "152311" });
        expect(r.cardNf).toEqual([{ card_id: "1479806928", nf_id: 78007, estado: "ok" }]);
        expect(r.nfs[0]).toMatchObject({ nf_id: 78007, valor_total: 55000, cnpj: "50895481000119", vendedor_nome: "Maxmiller", pedido_custo_total: 0, comissao_vendedor_zen: 2.1 });
        expect(r.itens[0]).toMatchObject({ produto_codigo: "99289", tabela_bmax_modelo: "LQ1550 - Refrigerado", imposto_incluso: 9935.11, valor_total: 55000 });
        expect(r.clientes[0]).toMatchObject({ cnpj: "50895481000119", zen_nome: "Clac Pipocas" });
    });
    test("venda sem nota e sem CNPJ viram vínculo sem notas", () => {
        const r = prepararRegistros({ vinculos: [{ card: { ...card, id: "2" }, res: { estado: "sem_nota", usadas: [] } }, { card: { ...card, id: "3", cnpj: "" }, res: { estado: "sem_cnpj", usadas: [] } }] });
        expect(r.vinculos.map(v => v.estado)).toEqual(["sem_nota", "sem_cnpj"]);
        expect(r.nfs).toHaveLength(0);
    });
    test("nota que já tem itens guardados não é relida", () => {
        const v = [{ card, res: { estado: "ok", usadas: [nota] } }];
        expect(notasParaDetalhar(v, new Set())).toHaveLength(1);
        expect(notasParaDetalhar(v, new Set(["78007"]))).toHaveLength(0);
    });
    test("uma nota ligada a dois cards aparece uma vez em nfs e duas em cardNf", () => {
        const r = prepararRegistros({ vinculos: [{ card, res: { estado: "ok", usadas: [nota] } }, { card: { ...card, id: "9" }, res: { estado: "valor_diverge", usadas: [nota] } }] });
        expect(r.nfs).toHaveLength(1);
        expect(r.cardNf).toHaveLength(2);
    });
});

describe("auditor guarda os fatos sem derrubar a checagem", () => {
    const { checarVendasZen } = require("./auditor.service");
    const dias = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const c = (o = {}) => ({ id: "10", nome: "Cliente", pci: "PCI 6", revenda: "Luitex", responsavel: "Carlos", valor: 10000, maquina: "Hardmig 325", segmento: "Máquinas", etapaId: C.RD_STAGE_VENDIDO, cnpj: "11222333000181", criadoEm: dias(20), fechadoEm: dias(10), ...o });
    const nf = { id: 5, numero: "5", total: 10000, data: dias(10), cab: { pedido_id: "77", numero: 5 } };
    const mk = (gravar, cards = [c()]) => ({ dryRun: false, avisos: [], cards: async () => cards,
        zen: { configurado: () => true, notasDoCnpj: async () => [nf], itensDaNota: async () => [{ item_id: 1, codigo: "1", descricao: "HARDMIG325FLEX" }], pedidoDeVenda: async () => ({ status: "FINISHED", total: 10000, custo_total: 0 }), tabelaBmax: async () => new Map() },
        db: { vendaNf: { nfsComItens: async () => new Set(), gravar } } });

    test("grava vínculo, nota e itens", async () => {
        const gravar = jest.fn(async () => {});
        const ctx = mk(gravar);
        expect(await checarVendasZen(ctx)).toHaveLength(0);
        const regs = gravar.mock.calls[0][0];
        expect(regs.vinculos[0].estado).toBe("ok");
        expect(regs.itens).toHaveLength(1);
        expect(regs.nfs[0].pedido_id).toBe("77");
    });
    test("falha ao gravar (ex.: tabela ainda não criada) vira aviso e não derruba nem altera os achados", async () => {
        const ctx = mk(async () => { throw new Error('relation "bmax_venda_nf" does not exist'); });
        expect(await checarVendasZen(ctx)).toHaveLength(0);
        expect(ctx.avisos.join(" ")).toMatch(/não foram gravados/);
    });
    test("não grava em simulação (dryRun)", async () => {
        const gravar = jest.fn();
        const ctx = { ...mk(gravar), dryRun: true };
        await checarVendasZen(ctx);
        expect(gravar).not.toHaveBeenCalled();
    });
    test("venda sem CNPJ válido gera achado e é guardada como sem_cnpj", async () => {
        const gravar = jest.fn(async () => {});
        const r = await checarVendasZen(mk(gravar, [c({ id: "20", cnpj: "" }), c()]));
        expect(r.map(a => a.checagem)).toEqual(["venda_sem_cnpj_zen"]);
        expect(gravar.mock.calls[0][0].vinculos.map(v => v.estado).sort()).toEqual(["ok", "sem_cnpj"]);
    });
});
