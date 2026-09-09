const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { User, Revenda } = require("../database");
const { AuditLog } = require("../services/audit.service");
const { logger } = require("../logger");

async function login(req, res) {
    try {
        const { username, password, role } = req.body;

        const user = await User.findOne({ where: { username } });

        if (!user) {
            await AuditLog(req, {
                action: "LOGIN_FAILED",
                entityType: "User",
                metadata: {
                    username,
                    reason: "usuario_nao_encontrado"
                },
                status: "failed"
            });
            return res.status(401).json({ error: "Usuário inválido" });
        }

        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            await AuditLog(req, {
                action: "LOGIN_FAILED",
                entityType: "User",
                entityId: user.id,
                metadata: {
                    username,
                    reason: "senha_invalida"
                },
                status: "failed"
            });
            return res.status(401).json({ error: "Senha inválida" });
        }

        if (user.role !== role) {
            await AuditLog(req, {
                action: "LOGIN_FAILED",
                entityType: "User",
                entityId: user.id,
                metadata: {
                    username,
                    reason: "role_invalida",
                    attemptedRole: role
                },
                status: "failed"
            });
            return res.status(401).json({
                error: "Tipo de acesso inválido"
            });
        }
        await AuditLog(req, {
            action: "LOGIN_SUCCESS",
            entityType: "User",
            entityId: user.id,
            metadata: {
                username: user.username,
                role: user.role
            }
        });
        let revendaName = null;
        let revendaGrupo = null;

        if (user.role === "revenda") {
            const revenda = await Revenda.findOne({
                where: { user_id: user.id }
            });

            revendaName = revenda?.name || null;
            revendaGrupo = revenda?.grupo || null;
        }

        const token = jwt.sign(
            {
                id: user.id,
                username: user.username,
                role: user.role,
                name: revendaName,
                grupo: revendaGrupo
            },
            process.env.JWT_SECRET,
            { expiresIn: "1d" }
        );

        return res.json({
            token,
            user: {
                username: user.username,
                role: user.role,
                name: revendaName
            }
        });

    } catch (error) {
        logger.error({ message: "Erro no login", error: error.message, stack: error.stack });
        return res.status(500).json({ message: "Erro interno do servidor" });
    }
}

module.exports = {
    login
};