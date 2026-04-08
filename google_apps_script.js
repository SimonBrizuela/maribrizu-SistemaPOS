// ============================================================
//  POS Sistema - Google Apps Script Webhook
//  Recibe datos del sistema POS y los guarda con formato
//  profesional en Google Sheets.
//
//  INSTALACION:
//  1. Extensiones > Apps Script > pegar este codigo > Guardar
//  2. Implementar > Nueva implementacion > App web
//     - Ejecutar como: Yo
//     - Acceso: Cualquier usuario (Anyone)
//  3. Copiar la URL y pegarla en config.py del POS:
//     GOOGLE_SHEETS_WEBHOOK_URL = "https://..."
// ============================================================

var MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Cabeceras de cada hoja
var HEADERS_VENTA     = ['#','Fecha','Hora','Productos','Cantidades','Tipo de Pago','Total ($)','Efectivo ($)','Cambio ($)','Cajero','Descuentos','Total Ahorrado ($)'];
var HEADERS_CIERRE    = ['ID','Fecha Apertura','Fecha Cierre','Inicial ($)','Ef. Vendido ($)','Transf. ($)','Total Ventas ($)','Retiros ($)','Esperado ($)','Final ($)','Diferencia ($)','# Ventas Ef.','# Ventas Tr.','Notas'];
var HEADERS_RETIRO    = ['#','Fecha','Hora','Monto ($)','Motivo','ID Caja'];
var HEADERS_RESUMEN   = ['Mes','Total Ventas ($)','Efectivo ($)','Transferencia ($)','Retiros ($)','# Transacciones','Ticket Promedio ($)','# Cierres'];
var HEADERS_INVENTARIO= ['ID','Producto','Categoria','Precio ($)','Costo ($)','Stock','Descuento','Estado','Ultima Actualizacion'];
var HEADERS_HIST_DIA  = ['Fecha','Mes','# Ventas','Total ($)','Efectivo ($)','Transferencia ($)','Ticket Promedio ($)'];
var HEADERS_PROD_MAS_VENDIDOS = ['Producto','Categoria','Total Vendido','Ingresos ($)','Ultima Venta'];
var HEADERS_VENTAS_DIA = ['Fecha','Hora','# Venta','Producto','Categoria','Cantidad','Precio Unit ($)','Subtotal ($)','Tipo de Pago','Cajero'];

// Colores principales
var C_VENTA    = '#1565C0';
var C_CIERRE   = '#2E7D32';
var C_RETIRO   = '#E65100';
var C_RESUMEN  = '#6A1B9A';
var C_INVENT   = '#00695C';
var C_HIST_DIA = '#37474F';
var C_PROD_MAS_VENDIDOS = '#E65100';
var C_VENTAS_DIA = '#1B5E20';
var C_ARCHIVO  = '#546E7A';
var C_WHITE    = '#FFFFFF';

// Colores de estado de stock
var C_STOCK_OK   = '#E8F5E9';  // verde claro
var C_STOCK_LOW  = '#FFF9C4';  // amarillo claro
var C_STOCK_CRIT = '#FFEBEE';  // rojo claro
var C_STOCK_ZERO = '#FCE4EC';  // rosa

// ============================================================
//  WEBHOOK PRINCIPAL
// ============================================================

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, status: 'POS Webhook activo' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var tipo    = payload.tipo;
    var hoja    = payload.hoja;
    var datos   = payload.datos;
    var ss      = SpreadsheetApp.getActiveSpreadsheet();

    if (tipo === 'inventario') {
      syncInventario(ss, payload.productos);
      return ok('Inventario');
    }

    if (tipo === 'resumen_dia') {
      syncHistorialDia(ss, datos);
      return ok('Historial Diario');
    }

    if (tipo === 'productos_mas_vendidos') {
      syncProductosMasVendidos(ss, payload.productos);
      return ok('Productos Mas Vendidos');
    }

    if (tipo === 'ventas_dia') {
      syncVentasPorDia(ss, datos);
      return ok('Ventas por Dia');
    }

    if (tipo === 'limpiar') {
      // Limpia una hoja antes de re-sync completo para evitar duplicados
      clearAndRebuild(ss, payload.subtipo || 'venta', hoja);
      return ok('limpiar:' + hoja);
    }

    var sheet = getOrCreateSheet(ss, tipo, hoja);

    // Upsert: actualizar fila existente si el ID ya existe, sino agregar nueva
    var updated = upsertRow(sheet, tipo, datos);
    if (!updated) {
      sheet.appendRow(datos);
      formatLastRow(sheet, tipo);
    }
    sheet.autoResizeColumns(1, sheet.getLastColumn());

    if (tipo === 'venta') {
      updateMonthlySummary(ss, hoja);
    }

    return ok(hoja);

  } catch (err) {
    Logger.log('doPost error: ' + err.toString());
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function ok(hoja) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, hoja: hoja }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  UPSERT - Actualizar fila si existe, sino insertar
// ============================================================

function upsertRow(sheet, tipo, datos) {
  // Todos los tipos ahora tienen un ID único en la primera columna (col 1):
  // Para ventas:  col 1 = ID Venta
  // Para cierres: col 1 = ID Cierre
  // Para retiros: col 1 = ID Retiro (nuevo)

  var keyValue = datos[0];

  if (!keyValue && keyValue !== 0) return false;

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return false; // solo cabecera, nada que buscar

  var colData = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

  for (var i = 0; i < colData.length; i++) {
    if (String(colData[i][0]) === String(keyValue)) {
      // Fila encontrada: actualizar (upsert)
      var rowNum = i + 2; // +2 por cabecera y 0-index
      sheet.getRange(rowNum, 1, 1, datos.length).setValues([datos]);
      formatRowByIndex(sheet, rowNum, tipo);
      return true;
    }
  }

  return false; // no encontrada → se insertará como nueva fila
}

function formatRowByIndex(sheet, rowNum, tipo) {
  var lastCol = sheet.getLastColumn();
  var bg = (rowNum % 2 === 0) ? '#F5F5F5' : '#FFFFFF';
  sheet.getRange(rowNum, 1, 1, lastCol).setBackground(bg);

  if (tipo === 'venta') {
    sheet.getRange(rowNum, 7, 1, 3).setNumberFormat('"$"#,##0.00');
    sheet.getRange(rowNum, 12, 1, 1).setNumberFormat('"$"#,##0.00');
    var tipoPago = sheet.getRange(rowNum, 6).getValue();
    if (tipoPago === 'Transferencia') {
      sheet.getRange(rowNum, 6, 1, 1).setBackground('#E3F2FD').setFontColor('#1565C0');
    } else {
      sheet.getRange(rowNum, 6, 1, 1).setBackground('#E8F5E9').setFontColor('#2E7D32');
    }
    // Colorear descuentos si hay ahorro
    var ahorro = parseFloat(sheet.getRange(rowNum, 12).getValue()) || 0;
    if (ahorro > 0) {
      sheet.getRange(rowNum, 11, 1, 2).setFontColor('#C62828').setFontWeight('bold');
    }
  } else if (tipo === 'cierre') {
    sheet.getRange(rowNum, 4, 1, 8).setNumberFormat('"$"#,##0.00');
    var diff = parseFloat(sheet.getRange(rowNum, 11).getValue());
    if (diff < 0) sheet.getRange(rowNum, 11).setFontColor('#C62828').setFontWeight('bold');
    else if (diff > 0) sheet.getRange(rowNum, 11).setFontColor('#2E7D32').setFontWeight('bold');
  } else if (tipo === 'retiro') {
    // Col 4 = Monto (ahora que col 1 = ID)
    sheet.getRange(rowNum, 4, 1, 1).setNumberFormat('"$"#,##0.00').setFontColor('#E65100').setFontWeight('bold');
  }
}

// ============================================================
//  INVENTARIO
// ============================================================

function syncInventario(ss, productos) {
  var sheet = getOrCreateSheet(ss, 'inventario', 'Inventario');

  // Limpiar datos anteriores (mantener cabecera)
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent().clearFormat();
  }

  if (!productos || productos.length === 0) return;

  // Escribir todos los productos
  for (var i = 0; i < productos.length; i++) {
    var p = productos[i];
    var stock = parseInt(p.stock) || 0;
    var estado;
    if      (stock <= 0)  estado = 'AGOTADO';
    else if (stock <= 3)  estado = 'CRITICO';
    else if (stock <= 10) estado = 'BAJO';
    else                  estado = 'OK';

    var descuento = p.descuento || '';
    var row = [p.id, p.nombre, p.categoria, p.precio, p.costo, stock, descuento, estado, p.actualizado];
    sheet.appendRow(row);

    // Color de fila segun estado de stock
    var rowNum = sheet.getLastRow();
    var bgColor;
    if      (stock <= 0)  bgColor = C_STOCK_ZERO;
    else if (stock <= 3)  bgColor = C_STOCK_CRIT;
    else if (stock <= 10) bgColor = C_STOCK_LOW;
    else                  bgColor = C_STOCK_OK;

    sheet.getRange(rowNum, 1, 1, 9).setBackground(bgColor);

    // Negrita y rojo en stock critico/agotado
    if (stock <= 3) {
      sheet.getRange(rowNum, 6, 1, 2).setFontWeight('bold').setFontColor('#C62828');
    }
    // Resaltar descuento en rojo si tiene
    if (descuento) {
      sheet.getRange(rowNum, 7, 1, 1).setFontColor('#C62828').setFontWeight('bold');
    }
  }

  // Formato moneda en columnas precio y costo
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 4, sheet.getLastRow() - 1, 2).setNumberFormat('"$"#,##0.00');
    sheet.getRange(2, 6, sheet.getLastRow() - 1, 1).setNumberFormat('#,##0');
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).setHorizontalAlignment('center');
    sheet.getRange(2, 6, sheet.getLastRow() - 1, 1).setHorizontalAlignment('center');
    sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).setHorizontalAlignment('center');
    sheet.getRange(2, 8, sheet.getLastRow() - 1, 1).setHorizontalAlignment('center');
  }

  sheet.autoResizeColumns(1, 9);

  // Fila de resumen al pie
  var totalProds = productos.length;
  var agotados   = productos.filter(function(p){ return parseInt(p.stock) <= 0; }).length;
  var criticos   = productos.filter(function(p){ return parseInt(p.stock) > 0 && parseInt(p.stock) <= 3; }).length;
  var bajos      = productos.filter(function(p){ return parseInt(p.stock) > 3 && parseInt(p.stock) <= 10; }).length;
  var conDesc    = productos.filter(function(p){ return p.descuento && p.descuento !== ''; }).length;

  sheet.appendRow(['RESUMEN', 'Total: ' + totalProds, 'Agotados: ' + agotados, 'Con desc: ' + conDesc, 'Criticos: ' + criticos, 'Bajos: ' + bajos, '', '', '']);
  var summRow = sheet.getLastRow();
  sheet.getRange(summRow, 1, 1, 9)
    .setBackground('#37474F')
    .setFontColor('#FFFFFF')
    .setFontWeight('bold')
    .setHorizontalAlignment('center');
}

// ============================================================
//  PRODUCTOS MAS VENDIDOS
// ============================================================

function syncProductosMasVendidos(ss, productos) {
  var sheet = getOrCreateSheet(ss, 'productos_mas_vendidos', 'Productos Mas Vendidos');

  // Limpiar datos anteriores (mantener cabecera)
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent().clearFormat();
  }

  if (!productos || productos.length === 0) return;

  // Ordenar por total vendido descendente
  productos.sort(function(a, b) {
    return (parseInt(b.total_vendido) || 0) - (parseInt(a.total_vendido) || 0);
  });

  for (var i = 0; i < productos.length; i++) {
    var p = productos[i];
    var row = [p.nombre, p.categoria, p.total_vendido, p.ingresos, p.ultima_venta];
    sheet.appendRow(row);

    var rowNum = sheet.getLastRow();
    // Color degradado: top 3 dorado, resto alternado
    var bgColor;
    if      (i === 0) bgColor = '#FFF9C4'; // Oro
    else if (i === 1) bgColor = '#F5F5F5'; // Plata
    else if (i === 2) bgColor = '#FBE9E7'; // Bronce
    else              bgColor = (rowNum % 2 === 0) ? '#F9FBE7' : '#FFFFFF';

    sheet.getRange(rowNum, 1, 1, 5).setBackground(bgColor);

    // Negrita para top 3
    if (i < 3) {
      sheet.getRange(rowNum, 1, 1, 5).setFontWeight('bold');
    }

    // Formato moneda en Ingresos
    sheet.getRange(rowNum, 4, 1, 1).setNumberFormat('"$"#,##0.00');
    // Centrar cantidad
    sheet.getRange(rowNum, 3, 1, 1).setHorizontalAlignment('center');
  }

  sheet.autoResizeColumns(1, 5);
}

// ============================================================
//  VENTAS POR DIA (detalle de productos vendidos cada dia)
// ============================================================

function syncVentasPorDia(ss, datos) {
  var sheet = getOrCreateSheet(ss, 'ventas_dia', 'Ventas por Dia');
  // datos = [fecha, hora, num_venta, producto, categoria, cantidad, precio_unit, subtotal, tipo_pago, cajero]

  var fecha    = String(datos[0]).trim();
  var numVenta = String(datos[2]).trim();

  // Buscar si ya existe la combinacion fecha+num_venta+producto (upsert)
  var lastRow = sheet.getLastRow();
  var targetRow = -1;

  if (lastRow > 1) {
    var allData = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    for (var i = 0; i < allData.length; i++) {
      if (String(allData[i][0]).trim() === fecha &&
          String(allData[i][2]).trim() === numVenta &&
          String(sheet.getRange(i + 2, 4).getValue()).trim() === String(datos[3]).trim()) {
        targetRow = i + 2;
        break;
      }
    }
  }

  if (targetRow > 0) {
    sheet.getRange(targetRow, 1, 1, datos.length).setValues([datos]);
  } else {
    sheet.appendRow(datos);
    targetRow = sheet.getLastRow();
  }

  // Formato
  sheet.getRange(targetRow, 7, 1, 2).setNumberFormat('"$"#,##0.00');
  sheet.getRange(targetRow, 1, 1, 3).setHorizontalAlignment('center');
  sheet.getRange(targetRow, 6, 1, 1).setHorizontalAlignment('center');

  // Color segun tipo de pago
  var tipoPago = String(datos[8]);
  var bg;
  if (tipoPago === 'Transferencia') bg = '#E3F2FD';
  else                              bg = (targetRow % 2 === 0) ? '#F1F8E9' : '#FFFFFF';
  sheet.getRange(targetRow, 1, 1, datos.length).setBackground(bg);

  sheet.autoResizeColumns(1, datos.length);
}

// ============================================================
//  HISTORIAL DIARIO
// ============================================================

function clearAndRebuild(ss, tipo, nombreHoja) {
  // Limpia todos los datos de una hoja (mantiene cabecera) para re-sync completo
  var sheet = getOrCreateSheet(ss, tipo, nombreHoja);
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent().clearFormat();
  }
}

function syncHistorialDia(ss, datos) {
  var sheet = getOrCreateSheet(ss, 'resumen_dia', 'Historial Diario');
  var fecha = String(datos[0]).trim();

  // Buscar si ya existe la fila de ese dia (upsert por fecha)
  var lastRow = sheet.getLastRow();
  var targetRow = -1;

  Logger.log('syncHistorialDia: buscando fecha=' + fecha + ' lastRow=' + lastRow);

  if (lastRow > 1) {
    var fechas = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var i = 0; i < fechas.length; i++) {
      var cellVal = String(fechas[i][0]).trim();
      Logger.log('  comparando [' + cellVal + '] con [' + fecha + '] -> ' + (cellVal === fecha));
      if (cellVal === fecha) {
        targetRow = i + 2;
        break;
      }
    }
  }

  Logger.log('syncHistorialDia: targetRow=' + targetRow);

  if (targetRow > 0) {
    // Actualizar fila existente
    sheet.getRange(targetRow, 1, 1, datos.length).setValues([datos]);
  } else {
    // Agregar fila nueva
    sheet.appendRow(datos);
    targetRow = sheet.getLastRow();
  }

  // Formato moneda columnas D-G (indices 4-7, 1-indexed)
  sheet.getRange(targetRow, 4, 1, 4).setNumberFormat('"$"#,##0.00');
  // Centrar columnas fecha y # ventas
  sheet.getRange(targetRow, 1, 1, 3).setHorizontalAlignment('center');

  // Color alternado por fila
  var bg = (targetRow % 2 === 0) ? '#ECEFF1' : '#FFFFFF';
  sheet.getRange(targetRow, 1, 1, datos.length).setBackground(bg);

  sheet.autoResizeColumns(1, datos.length);
}

// ============================================================
//  FORMATO DE ULTIMA FILA AGREGADA
// ============================================================

function formatLastRow(sheet, tipo) {
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var lastCol = sheet.getLastColumn();

  // Color alternado de filas
  var bg = (lastRow % 2 === 0) ? '#F5F5F5' : '#FFFFFF';
  sheet.getRange(lastRow, 1, 1, lastCol).setBackground(bg);

  // Formato moneda segun tipo
  if (tipo === 'venta') {
    // Columnas: Total(7), Efectivo(8), Cambio(9), Total Ahorrado(12)
    sheet.getRange(lastRow, 7, 1, 3).setNumberFormat('"$"#,##0.00');
    sheet.getRange(lastRow, 12, 1, 1).setNumberFormat('"$"#,##0.00');
    // Centrar columnas fijas
    sheet.getRange(lastRow, 1, 1, 1).setHorizontalAlignment('center');
    sheet.getRange(lastRow, 2, 1, 2).setHorizontalAlignment('center');
    sheet.getRange(lastRow, 6, 1, 1).setHorizontalAlignment('center');
    // Color diferente si es transferencia
    var tipoPago = sheet.getRange(lastRow, 6).getValue();
    if (tipoPago === 'Transferencia') {
      sheet.getRange(lastRow, 6, 1, 1).setBackground('#E3F2FD').setFontColor('#1565C0');
    } else {
      sheet.getRange(lastRow, 6, 1, 1).setBackground('#E8F5E9').setFontColor('#2E7D32');
    }
    // Resaltar descuentos en rojo si hay ahorro
    var ahorro = parseFloat(sheet.getRange(lastRow, 12).getValue()) || 0;
    if (ahorro > 0) {
      sheet.getRange(lastRow, 11, 1, 2).setFontColor('#C62828').setFontWeight('bold');
    }
  } else if (tipo === 'cierre') {
    // Columnas de montos: D-K (4-11)
    sheet.getRange(lastRow, 4, 1, 8).setNumberFormat('"$"#,##0.00');
    // Diferencia: rojo si negativa, verde si positiva
    var diff = sheet.getRange(lastRow, 11).getValue();
    if (parseFloat(diff) < 0) {
      sheet.getRange(lastRow, 11, 1, 1).setFontColor('#C62828').setFontWeight('bold');
    } else if (parseFloat(diff) > 0) {
      sheet.getRange(lastRow, 11, 1, 1).setFontColor('#2E7D32').setFontWeight('bold');
    }
  } else if (tipo === 'retiro') {
    // Col 4 = Monto (ahora que col 1 = ID)
    sheet.getRange(lastRow, 4, 1, 1).setNumberFormat('"$"#,##0.00');
    sheet.getRange(lastRow, 4, 1, 1).setFontColor('#E65100').setFontWeight('bold');
  }
}

// ============================================================
//  GESTION DE HOJAS
// ============================================================

function isMonthSheet(nombre) {
  for (var i = 1; i < MESES.length; i++) {
    if (nombre.indexOf(MESES[i] + ' ') === 0) return true;
  }
  return false;
}

function getHeaders(tipo, hoja) {
  if (tipo === 'venta'           || isMonthSheet(hoja))              return HEADERS_VENTA;
  if (tipo === 'cierre'          || hoja === 'Cierres de Caja')      return HEADERS_CIERRE;
  if (tipo === 'retiro'          || hoja === 'Retiros')              return HEADERS_RETIRO;
  if (tipo === 'inventario'      || hoja === 'Inventario')           return HEADERS_INVENTARIO;
  if (tipo === 'resumen_dia'     || hoja === 'Historial Diario')     return HEADERS_HIST_DIA;
  if (tipo === 'productos_mas_vendidos' || hoja === 'Productos Mas Vendidos') return HEADERS_PROD_MAS_VENDIDOS;
  if (tipo === 'ventas_dia'      || hoja === 'Ventas por Dia')       return HEADERS_VENTAS_DIA;
  if (hoja === 'Resumen Mensual')                                     return HEADERS_RESUMEN;
  return HEADERS_VENTA;
}

function getSheetColor(tipo, hoja) {
  if (tipo === 'venta'           || isMonthSheet(hoja))              return C_VENTA;
  if (tipo === 'cierre'          || hoja === 'Cierres de Caja')      return C_CIERRE;
  if (tipo === 'retiro'          || hoja === 'Retiros')              return C_RETIRO;
  if (tipo === 'inventario'      || hoja === 'Inventario')           return C_INVENT;
  if (tipo === 'resumen_dia'     || hoja === 'Historial Diario')     return C_HIST_DIA;
  if (tipo === 'productos_mas_vendidos' || hoja === 'Productos Mas Vendidos') return C_PROD_MAS_VENDIDOS;
  if (tipo === 'ventas_dia'      || hoja === 'Ventas por Dia')       return C_VENTAS_DIA;
  if (hoja === 'Resumen Mensual')                                     return C_RESUMEN;
  return C_VENTA;
}

function writeHeader(sheet, headers, colorHex) {
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setBackground(colorHex)
    .setFontColor(C_WHITE)
    .setFontWeight('bold')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
  sheet.setRowHeight(1, 32);
  sheet.setFrozenRows(1);
  // Color de pestana igual al color del header
  sheet.setTabColor(colorHex);
}

function getOrCreateSheet(ss, tipo, nombreHoja) {
  var sheet = ss.getSheetByName(nombreHoja);
  if (!sheet) {
    sheet = ss.insertSheet(nombreHoja);
    var headers = getHeaders(tipo, nombreHoja);
    writeHeader(sheet, headers, getSheetColor(tipo, nombreHoja));
  } else {
    // Siempre verificar que el número de columnas del header sea correcto
    var headers = getHeaders(tipo, nombreHoja);
    var currentCols = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    var needsUpdate = currentCols.length !== headers.length || currentCols[0] !== headers[0];
    if (needsUpdate) {
      // Extender columnas si hace falta antes de reescribir header
      if (sheet.getLastColumn() < headers.length) {
        // Insertar columnas extra al final
        sheet.insertColumnsAfter(sheet.getLastColumn(), headers.length - sheet.getLastColumn());
      }
      writeHeader(sheet, headers, getSheetColor(tipo, nombreHoja));
    }
  }
  return sheet;
}

// ============================================================
//  RESUMEN MENSUAL AUTOMATICO
// ============================================================

function updateMonthlySummary(ss, mesNombre) {
  try {
    var monthSheet = ss.getSheetByName(mesNombre);
    if (!monthSheet || monthSheet.getLastRow() <= 1) return;

    var data = monthSheet.getRange(2, 1, monthSheet.getLastRow() - 1, 10).getValues();
    var totalVentas = 0, efectivo = 0, transferencia = 0, nTx = data.length;

    for (var i = 0; i < data.length; i++) {
      var total    = parseFloat(data[i][6]) || 0;
      var tipoPago = data[i][5] || '';
      totalVentas += total;
      if (tipoPago === 'Efectivo') efectivo += total;
      else transferencia += total;
    }

    var ticketPromedio = nTx > 0 ? (totalVentas / nTx) : 0;
    var totalRetiros   = getMonthlyWithdrawals(ss, mesNombre);
    var nCierres       = getMonthlyClosingsCount(ss, mesNombre);

    var summarySheet = getOrCreateSheet(ss, 'resumen', 'Resumen Mensual');
    var allData      = summarySheet.getDataRange().getValues();
    var targetRow    = -1;
    for (var j = 1; j < allData.length; j++) {
      // Comparacion case-insensitive para evitar duplicados por mayusculas
      if (String(allData[j][0]).toLowerCase() === mesNombre.toLowerCase()) { targetRow = j + 1; break; }
    }

    var newRow = [mesNombre, totalVentas, efectivo, transferencia, totalRetiros, nTx, ticketPromedio, nCierres];
    if (targetRow > 0) {
      summarySheet.getRange(targetRow, 1, 1, newRow.length).setValues([newRow]);
    } else {
      summarySheet.appendRow(newRow);
      targetRow = summarySheet.getLastRow();
    }

    // Formato moneda
    summarySheet.getRange(targetRow, 2, 1, 5).setNumberFormat('"$"#,##0.00');
    summarySheet.getRange(targetRow, 7, 1, 1).setNumberFormat('"$"#,##0.00');

    // Color alternado
    var lr  = summarySheet.getLastRow();
    var lc  = summarySheet.getLastColumn();
    var bg  = (targetRow % 2 === 0) ? '#EDE7F6' : '#F3E5F5';
    summarySheet.getRange(targetRow, 1, 1, lc).setBackground(bg);

  } catch (err) {
    Logger.log('updateMonthlySummary error: ' + err.toString());
  }
}

function getMonthlyWithdrawals(ss, mesNombre) {
  try {
    var sheet = ss.getSheetByName('Retiros');
    if (!sheet || sheet.getLastRow() <= 1) return 0;
    // Columnas: #(1), Fecha(2), Hora(3), Monto(4), Motivo(5), ID Caja(6)
    var data   = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
    var parts  = mesNombre.split(' ');
    var mesNum = MESES.indexOf(parts[0]);
    var anio   = parts[1];
    var total  = 0;
    for (var i = 0; i < data.length; i++) {
      var fParts = String(data[i][1]).split('/'); // col 2 = Fecha (índice 1)
      if (fParts.length === 3 && parseInt(fParts[1]) === mesNum && fParts[2] === anio)
        total += parseFloat(data[i][3]) || 0;    // col 4 = Monto (índice 3)
    }
    return total;
  } catch (e) { return 0; }
}

function getMonthlyClosingsCount(ss, mesNombre) {
  try {
    var sheet = ss.getSheetByName('Cierres de Caja');
    if (!sheet || sheet.getLastRow() <= 1) return 0;
    var data   = sheet.getRange(2, 3, sheet.getLastRow() - 1, 1).getValues();
    var parts  = mesNombre.split(' ');
    var mesNum = MESES.indexOf(parts[0]);
    var anio   = parts[1];
    var count  = 0;
    for (var i = 0; i < data.length; i++) {
      var fParts = String(data[i][0]).split(' ')[0].split('/');
      if (fParts.length === 3 && parseInt(fParts[1]) === mesNum && fParts[2] === anio) count++;
    }
    return count;
  } catch (e) { return 0; }
}

// ============================================================
//  MENU PERSONALIZADO
// ============================================================

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('POS Sistema')
    .addItem('Actualizar Resumen Mensual', 'updateAllSummaries')
    .addItem('Formatear Todas las Hojas', 'formatAllSheets')
    .addSeparator()
    .addItem('⚠ Reparar columnas de descuento', 'repairDiscountColumns')
    .addSeparator()
    .addItem('Archivar Mes Anterior', 'archivePreviousMonth')
    .addSeparator()
    .addItem('Configurar Trigger Mensual', 'setupMonthlyTrigger')
    .addToUi();
}

// ============================================================
//  FORMATO DE HOJAS NUEVAS EN formatAllSheets
// (ya incluido arriba en el bloque formatAllSheets)

// ============================================================
//  REPARAR COLUMNAS DE DESCUENTO EN HOJAS EXISTENTES
// ============================================================

function repairDiscountColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ui = SpreadsheetApp.getUi();
  var repaired = [];

  // 1. Reparar hoja Inventario: insertar columna Descuento en posición 7
  var invSheet = ss.getSheetByName('Inventario');
  if (invSheet) {
    var invHeaders = invSheet.getRange(1, 1, 1, invSheet.getLastColumn()).getValues()[0];
    // Si tiene 8 columnas sin "Descuento", insertar en col 7
    if (invHeaders.length === 8 && invHeaders[6] !== 'Descuento') {
      invSheet.insertColumnBefore(7);
      invSheet.getRange(1, 7).setValue('Descuento')
        .setBackground(C_INVENT).setFontColor(C_WHITE).setFontWeight('bold')
        .setHorizontalAlignment('center');
      // Rellenar con vacío para filas existentes (ya tienen vacío por defecto)
      repaired.push('Inventario');
    }
  }

  // 2. Reparar hojas de ventas (meses): insertar columnas 11 y 12
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var name = sheet.getName();
    if (!isMonthSheet(name)) continue;
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    // Si tiene 10 columnas sin Descuentos, agregar las 2 nuevas
    if (headers.length === 10 && headers[9] === 'Cajero') {
      // Agregar 2 columnas al final
      sheet.insertColumnsAfter(10, 2);
      sheet.getRange(1, 11).setValue('Descuentos');
      sheet.getRange(1, 12).setValue('Total Ahorrado ($)');
      sheet.getRange(1, 11, 1, 2)
        .setBackground(C_VENTA).setFontColor(C_WHITE).setFontWeight('bold')
        .setHorizontalAlignment('center');
      repaired.push(name);
    }
  }

  if (repaired.length > 0) {
    ui.alert('✅ Hojas reparadas:\n' + repaired.join('\n') + '\n\nLas columnas nuevas fueron insertadas correctamente.');
  } else {
    ui.alert('✅ Todo en orden. No se encontraron hojas que necesiten reparación.');
  }
}

// ============================================================
//  ARCHIVAR MES
// ============================================================

function archivePreviousMonth() {
  var now  = new Date();
  var prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var mesNombre = MESES[prev.getMonth() + 1] + ' ' + prev.getFullYear();
  var ss    = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(mesNombre);

  if (!sheet) { SpreadsheetApp.getUi().alert('No se encontro: ' + mesNombre); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    // Fila de totales
    sheet.appendRow(['', '', '', 'TOTAL DEL MES', '', '',
      '=SUM(G2:G' + lastRow + ')',
      '=SUM(H2:H' + lastRow + ')',
      '', '']);
    var tr = sheet.getLastRow();
    sheet.getRange(tr, 1, 1, sheet.getLastColumn())
      .setBackground('#1A237E')
      .setFontColor('#FFFFFF')
      .setFontWeight('bold');
    sheet.getRange(tr, 7, 1, 2).setNumberFormat('"$"#,##0.00');
    sheet.setRowHeight(tr, 28);
  }

  var prefix = '[' + prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0') + '] ';
  sheet.setName(prefix + mesNombre);
  sheet.setTabColor(C_ARCHIVO);

  SpreadsheetApp.getUi().alert('Mes archivado: ' + prefix + mesNombre);
}

// ============================================================
//  FORMATEAR TODAS LAS HOJAS
// ============================================================

function formatAllSheets() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();

  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var name  = sheet.getName();
    var color;

    if      (isMonthSheet(name))             color = C_VENTA;
    else if (name === 'Cierres de Caja')     color = C_CIERRE;
    else if (name === 'Retiros')             color = C_RETIRO;
    else if (name === 'Inventario')          color = C_INVENT;
    else if (name === 'Historial Diario')       color = C_HIST_DIA;
    else if (name === 'Resumen Mensual')        color = C_RESUMEN;
    else if (name === 'Productos Mas Vendidos') color = C_PROD_MAS_VENDIDOS;
    else if (name === 'Ventas por Dia')         color = C_VENTAS_DIA;
    else continue;

    var lc = sheet.getLastColumn();
    if (lc < 1) continue;

    // Header
    sheet.getRange(1, 1, 1, lc)
      .setBackground(color)
      .setFontColor(C_WHITE)
      .setFontWeight('bold')
      .setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    sheet.setRowHeight(1, 32);
    sheet.setTabColor(color);
    sheet.autoResizeColumns(1, lc);

    // Bordes en todos los datos
    if (sheet.getLastRow() > 1) {
      sheet.getRange(1, 1, sheet.getLastRow(), lc)
        .setBorder(true, true, true, true, true, true, '#CFD8DC', SpreadsheetApp.BorderStyle.SOLID);
    }
  }

  SpreadsheetApp.getUi().alert('Formato aplicado a todas las hojas.');
}

// ============================================================
//  ACTUALIZAR TODOS LOS RESUMENES
// ============================================================

function updateAllSummaries() {
  var ss      = SpreadsheetApp.getActiveSpreadsheet();
  var sheets  = ss.getSheets();
  var updated = 0;
  for (var i = 0; i < sheets.length; i++) {
    var name = sheets[i].getName();
    if (isMonthSheet(name)) { updateMonthlySummary(ss, name); updated++; }
  }
  SpreadsheetApp.getUi().alert('Resumen actualizado para ' + updated + ' mes(es).');
}

// ============================================================
//  TRIGGER MENSUAL
// ============================================================

function setupMonthlyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'archivePreviousMonth') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('archivePreviousMonth').timeBased().onMonthDay(1).atHour(2).create();
  SpreadsheetApp.getUi().alert('Trigger configurado. El dia 1 de cada mes a las 2AM se archiva automaticamente.');
}
