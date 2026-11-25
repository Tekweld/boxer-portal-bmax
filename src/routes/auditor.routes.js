const express = require("express");
const { QueryTypes } = require("sequelize");
const { sequelize } = require("../database");
const { authenticate, authorize } = require("../middlewares/auth");
const { sensitiveActionRateLimit } = require("../middlewares/rateLimit");
const { rodarAuditoria } = require("../services/auditor.service");

// Aba "Auditor diário" (Gestão). Só leitura dos achados/execuções + uma simulação sob demanda. Nada aqui corrige dado de negócio.
const router = express.Router();
const soAdmin = [authenticate, authorize(["adm"])];

router.get("/achados", ...soAdmin, async (req, res) => {
    try {
        const resolvidos = req.query.estado === "resolvidos";
        const rows = await sequelize.query(
            `SELECT id, chave, grupo, checagem, severidade, titulo, detalhe, link, acao_sugerida, primeira_vez, ultima_vez, resolvido_em, ultimo_aviso_em
               FROM bmax_auditoria_achados
              WHERE ${resolvidos ? "resolvido_em IS NOT NULL" : "resolvido_em IS NULL"}
              ORDER BY ${resolvidos ? "resolvido_em DESC LIMIT 100" : "CASE severidade WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END, primeira_vez DESC"}`,
            { type: QueryTypes.SELECT }
        );
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get("/execucoes", ...soAdmin, async (req, res) => {
    try {
        res.json(await sequelize.query(
            `SELECT id, iniciado_em, rodada, duracao_ms, total_achados, novos, resolvidos, avisados, email_enviado, erro
               FROM bmax_auditoria_execucoes ORDER BY iniciado_em DESC LIMIT 30`,
            { type: QueryTypes.SELECT }
        ));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Roda as checagens agora, sem gravar nada e sem enviar e-mail.
router.post("/simular", ...soAdmin, sensitiveActionRateLimit, async (req, res) => {
    try {
        res.json(await rodarAuditoria({ rodada: "manual", dryRun: true }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
