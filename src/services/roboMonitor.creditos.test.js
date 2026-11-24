jest.mock("../database", () => ({ sequelize: { query: jest.fn() } }));
jest.mock("../logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
jest.mock("./email.service", () => ({ alertarAdminErro: jest.fn(), sendEmail: jest.fn().mockResolvedValue(true) }));
const { sequelize } = require("../database"); const email = require("./email.service");
const { verificarCreditosAnormais } = require("./roboMonitor.service");

function banco({ porTipo, recente = [] }) {
    sequelize.query.mockImplementation(async (sql) => {
        if (/GROUP BY 1 *$/.test(sql.trim()) || /GROUP BY 1`?$/.test(sql.trim())) return porTipo;
        if (/alerta-creditos' AND alertado_em/.test(sql)) return recente;
        if (/GROUP BY 1,2/.test(sql)) return [{ tipo_agente: "revenda", revenda: "WST", n: 5, v: 9000 }];
        if (/FROM "Users"/.test(sql)) return [{ username: "andre.coelho@boxersoldas.com.br" }, { username: "Admin" }];
        return [];
    });
}
beforeEach(() => { sequelize.query.mockReset(); email.sendEmail.mockClear(); });

test("dia normal não avisa", async () => {
    banco({ porTipo: [{ tipo_agente: "revenda", n: 12, v: 4000 }] });
    const r = await verificarCreditosAnormais();
    expect(r.anormal).toBe(false); expect(email.sendEmail).not.toHaveBeenCalled();
});
test("volume anormal avisa só os admins com e-mail", async () => {
    banco({ porTipo: [{ tipo_agente: "revenda", n: 46, v: 40000 }, { tipo_agente: "representante", n: 70, v: 30000 }] });
    const r = await verificarCreditosAnormais();
    expect(r.anormal).toBe(true); expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0]).toEqual(["andre.coelho@boxersoldas.com.br"]);
});
test("não repete o aviso dentro de 12h", async () => {
    banco({ porTipo: [{ tipo_agente: "revenda", n: 200, v: 90000 }], recente: [{ "?column?": 1 }] });
    const r = await verificarCreditosAnormais();
    expect(r.jaAvisado).toBe(true); expect(email.sendEmail).not.toHaveBeenCalled();
});
