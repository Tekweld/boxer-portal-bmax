const express = require("express");
const XLSX = require("xlsx");
const { authenticate, authorize } = require("../middlewares/auth");
const { getCachedLeads } = require("../services/cache.service");
const { buildLeadsCards } = require("../services/rd.leads.service");
const { sbSistemasAnon } = require("../config/supabaseSistemas");
const { logger } = require("../logger");

const router = express.Router();

// Sufixo de arquivo por filtro — deixa explícito no nome do download que a
// exportação é uma fatia filtrada, não a base completa de leads (o "filtro
// fantasma" reportado: o export sempre reaproveita o alerta ativo na tela).
const FILTER_SUFFIX = {
    semPci: "sem-pci",
    semOportunidade: "sem-oportunidade",
    semRepresentante: "sem-representante",
    semRevenda: "sem-revenda",
    semClasse: "sem-classe",
    repInvalido: "rep-invalido"
};

router.get(
    "/leads",
    authenticate,
    authorize(["adm"]),
    async (req, res) => {
        try {
            const cacheKey = `adm:${req.user.username}`;
            let cards;
            try {
                cards = await getCachedLeads(cacheKey);
            } catch (_) {}

            if (!cards) {
                cards = await buildLeadsCards("adm", req.user.username);
            }

            if (!cards || !cards.length) {
                return res.status(404).json({ error: "Nenhum lead encontrado" });
            }

            const filter = req.query.filter;
            const invalidos = ["", "?????", "?", "Vazio", "N/D"];
            let filtered = cards;

            if (filter === "semPci") {
                filtered = cards.filter(l => !l.pci || l.pci === "N/D" || l.pci === "PCI12");
            } else if (filter === "semOportunidade") {
                filtered = cards.filter(l => !l.oportunidadedevendas || l.oportunidadedevendas.trim() === "");
            } else if (filter === "semRepresentante") {
                filtered = cards.filter(l => invalidos.includes((l.representante || "").trim()));
            } else if (filter === "semRevenda") {
                filtered = cards.filter(l => invalidos.includes((l.revenda || "").trim()));
            } else if (filter === "semClasse") {
                filtered = cards.filter(l => !l.classePreco);
            } else if (filter === "repInvalido") {
                const repsAtivos = await sbSistemasAnon('/comercial_representantes_bmax?ativo=eq.true&select=nome');
                const validReps = new Set((repsAtivos || []).map(r => r.nome.trim()));
                filtered = cards.filter(l => {
                    const rep = (l.representante || "").trim();
                    return !invalidos.includes(rep) && rep && !validReps.has(rep);
                });
            }

            const headers = ["Nome", "CNPJ", "Cidade", "UF", "Revenda", "Rep", "Responsável RD", "Data", "PCI", "Máquina", "Valor", "Oportunidade", "Classe Preço", "Cashback", "Status"];
            const rows = filtered.map(l => [
                l.nome || "",
                l.cnpj || "",
                l.cidade || "",
                l.estado || "",
                l.revenda || "",
                l.representante || "",
                l.responsavelRd || "",
                l.criadoem || "",
                l.pci || "",
                l.maquinainteresse || "",
                l.valor || "",
                l.oportunidadedevendas || "",
                l.classePreco || "",
                l.cashback || 0,
                l.tag || ""
            ]);

            const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
            ws["!cols"] = headers.map((h, i) => ({
                wch: Math.max(h.length, ...rows.map(r => String(r[i] ?? "").length)) + 2
            }));
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "Leads");
            const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

            const suffix = FILTER_SUFFIX[filter];
            const filename = suffix ? `leads_bmax_${suffix}.xlsx` : "leads_bmax.xlsx";

            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
            res.send(Buffer.from(buf));
        } catch (err) {
            logger.error({ message: "Erro export", error: err.message, stack: err.stack });
            res.status(500).json({ error: "Falha ao exportar leads" });
        }
    }
);

module.exports = router;
