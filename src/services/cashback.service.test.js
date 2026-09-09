jest.mock("../config/supabaseSistemas");

const TABELA = {
    linhas: [
        { pci: "A", agente: "Revenda", valores: [100, 200, 300] },
        { pci: "A", agente: "Rep", valores: [50, 100, 150] },
        { pci: "B", agente: "Revenda", valores: [0, -10, 400] }
    ]
};

describe("lerPlanilhaCashback", () => {
    beforeEach(() => {
        jest.resetModules();
    });

    // resetModules + re-require tanto do mock quanto do service a cada teste:
    // limpa o _comCache interno do service E garante que o mock configurado
    // aqui é a mesma instância que o service vai efetivamente chamar.
    function loadServiceWithRows(rows) {
        const { sbSistemasAnon } = require("../config/supabaseSistemas");
        sbSistemasAnon.mockResolvedValue(rows);
        return require("./cashback.service");
    }

    function loadServiceWithError(err) {
        const { sbSistemasAnon } = require("../config/supabaseSistemas");
        sbSistemasAnon.mockRejectedValue(err);
        return require("./cashback.service");
    }

    it("retorna o valor correto para pci/role/classepreco válidos (revenda, classe 2)", async () => {
        const { lerPlanilhaCashback } = loadServiceWithRows([{ valor: JSON.stringify(TABELA) }]);

        const valor = await lerPlanilhaCashback("A", "revenda", "2");

        expect(valor).toBe(2); // 200 / 100
    });

    it("retorna o valor correto para representante (role != revenda vira 'Rep')", async () => {
        const { lerPlanilhaCashback } = loadServiceWithRows([{ valor: JSON.stringify(TABELA) }]);

        const valor = await lerPlanilhaCashback("A", "representante", "1");

        expect(valor).toBe(0.5); // 50 / 100
    });

    it("normaliza o pci (case-insensitive, sem espaços)", async () => {
        const { lerPlanilhaCashback } = loadServiceWithRows([{ valor: JSON.stringify(TABELA) }]);

        const valor = await lerPlanilhaCashback(" a ", "revenda", "1");

        expect(valor).toBe(1); // 100 / 100
    });

    it("retorna 0 quando não existe linha para o pci/agente pedido", async () => {
        const { lerPlanilhaCashback } = loadServiceWithRows([{ valor: JSON.stringify(TABELA) }]);

        const valor = await lerPlanilhaCashback("ZZZ", "revenda", "1");

        expect(valor).toBe(0);
    });

    it("retorna 0 quando classepreco não é passado (usa índice 0) e o valor é <= 0", async () => {
        const { lerPlanilhaCashback } = loadServiceWithRows([{ valor: JSON.stringify(TABELA) }]);

        const valor = await lerPlanilhaCashback("B", "revenda", undefined);

        expect(valor).toBe(0); // valores[0] = 0
    });

    it("cai para o índice 0 quando classepreco é inválido (fora do range)", async () => {
        const { lerPlanilhaCashback } = loadServiceWithRows([{ valor: JSON.stringify(TABELA) }]);

        const valor = await lerPlanilhaCashback("B", "revenda", "99");

        expect(valor).toBe(0); // cai pro índice 0 (valores[0] = 0)
    });

    it("retorna 0 quando a tabela não pôde ser buscada (Supabase indisponível)", async () => {
        const { lerPlanilhaCashback } = loadServiceWithError(new Error("timeout"));

        const valor = await lerPlanilhaCashback("A", "revenda", "1");

        expect(valor).toBe(0);
    });

    it("retorna 0 quando não há linha 'comissao_tabela' cadastrada", async () => {
        const { lerPlanilhaCashback } = loadServiceWithRows([]);

        const valor = await lerPlanilhaCashback("A", "revenda", "1");

        expect(valor).toBe(0);
    });
});
