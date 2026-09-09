jest.mock("../database", () => ({
    RateLimitHit: {
        destroy: jest.fn(),
        count: jest.fn(),
        create: jest.fn()
    }
}));
jest.mock("../logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

const { RateLimitHit } = require("../database");
const { createRateLimiter } = require("./rateLimit");

function mockReq(ip = "1.2.3.4") {
    return { headers: {}, ip };
}
function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

describe("createRateLimiter (Postgres-backed)", () => {
    beforeEach(() => {
        RateLimitHit.destroy.mockReset().mockResolvedValue(0);
        RateLimitHit.count.mockReset();
        RateLimitHit.create.mockReset().mockResolvedValue({});
    });

    it("permite a requisição quando a contagem está abaixo do limite", async () => {
        RateLimitHit.count.mockResolvedValue(3);
        const limiter = createRateLimiter({ windowMs: 60000, max: 10, message: "bloqueado", bucket: "test" });
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        await limiter(req, res, next);

        expect(RateLimitHit.create).toHaveBeenCalledWith({ bucket: "test", ip_address: "1.2.3.4" });
        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it("bloqueia com 429 quando a contagem atinge o máximo", async () => {
        RateLimitHit.count.mockResolvedValue(10);
        const limiter = createRateLimiter({ windowMs: 60000, max: 10, message: "bloqueado", bucket: "test" });
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        await limiter(req, res, next);

        expect(res.status).toHaveBeenCalledWith(429);
        expect(res.json).toHaveBeenCalledWith({ error: "bloqueado" });
        expect(RateLimitHit.create).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it("limpa hits fora da janela antes de contar (auto-limpeza)", async () => {
        RateLimitHit.count.mockResolvedValue(0);
        const limiter = createRateLimiter({ windowMs: 60000, max: 10, message: "bloqueado", bucket: "test" });
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        await limiter(req, res, next);

        expect(RateLimitHit.destroy).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ bucket: "test", ip_address: "1.2.3.4" })
        }));
    });

    it("usa o IP do x-forwarded-for quando presente (primeiro da lista)", async () => {
        RateLimitHit.count.mockResolvedValue(0);
        const limiter = createRateLimiter({ windowMs: 60000, max: 10, message: "bloqueado", bucket: "test" });
        const req = { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, ip: "127.0.0.1" };
        const res = mockRes();
        const next = jest.fn();

        await limiter(req, res, next);

        expect(RateLimitHit.create).toHaveBeenCalledWith({ bucket: "test", ip_address: "9.9.9.9" });
    });

    it("não derruba a rota se o banco falhar — loga e deixa passar (fail-open)", async () => {
        RateLimitHit.destroy.mockRejectedValue(new Error("conexão perdida"));
        const limiter = createRateLimiter({ windowMs: 60000, max: 10, message: "bloqueado", bucket: "test" });
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        await limiter(req, res, next);

        expect(next).toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it("bucket diferente não compartilha contagem (isolamento entre limiters)", async () => {
        RateLimitHit.count.mockResolvedValue(4);
        const limiter = createRateLimiter({ windowMs: 60000, max: 5, message: "bloqueado", bucket: "outro-bucket" });
        const req = mockReq();
        const res = mockRes();
        const next = jest.fn();

        await limiter(req, res, next);

        expect(RateLimitHit.count).toHaveBeenCalledWith({ where: { bucket: "outro-bucket", ip_address: "1.2.3.4" } });
        expect(next).toHaveBeenCalled();
    });
});
