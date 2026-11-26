const { motivoForaDoEscopo, tipoDoProduto, pciParaEscopo } = require("./escopoBmax.service");

describe("escopo BMax e módulo PCI X (preparado, desligado por padrão)", () => {
    afterEach(() => { delete process.env.PCIX_ATIVO; });

    test("módulo desligado: Migflex fica fora, com ou sem PCI X (comportamento de sempre)", () => {
        expect(motivoForaDoEscopo("Migflex 250", "Máquinas", "PCI 12")).toBe("produto_fora_da_tabela_bmax");
        expect(motivoForaDoEscopo("Migflex 250", "Máquinas", "PCI X")).toBe("produto_fora_da_tabela_bmax");
    });
    test("módulo ligado: PCI X libera Migflex; consumível continua fora", () => {
        process.env.PCIX_ATIVO = "1";
        expect(motivoForaDoEscopo("Migflex 250", "Máquinas", "PCI X")).toBeNull();
        expect(motivoForaDoEscopo("Migflex 250", "Máquinas", "PCI 12")).toBe("produto_fora_da_tabela_bmax");
        expect(motivoForaDoEscopo("Consumíveis", "Máquinas", "PCI X")).toBe("consumivel");
    });
    test("módulo ligado: só card criado a partir de 23/11/2026 e em aberto", () => {
        process.env.PCIX_ATIVO = "1";
        expect(pciParaEscopo("PCI X", "2026-11-24T10:00:00Z", true)).toBe("PCI X");
        expect(pciParaEscopo("PCI X", "2026-11-10T10:00:00Z", true)).toBe("");      // antigo (ex.: Arcode)
        expect(pciParaEscopo("PCI X", "2026-11-24T10:00:00Z", false)).toBe("");     // vendido ou perdido
    });
    test("produto BMax e texto vazio ficam dentro", () => {
        expect(motivoForaDoEscopo("Hardmig 450 MV", "Máquinas", "PCI 6")).toBeNull();
        expect(motivoForaDoEscopo("", "Máquinas", "PCI 12")).toBeNull();
    });
    test("tipoDoProduto", () => {
        expect(tipoDoProduto("Migflex 250")).toBe("nao_bmax");
        expect(tipoDoProduto("Hardmig 450 MV")).toBe("bmax");
        expect(tipoDoProduto("Consumíveis")).toBe("consumivel");
        expect(tipoDoProduto("Outro")).toBe("");
    });
});
