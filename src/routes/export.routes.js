const express = require("express");
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
                const pcisPorClasse = ["PCI13", "PCI14", "PCI15"];
                filtered = cards.filter(l => pcisPorClasse.includes((l.pci || "").toUpperCase().replace(/[^A-Z0-9]/g, "")) && !l.classePreco);
            }

            const headers = ["Nome", "CNPJ", "Cidade", "UF", "Revenda", "Rep", "Data", "PCI", "Máquina", "Valor", "Oportunidade", "Cashback", "Status"];
            const rows = filtered.map(l => [
                l.nome || "",
                l.cnpj || "",
                l.cidade || "",
                l.estado || "",
                l.revenda || "",
                l.representante || "",
                l.criadoem || "",
                l.pci || "",
                l.maquinainteresse || "",
                l.valor || "",
                l.oportunidadedevendas || "",
                l.cashback || 0,
                l.tag || ""
            ]);

            let csv = "﻿";
            csv += headers.join(";") + "\n";
            rows.forEach(r => {
                csv += r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";") + "\n";
            });

            res.setHeader("Content-Type", "text/csv; charset=utf-8");
            res.setHeader("Content-Disposition", 'attachment; filename="leads_bmax.csv"');
            res.send(csv);
        } catch (err) {
            logger.error({ message: "Erro export", error: err.message, stack: err.stack });
            res.status(500).json({ error: "Falha ao exportar leads" });
        }
    }
);

module.exports = router;
