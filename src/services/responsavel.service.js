const path = require("path");
const fs = require("fs");
const { ESTADOS } = require("../config/constants");

const jsonPath = path.join(__dirname, "../data/ibge_responsaveis.json");
const xlsxPath = path.join(__dirname, "../data/Base IBGE_Area Vendedores Boxer.xlsx");

let cachedData = null;

function loadData() {
    if (cachedData) return cachedData;

    if (fs.existsSync(jsonPath)) {
        const raw = fs.readFileSync(jsonPath, "utf-8");
        cachedData = JSON.parse(raw).data;
        return cachedData;
    }

    const ExcelJS = require("exceljs");
    return null;
}

function resolveEstadoSigla(estado) {
    const valor = String(estado || "").trim();

    if (valor.length > 2) {
        const nomeEncontrado = Object.keys(ESTADOS).find(
            nome => nome.toUpperCase() === valor.toUpperCase()
        );
        if (nomeEncontrado) return ESTADOS[nomeEncontrado];
    }

    return valor.toUpperCase();
}

async function lerPlanilhaResponsavel(municipio, estado) {
    const estadoNormalizado = resolveEstadoSigla(estado);

    let data = loadData();

    if (data) {
        const entry = data.find(
            e => e.municipio === municipio && String(e.estado || "").trim().toUpperCase() === estadoNormalizado
        );
        return entry ? entry.responsavel : null;
    }

    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsxPath);
    const worksheet = workbook.getWorksheet("Base IBGE");

    let linha = 0;
    worksheet.getColumn(17).eachCell((cell, rowNumber) => {
        if (cell.value === municipio) {
            const estadoCell = String(worksheet.getCell(rowNumber, 2).value || "").trim().toUpperCase();
            if (estadoCell === estadoNormalizado) {
                linha = rowNumber;
            }
        }
    });

    if (!linha) return null;
    return worksheet.getCell(linha, 21).value || null;
}

module.exports = {
    lerPlanilhaResponsavel
};
