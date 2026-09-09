const db = require("../database");

const { User, Representante, Revenda } = db;

async function getRepresentativeEmailByName(representanteNome) {
    const nome = String(representanteNome || "").trim();

    if (!nome) {
        return null;
    }

    const user = await User.findOne({
        where: {
            username: nome,
            role: "representante"
        }
    });

    if (!user) {
        return null;
    }

    const representante = await Representante.findOne({
        where: {
            user_id: user.id
        }
    });

    return representante?.email || null;
}

async function getRevendaEmailByName(revendaNome) {
    const nome = String(revendaNome || "").trim();

    if (!nome) {
        return null;
    }

    const revenda = await Revenda.findOne({
        where: {
            name: nome
        }
    });

    if (!revenda) {
        return null;
    }

    const user = await User.findOne({
        where: {
            id: revenda.user_id,
            role: "revenda"
        }
    });

    // Para role "revenda" o username cadastrado é o próprio e-mail de login.
    return user?.username || null;
}

module.exports = {
    getRepresentativeEmailByName,
    getRevendaEmailByName
};
