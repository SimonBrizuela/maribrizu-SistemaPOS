/**
 * Netlify Function: afip-padron
 * GET /api/afip-padron?cuit=20123456789
 *
 * Consulta el Padrón Público de AFIP (Alcance 4) — sin autenticación.
 * Devuelve nombre, domicilio, localidad y condición IVA estimada.
 */

'use strict';

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const cuit = ((event.queryStringParameters || {}).cuit || '').replace(/[-.\s]/g, '');

  if (!/^\d{11}$/.test(cuit)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'CUIT inválido. Debe tener 11 dígitos.' }) };
  }

  try {
    const res = await fetch(`https://soa.afip.gob.ar/sr-padron/v4/persona/${cuit}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (res.status === 404) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'CUIT no encontrado en el padrón de AFIP.' }) };
    }
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `AFIP respondió con error ${res.status}.` }) };
    }

    const json = await res.json();
    const persona = json.data || json;

    if (!persona || json.errorConstancia) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'CUIT no encontrado en el padrón de AFIP.' }) };
    }

    const dg          = persona.datosGenerales || {};
    const domFiscal   = dg.domicilioFiscal || {};
    const esFisica    = (persona.tipoPersona || '').toUpperCase() === 'FISICA';
    const estadoClave = (persona.estadoClave || '').toUpperCase();

    // Nombre
    let nombre = '';
    if (esFisica) {
      nombre = [dg.nombre, dg.apellido].filter(Boolean).join(' ');
    } else {
      nombre = dg.razonSocial || dg.denominacion || persona.nombre || '';
    }

    // Condición IVA estimada
    let condicion_iva = 'Consumidor Final';
    if (persona.categoriasMonotributo && persona.categoriasMonotributo.length > 0) {
      condicion_iva = 'Monotributista';
    } else if (!esFisica) {
      condicion_iva = 'Responsable Inscripto';
    } else if (dg.categoriaAutonomo) {
      condicion_iva = 'Responsable Inscripto';
    }

    // Domicilio
    const partesDom = [domFiscal.direccion, domFiscal.cp].filter(Boolean);
    const domicilio = partesDom.join(' ').trim();

    // Localidad
    const partesLoc = [domFiscal.localidad, domFiscal.descripcionProvincia].filter(Boolean);
    const localidad = partesLoc.join(', ').trim();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        nombre:        nombre.trim(),
        cuit,
        condicion_iva,
        domicilio,
        localidad,
        estado:        estadoClave,   // ACTIVO, INACTIVO, etc.
        tipo:          persona.tipoPersona || '',
      }),
    };

  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: timedOut ? 'AFIP no respondió a tiempo. Intentá de nuevo.' : `Error al consultar AFIP: ${err.message}` }),
    };
  }
};
