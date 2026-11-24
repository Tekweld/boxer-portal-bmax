// Regressão 24/11/2026: a virada para o Pipefy trocou o lead_id (RD 24 hex -> numérico) e o robô creditou tudo de novo.
jest.mock("../database", () => ({ sequelize: { query: jest.fn() } }));
jest.mock("./rd.leads.service", () => ({ getLeads: jest.fn(), getCustomField: jest.fn() }));
jest.mock("./cashback.service", () => ({ calcularComissoes: jest.fn() }));
jest.mock("./saldo.service", () => ({ creditarCashback: jest.fn(), debitarCashback: jest.fn() }));
jest.mock("../logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
const { sequelize } = require("../database");
const rd = require("./rd.leads.service"); const cashback = require("./cashback.service"); const saldo = require("./saldo.service");
const { RD_STAGE_VENDA_EFETIVADA } = require("../config/constants");

test("lead já creditado com o id do RD não é creditado de novo quando aparece com o id do Pipefy", async () => {
    rd.getLeads.mockResolvedValue([{ id: "1479806928", rd_deal_id: "6afc8da14f0472001d84e5a0", deal_stage: { id: RD_STAGE_VENDA_EFETIVADA }, amount_total: 10000 }]);
    rd.getCustomField.mockImplementation((d, c) => ({ "REVENDA/LOJA": "Ipanema Soldas", "REPRESENTANTE": "", "PERFIL PCI": "PCI 6", "CLASSE DE PREÇO": "1" })[c] || "");
    cashback.calcularComissoes.mockResolvedValue({ revenda: { valor: 825, comissaoPct: 8.25 } });
    sequelize.query.mockResolvedValue([{ lead_id: "6afc8da14f0472001d84e5a0", tipo_agente: "revenda", nome: "Ipanema Soldas (LT)", total_credito: 825 }]);
    const { recalcularComissoes } = require("./comissao.service");
    const r = await recalcularComissoes();
    expect(saldo.creditarCashback).not.toHaveBeenCalled();
    expect(r.ajustados).toBe(0);
});
test("lead novo (sem crédito sob nenhum dos dois ids) é creditado uma vez", async () => {
    saldo.creditarCashback.mockClear(); sequelize.query.mockResolvedValue([]);
    const { recalcularComissoes } = require("./comissao.service");
    await recalcularComissoes();
    expect(saldo.creditarCashback).toHaveBeenCalledTimes(1);
});
