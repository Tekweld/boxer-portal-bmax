const express = require("express");
const XLSX = require("xlsx");
const { authenticate, authorize } = require("../middlewares/auth");
const { getCachedLeads } = require("../services/cache.service");
const { getLeads, mapDealToCard } = require("../services/rd.leads.service");
const { logger } = require("../logger");

const router = express.Router();

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
                const leads = await getLeads(req.user.username, "adm");
                cards = await Promise.all(leads.map(l => mapDealToCard(l, "adm")));
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

            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
            res.setHeader("Content-Disposition", 'attachment; filename="leads_bmax.xlsx"');
            res.send(Buffer.from(buf));
        } catch (err) {
            logger.error({ message: "Erro export", error: err.message, stack: err.stack });
            res.status(500).json({ error: "Falha ao exportar leads" });
        }
    }
);

module.exports = router;
