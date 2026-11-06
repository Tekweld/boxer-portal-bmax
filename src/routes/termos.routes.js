// Termo de Formalização Digital BPartner — rotas (/api/termos). Regras e fluxo: src/services/termos.service.js.
const express = require("express");
const { authenticate, authorize } = require("../middlewares/auth");
const T = require("../services/termos.service");
const { logger } = require("../logger");

const router = express.Router();
const ctxDe = req => ({ ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null, userAgent: String(req.headers["user-agent"] || "").slice(0, 300) });
const adminDe = req => ({ id: req.user.id, email: req.user.username, nome: req.user.name || req.user.username });

function responder(res, e) {
    const status = e.status || 500;
    if (status >= 500) logger.error({ message: "Erro nas rotas de termos", error: e.message, stack: e.stack });
    res.status(status).json({ error: e.message, erros: e.erros || undefined });
}
const rota = fn => async (req, res) => { try { res.json(await fn(req, res)); } catch (e) { responder(res, e); } };

// ── Admin ──
router.get("/flag", authenticate, authorize(["adm"]), rota(async () => ({ ativo: await T.flagAtiva() })));
router.put("/flag", authenticate, authorize(["adm"]), rota(async req => ({ ativo: await T.setFlag(req.body && req.body.ativo === true) })));
router.get("/grupos", authenticate, authorize(["adm"]), rota(() => T.listarGrupos()));
router.get("/previa", authenticate, authorize(["adm"]), rota(req => T.previaEmissao(String(req.query.grupo || ""), String(req.query.programa || ""), req.query.lojas ? String(req.query.lojas).split(",") : null)));
router.get("/", authenticate, authorize(["adm"]), rota(() => T.listar()));
router.post("/", authenticate, authorize(["adm"]), rota(req => T.emitir(req.body || {}, adminDe(req))));
router.post("/:id/aprovar-boxer", authenticate, authorize(["adm"]), rota(req => T.boxerAprovar(req.params.id, adminDe(req), req.body || {}, ctxDe(req))));
router.post("/:id/confirmar-compra", authenticate, authorize(["adm"]), rota(req => T.confirmarCompra(req.params.id, adminDe(req), req.body || {}, ctxDe(req))));
router.post("/:id/cancelar", authenticate, authorize(["adm"]), rota(req => T.cancelar(req.params.id, adminDe(req), req.body && req.body.motivo, ctxDe(req))));

// ── Revenda / representante / admin ──
router.get("/minhas", authenticate, rota(req => T.minhas(req.user)));
router.get("/cep/:cep", authenticate, rota(async req => {
    if (!T.cepValido(req.params.cep)) { const e = new Error("CEP inválido."); e.status = 400; throw e; }
    return (await T.consultarCepReal(req.params.cep).catch(() => null)) || { indisponivel: true };
}));
router.get("/:id", authenticate, rota(req => T.obter(req.params.id, req.user)));
router.get("/:id/comprovante", authenticate, rota(async req => ({ url: await T.urlComprovante(req.params.id, req.user) })));
router.post("/:id/revenda", authenticate, authorize(["revenda"]), rota(req => T.revendaConfirmar(req.params.id, req.user, req.body || {}, ctxDe(req))));
router.post("/:id/testemunha", authenticate, authorize(["representante"]), rota(req => T.testemunhar(req.params.id, req.user, req.body || {}, ctxDe(req))));

module.exports = router;
