const jwt = require("jsonwebtoken");
const { authenticate, authorize } = require("./auth");

function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

describe("authenticate", () => {
    const OLD_SECRET = process.env.JWT_SECRET;

    beforeAll(() => {
        process.env.JWT_SECRET = "test-secret";
    });

    afterAll(() => {
        process.env.JWT_SECRET = OLD_SECRET;
    });

    it("rejeita quando não há header Authorization", () => {
        const req = { headers: {} };
        const res = mockRes();
        const next = jest.fn();

        authenticate(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: "Token não informado" });
        expect(next).not.toHaveBeenCalled();
    });

    it("rejeita header sem duas partes (formato inválido)", () => {
        const req = { headers: { authorization: "TokenSemBearer" } };
        const res = mockRes();
        const next = jest.fn();

        authenticate(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: "Formato do token inválido" });
        expect(next).not.toHaveBeenCalled();
    });

    it("rejeita quando o esquema não é Bearer", () => {
        const req = { headers: { authorization: "Basic abc123" } };
        const res = mockRes();
        const next = jest.fn();

        authenticate(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: "Token mal formatado" });
        expect(next).not.toHaveBeenCalled();
    });

    it("rejeita um token inválido/expirado", () => {
        const req = { headers: { authorization: "Bearer token-invalido" } };
        const res = mockRes();
        const next = jest.fn();

        authenticate(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(res.json).toHaveBeenCalledWith({ error: "Token inválido" });
        expect(next).not.toHaveBeenCalled();
    });

    it("aceita um token válido e popula req.user", () => {
        const token = jwt.sign({ id: 1, username: "andre", role: "adm" }, process.env.JWT_SECRET);
        const req = { headers: { authorization: `Bearer ${token}` } };
        const res = mockRes();
        const next = jest.fn();

        authenticate(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(req.user).toMatchObject({ id: 1, username: "andre", role: "adm" });
    });
});

describe("authorize", () => {
    it("rejeita quando req.user não existe", () => {
        const req = {};
        const res = mockRes();
        const next = jest.fn();

        authorize(["adm"])(req, res, next);

        expect(res.status).toHaveBeenCalledWith(401);
        expect(next).not.toHaveBeenCalled();
    });

    it("rejeita quando a role não está na lista permitida", () => {
        const req = { user: { role: "revenda" } };
        const res = mockRes();
        const next = jest.fn();

        authorize(["adm"])(req, res, next);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith({ error: "Acesso negado" });
        expect(next).not.toHaveBeenCalled();
    });

    it("permite quando a role está na lista", () => {
        const req = { user: { role: "adm" } };
        const res = mockRes();
        const next = jest.fn();

        authorize(["adm", "representante"])(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });
});
