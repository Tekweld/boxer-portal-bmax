const { podeVerPci } = require("./visibilidadePci.service");

describe("visibilidade por PCI (planilha mestre)", () => {
    test("revenda vê 3 (transparência), 6, 9, 12, 12a, 12b, 13, 14, 15 e X", () => {
        for (const p of ["PCI 3", "PCI 6", "PCI 9", "PCI 12", "PCI 12a", "PCI 12b", "PCI 13", "PCI 14", "PCI 15", "PCI X"]) expect(podeVerPci("revenda", p)).toBe(true);
    });
    test("revenda NÃO vê 1, 2, 4, 5, 7, 8, 10, 11, 16 nem lead sem PCI", () => {
        for (const p of ["PCI 1", "PCI 2", "PCI 4", "PCI 5", "PCI 7", "PCI 8", "PCI 10", "PCI 11", "PCI 16", "", "Sem PCI", null, undefined]) expect(podeVerPci("revenda", p)).toBe(false);
    });
    test("representante vê os da revenda + 2, 3, 5, 8, 11 + sem PCI; não vê 1, 4, 7, 10, 16", () => {
        for (const p of ["PCI 6", "PCI 2", "PCI 3", "PCI 5", "PCI 8", "PCI 11", "PCI 12a", "", "Sem PCI"]) expect(podeVerPci("representante", p)).toBe(true);
        for (const p of ["PCI 1", "PCI 4", "PCI 7", "PCI 10", "PCI 16"]) expect(podeVerPci("representante", p)).toBe(false);
    });
    test("admin e funcionário veem tudo", () => {
        for (const r of ["adm", "funcionario"]) for (const p of ["PCI 1", "PCI 16", "", "PCI 12a"]) expect(podeVerPci(r, p)).toBe(true);
    });
});

describe("comissão decidida pelo PCI", () => {
    const { REVENDA_RECEBE_COMISSAO, semCashbackParaRevenda } = require("./visibilidadePci.service");
    test("só PCI 6, 9, 12b, 13, 14, 15 geram cashback para a revenda; PCI 3 é visível mas sem cashback", () => {
        expect([...REVENDA_RECEBE_COMISSAO].sort()).toEqual(["PCI12B", "PCI13", "PCI14", "PCI15", "PCI6", "PCI9"]);
        expect(semCashbackParaRevenda("PCI 3")).toBe(true); expect(semCashbackParaRevenda("PCI 6")).toBe(false);
    });
});
