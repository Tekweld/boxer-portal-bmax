const { Op } = require("sequelize");
const { RateLimitHit } = require("../database");
const { logger } = require("../logger");

// Rate limiting persistido em Postgres (tabela RateLimitHits), compartilhado entre
// todas as instâncias serverless da Vercel — substitui o antigo contador em memória
// (Map por processo), que não protegia de verdade sob múltiplas instâncias frias
// rodando em paralelo (cada uma contava separado, então o limite real efetivo podia
// ser maior que o configurado).
function createRateLimiter({ windowMs, max, message, bucket }) {
    return async function rateLimit(req, res, next) {
        const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
        const windowStart = new Date(Date.now() - windowMs);

        try {
            // Auto-limpeza: remove hits fora da janela para este bucket/IP a cada
            // checagem, sem precisar de cron separado para manter a tabela pequena.
            await RateLimitHit.destroy({
                where: { bucket, ip_address: ip, created_at: { [Op.lt]: windowStart } }
            });

            const count = await RateLimitHit.count({ where: { bucket, ip_address: ip } });
            if (count >= max) {
                return res.status(429).json({ error: message });
            }

            await RateLimitHit.create({ bucket, ip_address: ip });
            next();
        } catch (err) {
            // Falha no rate limiter não deve derrubar a rota protegida — loga e deixa passar.
            logger.error({ message: "Erro no rate limiter, permitindo requisição", bucket, error: err.message });
            next();
        }
    };
}

const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: "Muitas tentativas de login. Tente novamente em 15 minutos.",
    bucket: "login"
});

const forgotPasswordRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: "Muitas solicitações de redefinição de senha. Tente novamente em 15 minutos.",
    bucket: "forgot-password"
});

// Para ações sensíveis autenticadas (saques, sync com RD Station, recálculo de
// cashback) — mais permissivo que login/forgot-password pois é uso legítimo
// repetido por admins/revendas, só limita abuso/automação descontrolada.
const sensitiveActionRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: "Muitas requisições em pouco tempo. Tente novamente em alguns minutos.",
    bucket: "sensitive"
});

module.exports = { createRateLimiter, loginRateLimit, forgotPasswordRateLimit, sensitiveActionRateLimit };
