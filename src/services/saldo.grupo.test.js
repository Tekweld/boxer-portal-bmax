// Saque de GRUPO: a tela mostra a soma das lojas do grupo, então o saque tem de poder usar essa soma e debitar de várias carteiras.
jest.mock("../database", () => ({ sequelize: { query: jest.fn() } }));
jest.mock("./codigoUnico.service", () => ({ codigoDe: jest.fn().mockResolvedValue({}), codigosDoGrupo: jest.fn().mockResolvedValue({ grupoId: null, lojaIds: [] }), nomeUnico: jest.fn(async n => n) }));
jest.mock("../logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
const { sequelize } = require("../database");
const saldo = require("./saldo.service");

function carteiras(lista) {
    const saldos = Object.fromEntries(lista.map(c => [c.revenda, c.saldo])); const inserts = [];
    sequelize.query.mockImplementation(async (sql, opts) => {
        if (/SELECT revenda_rd FROM bmax_grupos/.test(sql)) return lista.map(c => ({ revenda_rd: c.revenda }));
        if (/ORDER BY \(revenda = :primeira\)/.test(sql)) return lista.map(c => ({ ...c, saldo: saldos[c.revenda] }));
        if (/SELECT saldo FROM bmax_saldo/.test(sql)) return [{ saldo: saldos[opts.replacements.nome] }];
        if (/INSERT INTO bmax_transacoes/.test(sql)) { inserts.push(opts.replacements); return []; }
        if (/INSERT INTO bmax_saldo/.test(sql)) { saldos[opts.replacements.nome] = opts.replacements.saldo; return []; }
        return [];
    });
    return { inserts, saldos };
}

test("saque maior que a carteira da loja, mas dentro do grupo: debita repartido e nenhuma carteira fica negativa", async () => {
    const { inserts, saldos } = carteiras([{ revenda: "Luitex Americana", saldo: 3889.29 }, { revenda: "Luitex Sumaré", saldo: 4646.51 }, { revenda: "Luitex SBO", saldo: 285.4 }]);
    const partes = await saldo.debitarCashbackGrupo("Luitex Americana", "Luitex", 5000, "Saque X", "sq1");
    expect(partes).toEqual([{ carteira: "Luitex Americana", valor: 3889.29 }, { carteira: "Luitex Sumaré", valor: 1110.71 }]);
    expect(Object.values(saldos).every(v => v >= 0)).toBe(true);
    expect(inserts.reduce((s, i) => s + i.valor, 0)).toBeCloseTo(5000, 2);
});
test("saque acima da soma do grupo é recusado e não debita nada", async () => {
    const { inserts } = carteiras([{ revenda: "Luitex Americana", saldo: 100 }, { revenda: "Luitex SBO", saldo: 50 }]);
    await expect(saldo.debitarCashbackGrupo("Luitex Americana", "Luitex", 200, "Saque X", "sq2")).rejects.toThrow(/Saldo insuficiente/);
    expect(inserts.length).toBe(0);
});
