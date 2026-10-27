const express = require("express");
const { login } = require("../controllers/auth.controller");
const { loginRateLimit, forgotPasswordRateLimit } = require("../middlewares/rateLimit");
const { sendEmail } = require("../services/email.service");
const { User } = require("../database");
const { logger } = require("../logger");

const router = express.Router();

router.post("/login", loginRateLimit, login);

router.post("/forgot-password", forgotPasswordRateLimit, async (req, res) => {
    try {
        const email = String((req.body && req.body.email) || "").trim().slice(0, 200);
        if (!email) return res.status(400).json({ error: "Email é obrigatório" });
        // o texto digitado vai dentro de HTML enviado aos admins: escapar
        const emailSeguro = email.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

        // Busca admins para notificar (a existência do usuário não é checada aqui
        // de propósito: a resposta ao cliente é sempre a mesma genérica abaixo,
        // para não permitir enumerar quais emails têm cadastro no Portal)
        const admins = await User.findAll({ where: { role: "adm" } });
        if (admins.length === 0) {
            return res.status(500).json({ error: "Nenhum administrador disponível" });
        }

        // Envia alerta para cada admin
        const subject = `Alerta: Redefinição de Senha Solicitada - ${email.replace(/[\r\n]/g, " ")}`;
        const html = `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px">
                <h2 style="color:#333">⚠️ Solicitação de Redefinição de Senha</h2>
                <p>Um usuário solicitou redefinição de senha:</p>
                <div style="background:#f5f5f5;padding:20px;border-radius:8px;margin:20px 0">
                    <p><strong>Email/Usuário:</strong> ${emailSeguro}</p>
                    <p><strong>Hora:</strong> ${new Date().toLocaleString("pt-BR")}</p>
                </div>
                <p>Acesse o painel administrativo para redefinir a senha.</p>
                <p style="font-size:12px;color:#666">
                    Após redefinir, avise o usuário sua nova senha via WhatsApp ou outro canal seguro.
                </p>
            </div>
        `;

        for (const admin of admins) {
            await sendEmail(admin.username || "admin@boxersoldas.com.br", subject, html);
        }

        res.json({ message: "Solicitação recebida. Um administrador entrará em contato em breve." });
    } catch (err) {
        logger.error({ message: "Erro ao processar forgot-password", error: err.message, stack: err.stack });
        res.status(500).json({ error: "Erro ao processar solicitação" });
    }
});

module.exports = router;
