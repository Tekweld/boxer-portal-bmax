const { extrairCodigos, prepararRegistros } = require("./chequeUso.service");

describe("extrairCodigos", () => {
    test("acha o código no texto livre do pedido (caso real 59899)", () => {
        const obs = "CODIGO BMAX: BMAX-2026-31405\nPagamento bonificação Bmax\nATENÇÃO: SAQUE EFETUADO NO VALORR DE R$8.955,20.";
        expect(extrairCodigos(obs)).toEqual(["BMAX-2026-31405"]);
    });
    test("aceita variações de espaço e minúsculas, sem repetir, e ignora texto sem código", () => {
        expect(extrairCodigos("bmax 2026 31405 e BMAX-2026-31405 e BMAX2026-61437")).toEqual(["BMAX-2026-31405", "BMAX-2026-61437"]);
        expect(extrairCodigos("Pagamento bonificação Bmax, sem número")).toEqual([]);
        expect(extrairCodigos(null)).toEqual([]);
    });
});

describe("prepararRegistros", () => {
    const cheque = { id: "uuid-1", codigo_cheque: "BMAX-2026-31405", revenda: "Luitex", tipo_uso: "bonificacao", valor: "8955.20", status: "aprovado", criado_em: "2026-11-27", expira_em: "2026-12-27", utilizado_em: null };
    const pedido = (over = {}) => ({ pedido_id: 59899, data: "2026-11-24", status: "PICKING", total: 12634.36, custo_total: 0, perfil: "BRINDE", perfil_descricao: "Brinde", operacao_fiscal: "Saída de brinde", observacao: "CODIGO BMAX: BMAX-2026-31405", cliente: { id: 7, nome: "Luitex", documento: "51051811000152" }, vendedor: { id: 9, nome: "Vlm" }, nf_id: null, ...over });
    const item = { item_id: 1, codigo: "99289", descricao: "LQ1550", quantidade: 4, valor_unitario: 901.99, custo_total: 0, imposto_incluso: 350.41, valor_total: 3607.96, operacao_tributaria: "Remessa em bonificação, doação ou brinde" };

    test("liga o cheque ao pedido, guarda o perfil como veio e os itens", () => {
        const r = prepararRegistros({ cheques: [cheque], pedidos: [pedido()], itensPorPedido: new Map([["59899", [item]]]), tabela: new Map([["99289", "LQ1550 - Refrigerado"]]) });
        expect(r.usos).toHaveLength(1);
        expect(r.usos[0]).toMatchObject({ codigo_cheque: "BMAX-2026-31405", pedido_id: "59899", codigo_existe: true, revenda: "Luitex", tipo_uso: "bonificacao", valor_cheque: 8955.2, pedido_perfil: "BRINDE", cliente_cnpj: "51051811000152", nf_id: null });
        expect(r.itens[0]).toMatchObject({ pedido_id: "59899", produto_codigo: "99289", tabela_bmax_modelo: "LQ1550 - Refrigerado", valor_total: 3607.96 });
    });
    test("perfil Bonificação (ou venda comum, no desconto) também é guardado como veio, sem filtro por perfil", () => {
        const a = prepararRegistros({ cheques: [cheque], pedidos: [pedido({ perfil: "BONIFICACAO", perfil_descricao: "Bonificação" })] });
        const b = prepararRegistros({ cheques: [{ ...cheque, tipo_uso: "desconto" }], pedidos: [pedido({ perfil: "VENDA", perfil_descricao: "Venda padrão" })] });
        expect(a.usos[0].pedido_perfil).toBe("BONIFICACAO");
        expect(b.usos[0]).toMatchObject({ pedido_perfil: "VENDA", tipo_uso: "desconto" });
    });
    test("código que não existe no Portal fica marcado (codigo_existe = false)", () => {
        const r = prepararRegistros({ cheques: [], pedidos: [pedido()] });
        expect(r.usos[0]).toMatchObject({ codigo_existe: false, saque_id: null, revenda: null });
    });
    test("pedido sem código não vira registro", () => {
        expect(prepararRegistros({ cheques: [cheque], pedidos: [pedido({ observacao: "sem código" })] }).usos).toHaveLength(0);
    });
});

describe("checarChequesZen (auditor): só lê o banco", () => {
    const { checarChequesZen } = require("./auditor.service");
    const uso = (o = {}) => ({ codigo_cheque: "BMAX-2026-31405", pedido_id: "59899", codigo_existe: true, cliente_nome: "Luitex", cliente_cnpj: "51051811000152", pedido_total: "12634.36", pedido_data: "2026-11-24", pedido_status: "PICKING", pedido_perfil: "BRINDE", vendedor_nome: "Vlm",
        revenda: "Luitex", tipo_uso: "bonificacao", valor_cheque: "8955.20", cheque_status: "aprovado", cheque_utilizado_em: null, ...o });
    const mk = (usos) => ({ dryRun: false, avisos: [], db: { cheques: { usos: async () => usos } } });

    test("cheque citado no ZEN e sem baixa no Portal gera aviso médio", async () => {
        const r = await checarChequesZen(mk([uso()]));
        expect(r).toHaveLength(1);
        expect(r[0]).toMatchObject({ checagem: "cheque_usado_sem_baixa", severidade: "media", chave: "cheque_usado_sem_baixa:BMAX-2026-31405" });
    });
    test("cheque já baixado no Portal não gera aviso (resolve sozinho na rodada seguinte)", async () => {
        expect(await checarChequesZen(mk([uso({ cheque_utilizado_em: new Date() })]))).toHaveLength(0);
    });
    test("pedido que cita código inexistente gera aviso ALTO", async () => {
        const r = await checarChequesZen(mk([uso({ codigo_existe: false, cheque_status: null, valor_cheque: null })]));
        expect(r[0]).toMatchObject({ checagem: "cheque_codigo_desconhecido", severidade: "alta" });
    });
    test("perfil do pedido não muda nada (Brinde, Bonificação ou venda comum)", async () => {
        for (const perfil of ["BRINDE", "BONIFICACAO", "VENDA"]) expect(await checarChequesZen(mk([uso({ pedido_perfil: perfil })]))).toHaveLength(1);
    });
    test("em simulação, se a tabela ainda não existe vira aviso; fora dela, falha", async () => {
        const falha = { db: { cheques: { usos: async () => { throw new Error("relation does not exist"); } } }, avisos: [] };
        const sim = { ...falha, dryRun: true };
        expect(await checarChequesZen(sim)).toEqual([]);
        expect(sim.avisos.join(" ")).toMatch(/ainda não existe/);
        await expect(checarChequesZen({ ...falha, dryRun: false })).rejects.toThrow(/relation/);
    });
});

describe("sincronizar (robô cheques-zen): incremental e retomável", () => {
    const { sincronizar } = require("./chequeUso.service");
    const pedido = (id, obs, data = "2026-11-24") => ({ pedido_id: id, data, status: "PICKING", total: 100, custo_total: 0, perfil: "BRINDE", observacao: obs, cliente: { id: 1, nome: "Luitex", documento: "51051811000152" }, vendedor: null });

    function falso({ estado = {}, varredura }) {
        const gravados = [];
        const sequelize = {
            transaction: async fn => fn({}),
            query: jest.fn(async (sql, opts) => {
                if (/FROM bmax_saques/.test(sql)) return [{ id: "u1", codigo_cheque: "BMAX-2026-31405", revenda: "Luitex", tipo_uso: "bonificacao", valor: "8955.20", status: "aprovado", utilizado_em: null }];
                if (/INSERT INTO bmax_zen_varredura/.test(sql)) { gravados.push(["set", opts.replacements.c, opts.replacements.v]); return []; }
                if (/DELETE FROM bmax_zen_varredura/.test(sql)) { gravados.push(["del", opts.replacements.c]); return []; }
                if (/FROM bmax_zen_varredura/.test(sql)) return Object.entries(estado).map(([chave, valor]) => ({ chave, valor: String(valor) }));
                return [];
            }),
        };
        const zen = { configurado: () => true, tabelaBmax: async () => new Map(), itensDoPedido: async () => [{ item_id: 1, codigo: "1", descricao: "X", quantidade: 1 }], pedidosRecentes: jest.fn(async () => varredura) };
        return { sequelize, zen, gravados };
    }

    test("primeira varredura (sem estado) olha por data; ao completar grava o topo", async () => {
        const d = falso({ varredura: { pedidos: [pedido(59899, "BMAX-2026-31405"), pedido(59900, "sem código")], maiorId: 60453, menorId: 59000, paginas: 6, completo: true } });
        const r = await sincronizar(d);
        expect(d.zen.pedidosRecentes.mock.calls[0][0]).toMatchObject({ startId: null, minId: null });
        expect(d.zen.pedidosRecentes.mock.calls[0][0].desdeISO).toBeTruthy();
        expect(r).toMatchObject({ ok: true, completo: true, pedidosComCodigo: 1, usosGravados: 1, itensGravados: 1, novoTopo: 60453 });
        expect(d.gravados).toContainEqual(["set", "pedidos_ultimo_id", 60453]);
    });
    test("com topo gravado, varre só o que é novo (topo menos a sobreposição)", async () => {
        const d = falso({ estado: { pedidos_ultimo_id: 60000 }, varredura: { pedidos: [], maiorId: 60100, menorId: 59700, paginas: 2, completo: true } });
        await sincronizar(d);
        expect(d.zen.pedidosRecentes.mock.calls[0][0]).toMatchObject({ startId: null, minId: 60000 - 250, desdeISO: null });
    });
    test("tempo acabou antes de completar: grava o cursor e NÃO mexe no topo", async () => {
        const d = falso({ varredura: { pedidos: [pedido(60400, "sem código")], maiorId: 60453, menorId: 60300, paginas: 4, completo: false } });
        const r = await sincronizar(d);
        expect(r).toMatchObject({ completo: false, cursor: 60300, novoTopo: null });
        expect(d.gravados).toContainEqual(["set", "pedidos_cursor", 60300]);
        expect(d.gravados).toContainEqual(["set", "pedidos_topo_em_andamento", 60453]);
        expect(d.gravados.some(g => g[1] === "pedidos_ultimo_id")).toBe(false);
    });
    test("rodada seguinte retoma do cursor e, ao completar, usa o topo em andamento e limpa o estado", async () => {
        const d = falso({ estado: { pedidos_cursor: 60300, pedidos_topo_em_andamento: 60453 }, varredura: { pedidos: [], maiorId: 60299, menorId: 59500, paginas: 5, completo: true } });
        const r = await sincronizar(d);
        expect(d.zen.pedidosRecentes.mock.calls[0][0]).toMatchObject({ startId: 60300 });
        expect(r.novoTopo).toBe(60453);
        expect(d.gravados).toContainEqual(["del", "pedidos_cursor"]);
        expect(d.gravados).toContainEqual(["del", "pedidos_topo_em_andamento"]);
    });
    test("sem credencial do ZEN, falha (o monitor avisa)", async () => {
        const d = falso({ varredura: { pedidos: [], maiorId: null, menorId: null, paginas: 0, completo: true } });
        d.zen.configurado = () => false;
        await expect(sincronizar(d)).rejects.toThrow(/ZEN_EMAIL/);
    });
});
