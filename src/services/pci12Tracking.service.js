const { sequelize } = require("../database");
const { QueryTypes } = require("sequelize");

// Rastreia o prazo do PCI12 pendente de definição de caminho. Regra (André,
// 14/09/2026, revisada 08/10/2026): todo PCI12 vira responsável André no RD até a
// revenda escolher o caminho; passadas 48h sem escolha, o sistema aplica o PCI 12b
// (Boxer vende) sozinho e devolve o responsável anterior ao André.
//
// Também guarda o prazo de 60 dias do PCI12a (revenda assumiu): vencido sem venda
// nem perda, o lead vai pro funil BMAX, etapa "Prazo Vencido".

// Retorna true só quando o INSERT de fato aconteceu (deal ainda não estava
// rastreado) — usado pelo chamador pra decidir se deve trocar o owner_id no
// RD agora (evita repetir a troca a cada rodada do cron pro mesmo deal).
// owner_original_id é NOT NULL: lead que já nascia com o André como dono grava ''
// (sem dono anterior conhecido) — o 12b automático cai na planilha por região.
// `detectadoEm` permite começar a contar de uma data anterior (leads antigos).
async function registrarTroca(dealId, ownerOriginalId, ownerOriginalNome, detectadoEm = null) {
    const rows = await sequelize.query(
        `INSERT INTO bmax_pci12_tracking (deal_id, owner_original_id, owner_original_nome, detectado_em)
         VALUES (:dealId, :ownerOriginalId, :ownerOriginalNome, COALESCE(:detectadoEm, now()))
         ON CONFLICT (deal_id) DO NOTHING
         RETURNING deal_id`,
        {
            replacements: { dealId, ownerOriginalId: ownerOriginalId || "", ownerOriginalNome: ownerOriginalNome || null, detectadoEm },
            type: QueryTypes.SELECT
        }
    );
    return rows.length > 0;
}

// Pendentes = ainda não resolvidos e sem o 12b automático aplicado. Inclui os que
// já tiveram o responsável revertido na regra antiga (continuam em PCI12).
async function buscarPendentes() {
    return sequelize.query(
        `SELECT deal_id, owner_original_id, owner_original_nome, detectado_em, email_24h_enviado_em, revertido_em
         FROM bmax_pci12_tracking
         WHERE resolvido_em IS NULL AND auto_12b_em IS NULL`,
        { type: QueryTypes.SELECT }
    );
}

async function marcarEmail24hEnviado(dealId) {
    await sequelize.query(
        `UPDATE bmax_pci12_tracking SET email_24h_enviado_em = now() WHERE deal_id = :dealId`,
        { replacements: { dealId }, type: QueryTypes.UPDATE }
    );
}

async function marcarRevertido(dealId) {
    await sequelize.query(
        `UPDATE bmax_pci12_tracking SET revertido_em = now() WHERE deal_id = :dealId`,
        { replacements: { dealId }, type: QueryTypes.UPDATE }
    );
}

async function marcarResolvido(dealId) {
    await sequelize.query(
        `UPDATE bmax_pci12_tracking SET resolvido_em = now() WHERE deal_id = :dealId AND resolvido_em IS NULL`,
        { replacements: { dealId }, type: QueryTypes.UPDATE }
    );
}

// 12b aplicado automaticamente ao expirar o prazo de 48h.
async function marcarAuto12b(dealId) {
    await sequelize.query(
        `UPDATE bmax_pci12_tracking SET auto_12b_em = now(), resolvido_em = COALESCE(resolvido_em, now()) WHERE deal_id = :dealId`,
        { replacements: { dealId }, type: QueryTypes.UPDATE }
    );
}

// Dos ids informados, os que tiveram o 12b aplicado por expiração do prazo — o card
// mostra um aviso discreto (sem pedir nenhuma ação da revenda).
async function getDealsComPrazo48Expirado(ids) {
    if (!ids || !ids.length) return new Set();
    const rows = await sequelize.query(
        `SELECT deal_id FROM bmax_pci12_tracking WHERE auto_12b_em IS NOT NULL AND deal_id IN (:ids)`,
        { replacements: { ids }, type: QueryTypes.SELECT }
    );
    return new Set(rows.map(r => r.deal_id));
}

// Dono original (pré-troca pro André) registrado quando o PCI12 foi
// detectado — usado como fallback quando o caminho é BOX+REV>IND (Boxer
// vende) e a planilha de responsável por região não acha ninguém.
async function buscarOwnerOriginal(dealId) {
    const rows = await sequelize.query(
        `SELECT owner_original_id, owner_original_nome FROM bmax_pci12_tracking WHERE deal_id = :dealId`,
        { replacements: { dealId }, type: QueryTypes.SELECT }
    );
    return rows[0] || null;
}

// ─── PCI12a: prazo de 60 dias contado desde que a revenda assumiu ────────────

async function registrarAssumido(dealId, quando = null) {
    await sequelize.query(
        `INSERT INTO bmax_pci12a_prazo (deal_id, assumido_em) VALUES (:dealId, COALESCE(:quando, now()))
         ON CONFLICT (deal_id) DO NOTHING`,
        { replacements: { dealId, quando }, type: QueryTypes.INSERT }
    );
}

async function buscarPrazos12a() {
    return sequelize.query(
        `SELECT deal_id, assumido_em, arquivado_em FROM bmax_pci12a_prazo`,
        { type: QueryTypes.SELECT }
    );
}

async function marcarArquivado12a(dealId) {
    await sequelize.query(
        `UPDATE bmax_pci12a_prazo SET arquivado_em = now() WHERE deal_id = :dealId`,
        { replacements: { dealId }, type: QueryTypes.UPDATE }
    );
}

// Quando a revenda escolheu "Eu assumo" (log de auditoria) — pra leads que viraram
// 12a antes desta tabela existir. Sem registro devolve null (o chamador usa "agora").
async function buscarDataAssumidoNaAuditoria(dealId) {
    try {
        const rows = await sequelize.query(
            `SELECT MIN("createdAt") AS quando FROM "AuditLogs"
             WHERE action = 'SELECT_CAMINHO_VENDA' AND entity_id = :dealId AND metadata->>'caminho' = 'BOX>REV'`,
            { replacements: { dealId }, type: QueryTypes.SELECT }
        );
        return rows[0]?.quando || null;
    } catch { return null; }
}

// Escolha de caminho já feita por alguém (revenda/admin) segundo o log de auditoria — o robô de 48h NUNCA pode
// sobrescrevê-la (caso Telha Fabrica, 08/10/2026: a escolha BOX>REV das 10:12 foi desfeita pelo 12b automático das 14:29
// porque o PCI do card tinha voltado a "PCI 12"). Devolve { caminho, quando } da mais recente, ou null.
async function buscarEscolhaCaminhoNaAuditoria(dealId) {
    const rows = await sequelize.query(
        `SELECT metadata->>'caminho' AS caminho, "createdAt" AS quando FROM "AuditLogs"
         WHERE action = 'SELECT_CAMINHO_VENDA' AND entity_id = :dealId AND status = 'success'
         ORDER BY "createdAt" DESC LIMIT 1`,
        { replacements: { dealId }, type: QueryTypes.SELECT }
    );
    return rows[0] || null;
}

module.exports = {
    buscarEscolhaCaminhoNaAuditoria,
    registrarTroca,
    buscarPendentes,
    buscarOwnerOriginal,
    marcarEmail24hEnviado,
    marcarRevertido,
    marcarResolvido,
    marcarAuto12b,
    getDealsComPrazo48Expirado,
    registrarAssumido,
    buscarPrazos12a,
    marcarArquivado12a,
    buscarDataAssumidoNaAuditoria
};
