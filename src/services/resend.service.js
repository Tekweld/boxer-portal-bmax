const { logger } = require("../logger");

async function sendEmail(to, subject, html) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
        logger.error({ message: "RESEND_API_KEY não configurada" });
        return false;
    }

    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                from: "Portal BMax <noreply@boxersoldas.com.br>",
                to,
                subject,
                html
            })
        });

        if (!res.ok) {
            const error = await res.text();
            logger.error({ message: "Resend error", error, to });
            return false;
        }

        logger.info({ message: "Email enviado", to, subject });
        return true;
    } catch (err) {
        logger.error({ message: "Erro ao enviar email", to, error: err.message });
        return false;
    }
}

async function sendWelcomeEmail(email, username, password, role) {
    const portalUrl = "https://bmax.boxersoldas.com.br";
    const motorUrl = "https://motor.boxersoldas.com.br";

    const roleDisplay = {
        "representante": "Representante",
        "revenda": "Revenda",
        "funcionario": "Funcionário Boxer",
        "adm": "Administrador"
    }[role] || role;

    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Bem-vindo ao Portal BMax! 🎉</h2>

            <p>Olá,</p>
            <p>Sua conta foi criada com sucesso. Abaixo estão suas credenciais de acesso:</p>

            <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>Usuário:</strong> ${username}</p>
                <p><strong>Senha:</strong> ${password}</p>
                <p><strong>Tipo de Perfil:</strong> ${roleDisplay}</p>
            </div>

            <p>Clique no link abaixo para acessar o Portal BMax:</p>
            <p><a href="${portalUrl}" style="background: #25bbee; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Acessar Portal BMax</a></p>

            ${role !== "revenda" ? `
                <p style="margin-top: 20px;">Você também tem acesso ao Motor. Clique abaixo:</p>
                <p><a href="${motorUrl}" style="background: #1e88e5; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Acessar Motor</a></p>
            ` : ""}

            <p style="margin-top: 30px; color: #666; font-size: 12px;">
                <strong>Importante:</strong> Recomendamos que você mude sua senha na primeira vez que acessar a plataforma.
            </p>

            <p style="color: #666; font-size: 12px;">
                Se tiver dúvidas, entre em contato com o administrador.
            </p>
        </div>
    `;

    return sendEmail(email, `Bem-vindo ao Portal BMax - Credenciais de Acesso`, html);
}

async function sendForgotPasswordAlert(adminEmail, userEmail, userName, userRole) {
    const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Alerta: Solicitação de Redefinição de Senha</h2>

            <p>Olá administrador,</p>
            <p>Um usuário solicitou redefinição de senha:</p>

            <div style="background: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                <p><strong>Email do usuário:</strong> ${userEmail}</p>
                <p><strong>Nome:</strong> ${userName}</p>
                <p><strong>Tipo:</strong> ${userRole}</p>
            </div>

            <p>Acesse o painel administrativo para redefinir a senha deste usuário.</p>
            <p>Após redefinir, avise o usuário sua nova senha via WhatsApp ou outro canal seguro.</p>
        </div>
    `;

    return sendEmail(adminEmail, `Alerta: Redefinição de Senha Solicitada - ${userName}`, html);
}

module.exports = {
    sendEmail,
    sendWelcomeEmail,
    sendForgotPasswordAlert
};
