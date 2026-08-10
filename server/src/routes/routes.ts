import type { FastifyInstance, FastifyRequest } from 'fastify';
import { one, query, withClient } from '../db.ts';
import { requireAuth, requirePermission } from '../auth.ts';
import { geocodeAddr } from '../geocode.ts';
import { fuelEstimate } from '../fuel.ts';
import { scopeOwner, canWriteOwned } from '../scope.ts';
import { config } from '../config.ts';
import { resolveOrgOrigin } from '../origin.ts';

// Planejador de rota. Empresas selecionadas (do funil) -> melhor ordem de visita
// (TSP via OSRM /trip público) -> distância/duração ida-e-volta -> custo de combustível
// a partir do veículo cadastrado. POST /optimize só calcula (preview); POST / persiste.

const MAX_STOPS = 25;                 // limite do OSRM público (ida+volta = MAX_STOPS+1 pontos)

type Geo = { lat: number; lon: number };

// Geocode de uma empresa: cache -> geocodificação do endereço -> centroide do município.
async function geocodeCompany(id: number): Promise<Geo | null> {
  const cached = await one<Geo>('SELECT lat, lon FROM company_geocode WHERE company_id = $1', [id]);
  if (cached) return cached;

  const c = await one<{
    logradouro: string | null; numero: string | null; bairro: string | null;
    cep: string | null; cidade: string | null; uf: string | null; lat: number | null; lon: number | null;
  }>(
    `SELECT c.logradouro, c.numero, c.bairro, c.cep, m.nome AS cidade, c.uf,
            ST_Y(c.geom::geometry) AS lat, ST_X(c.geom::geometry) AS lon
     FROM companies c LEFT JOIN municipios m ON m.id = c.municipio_id
     WHERE c.id = $1`, [id],
  );
  if (!c) return null;

  const g = await geocodeAddr(c);
  if (g) {
    await query(
      `INSERT INTO company_geocode (company_id, lat, lon, precisao, fonte)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (company_id) DO UPDATE
         SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, precisao = EXCLUDED.precisao,
             fonte = EXCLUDED.fonte, atualizado_em = now()`,
      [id, g.lat, g.lon, g.precisao, g.fonte],
    );
    return { lat: g.lat, lon: g.lon };
  }
  if (c.lat != null && c.lon != null) return { lat: c.lat, lon: c.lon }; // centroide do município
  return null;
}

// Máximo de geocodificações on-demand (Nominatim ~1 req/s) dentro de uma request:
// acima disso a resposta demoraria vários segundos só esperando o throttle.
const MAX_GEOCODE_INLINE = 5;

// Geocode em lote. O caminho comum (todas as empresas já cacheadas) resolve em
// UMA query em vez de N round-trips; só os cache-miss caem no geocodeCompany
// sequencial (que respeita o throttle do Nominatim), limitado a MAX_GEOCODE_INLINE
// por request. O excedente responde já com o centroide do município e é
// geocodificado em segundo plano — a próxima request bate no cache.
async function geocodeManyCompanies(ids: number[]): Promise<Record<number, Geo>> {
  const geo: Record<number, Geo> = {};
  if (ids.length === 0) return geo;
  const cached = await query<{ company_id: string; lat: number; lon: number }>(
    'SELECT company_id, lat, lon FROM company_geocode WHERE company_id = ANY($1::bigint[])', [ids],
  );
  for (const r of cached) geo[Number(r.company_id)] = { lat: r.lat, lon: r.lon };
  const misses = ids.filter((id) => !geo[id]);
  for (const id of misses.slice(0, MAX_GEOCODE_INLINE)) {
    const g = await geocodeCompany(id);
    if (g) geo[id] = g;
  }
  const deferred = misses.slice(MAX_GEOCODE_INLINE);
  if (deferred.length > 0) {
    // Resposta imediata com o centroide do município (companies.geom) — mesma
    // fonte do último fallback do geocodeCompany.
    const cents = await query<{ id: string; lat: number | null; lon: number | null }>(
      `SELECT id, ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon
       FROM companies WHERE id = ANY($1::bigint[])`, [deferred],
    );
    for (const r of cents) {
      if (r.lat != null && r.lon != null) geo[Number(r.id)] = { lat: r.lat, lon: r.lon };
    }
    // Geocodifica o excedente fora do caminho crítico (sequencial, ainda sob o
    // throttle do Nominatim) para popular o cache das próximas requests.
    setImmediate(() => {
      void (async () => {
        for (const id of deferred) {
          try { await geocodeCompany(id); } catch { /* best-effort: fica pro próximo request */ }
        }
      })();
    });
  }
  return geo;
}

interface OsrmTrip {
  distance: number; duration: number;
  geometry: { coordinates: [number, number][] };
  legs: { distance: number; duration: number }[];
}
interface OsrmResp {
  code: string;
  trips?: OsrmTrip[];
  waypoints?: { waypoint_index: number }[];
}

// Resolve o TSP ida-e-volta no OSRM. `pts[0]` é a origem (source=first).
// Retorna a ordem ótima das paradas (sem a origem) + métricas e geometria.
async function osrmTrip(pts: Geo[]): Promise<{
  order: number[];                 // índices em `pts` (>=1) na ordem de visita
  distKm: number; durMin: number;
  coords: [number, number][];      // [lat, lon] p/ Leaflet
  legByPt: Record<number, { distKm: number; durMin: number }>; // métrica do trecho até cada ponto
}> {
  const coordStr = pts.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `${config.osrmUrl}/trip/v1/driving/${coordStr}?source=first&roundtrip=true&geometries=geojson&overview=full`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) }); // OSRM público lento não pode travar a request
  if (!resp.ok) throw new Error(`OSRM ${resp.status}`);
  const j = (await resp.json()) as OsrmResp;
  if (j.code !== 'Ok' || !j.trips?.length || !j.waypoints) throw new Error(`OSRM ${j.code}`);
  const trip = j.trips[0]!;

  // waypoints[i].waypoint_index = posição do ponto i na rota otimizada.
  // legs[k] liga a posição k à k+1 na ordem otimizada.
  const order: number[] = [];                          // por posição otimizada (1..N) -> índice do ponto
  const legByPt: Record<number, { distKm: number; durMin: number }> = {};
  j.waypoints.forEach((w, i) => {
    if (i === 0) return;                               // pula a origem
    order[w.waypoint_index] = i;
    const leg = trip.legs[w.waypoint_index - 1];       // trecho da posição anterior até esta
    if (leg) legByPt[i] = { distKm: leg.distance / 1000, durMin: leg.duration / 60 };
  });

  return {
    order: order.filter((x) => x !== undefined),
    distKm: trip.distance / 1000,
    durMin: trip.duration / 60,
    coords: trip.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
    legByPt,
  };
}

type RouteResult = {
  origem: Geo;
  stops: {
    seq: number; company_id: number; razao_social: string; nome_fantasia: string | null;
    uf: string; cidade: string | null; lat: number; lon: number;
    leg_dist_km: number | null; leg_dur_min: number | null;
  }[];
  dist_km: number; dur_min: number;
  preco_litro: number | null; litros: number | null; custo_total: number | null;
  geometry: { coordinates: [number, number][] };
  skipped: number[];
};

// Núcleo do planejador, compartilhado por /optimize e /:id/reuse. Resolve
// origem, veículo, geocode e TSP. Retorna { ok:false, code } nos erros de
// negócio (origem ausente, veículo alheio, nada geolocalizado, OSRM fora).
async function computeRoute(
  req: FastifyRequest,
  orgId: number,
  company_ids: number[],
  vehicle_id: number | null | undefined,
  preco_litro: number | null | undefined,
  origemOverride?: Geo | null,
): Promise<{ ok: true; result: RouteResult } | { ok: false; code: 400 | 404 | 502; error: string }> {
  const ids = [...new Set(company_ids)];

  // Origem da rota: endereço de partida informado nos filtros (override) tem
  // prioridade; senão cai no endereço cadastrado da conta.
  const origem = origemOverride ?? await resolveOrgOrigin(orgId);
  if (!origem) return { ok: false, code: 400, error: 'Cadastre o endereço da sua conta para definir a origem da rota.' };

  // veículo (consumo/preço) — opcional. Validado por org.
  let consumoKml: number | null = null;
  let preco = preco_litro ?? null;
  if (vehicle_id != null) {
    const v = await one<{ consumo_kml: number; preco_litro: number | null }>(
      'SELECT consumo_kml, preco_litro FROM vehicles WHERE id = $1 AND org_id = $2', [vehicle_id, orgId],
    );
    if (!v) return { ok: false, code: 404, error: 'veículo não encontrado' };
    consumoKml = Number(v.consumo_kml);
    if (preco == null) preco = v.preco_litro != null ? Number(v.preco_litro) : null;
  }

  // geocode em lote: cache numa query só; cache-miss vai sequencial ao Nominatim.
  const geo = await geocodeManyCompanies(ids);
  const located = ids.filter((id) => geo[id]);
  if (located.length === 0) return { ok: false, code: 400, error: 'Nenhuma empresa selecionada tem localização.' };

  // metadados das empresas p/ exibir na lista de paradas
  const meta = await query<{ id: string; razao_social: string; nome_fantasia: string | null; uf: string; cidade: string | null }>(
    `SELECT c.id, c.razao_social, c.nome_fantasia, c.uf, m.nome AS cidade
     FROM companies c LEFT JOIN municipios m ON m.id = c.municipio_id
     WHERE c.id = ANY($1::bigint[])`, [located],
  );
  const metaById = new Map(meta.map((m) => [String(m.id), m]));

  const pts: Geo[] = [origem, ...located.map((id) => geo[id]!)];

  let trip: Awaited<ReturnType<typeof osrmTrip>>;
  try {
    trip = await osrmTrip(pts);
  } catch (e) {
    req.log.error({ err: e }, 'OSRM trip falhou');
    return { ok: false, code: 502, error: 'Não foi possível calcular a rota (serviço de roteamento indisponível).' };
  }

  // pts index (>=1) -> company_id
  const idByPt = new Map<number, number>(located.map((id, i) => [i + 1, id]));
  const stops = trip.order.map((ptIdx, seq) => {
    const cid = idByPt.get(ptIdx)!;
    const m = metaById.get(String(cid));
    const leg = trip.legByPt[ptIdx];
    return {
      seq,
      company_id: cid,
      razao_social: m?.razao_social ?? '',
      nome_fantasia: m?.nome_fantasia ?? null,
      uf: m?.uf ?? '', cidade: m?.cidade ?? null,
      lat: geo[cid]!.lat, lon: geo[cid]!.lon,
      leg_dist_km: leg ? Number(leg.distKm.toFixed(2)) : null,
      leg_dur_min: leg ? Number(leg.durMin.toFixed(1)) : null,
    };
  });

  const fuel = fuelEstimate({ distKm: trip.distKm, consumoKml, precoLitro: preco });
  const skipped = ids.filter((id) => !geo[id]);

  return {
    ok: true,
    result: {
      origem,
      stops,
      dist_km: Number(trip.distKm.toFixed(2)),
      dur_min: Number(trip.durMin.toFixed(1)),
      preco_litro: preco,
      litros: fuel ? Number(fuel.litros.toFixed(2)) : null,
      custo_total: fuel?.custo != null ? Number(fuel.custo.toFixed(2)) : null,
      geometry: { coordinates: trip.coords },
      skipped, // empresas sem localização (ignoradas no cálculo)
    },
  };
}

// Persiste uma rota (resultado de computeRoute) numa transação. Reaproveitado
// por POST /api/routes e POST /api/routes/:id/reuse.
async function persistRoute(
  orgId: number, ownerUserId: number,
  r: {
    nome: string; vehicle_id?: number | null; origem_lat: number; origem_lon: number;
    dist_km?: number | null; dur_min?: number | null; preco_litro?: number | null;
    litros?: number | null; custo_total?: number | null; geometry?: unknown;
    template?: boolean; recorrencia?: string | null;
    stops: { company_id: number; seq: number; lat: number; lon: number; leg_dist_km?: number | null; leg_dur_min?: number | null }[];
  },
): Promise<{ id: number }> {
  return withClient(async (c) => {
    await c.query('BEGIN');
    try {
      const ins = await c.query(
        `INSERT INTO routes (org_id, owner_user_id, vehicle_id, nome, origem_lat, origem_lon,
                             dist_km, dur_min, preco_litro, litros, custo_total, geometry, template, recorrencia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [orgId, ownerUserId, r.vehicle_id ?? null, r.nome, r.origem_lat, r.origem_lon,
          r.dist_km ?? null, r.dur_min ?? null, r.preco_litro ?? null, r.litros ?? null, r.custo_total ?? null,
          r.geometry != null ? JSON.stringify(r.geometry) : null, r.template ?? false, r.recorrencia ?? null],
      );
      const routeId = ins.rows[0]!.id as number;
      for (const s of r.stops) {
        await c.query(
          `INSERT INTO route_stops (route_id, company_id, seq, lat, lon, leg_dist_km, leg_dur_min)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [routeId, s.company_id, s.seq, s.lat, s.lon, s.leg_dist_km ?? null, s.leg_dur_min ?? null],
        );
      }
      await c.query('COMMIT');
      return { id: routeId };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

export function routePlanRoutes(app: FastifyInstance): void {
  // Calcula a melhor rota para as empresas selecionadas (preview, não persiste).
  app.post('/api/routes/optimize', {
    preHandler: [requireAuth, requirePermission('routes.optimize')],
    schema: {
      body: {
        type: 'object',
        required: ['company_ids'],
        properties: {
          company_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: MAX_STOPS },
          vehicle_id: { type: ['integer', 'null'] },
          preco_litro: { type: ['number', 'null'] },
          origem_lat: { type: ['number', 'null'] },
          origem_lon: { type: ['number', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { company_ids, vehicle_id, preco_litro, origem_lat, origem_lon } = req.body as {
      company_ids: number[]; vehicle_id?: number | null; preco_litro?: number | null;
      origem_lat?: number | null; origem_lon?: number | null;
    };
    const origemOverride = origem_lat != null && origem_lon != null ? { lat: origem_lat, lon: origem_lon } : null;
    const out = await computeRoute(req, req.auth!.orgId, company_ids, vehicle_id, preco_litro, origemOverride);
    if (!out.ok) return reply.code(out.code).send({ error: out.error });
    return out.result;
  });

  // Persiste uma rota já otimizada (resultado de /optimize).
  app.post('/api/routes', {
    preHandler: [requireAuth, requirePermission('routes.create')],
    schema: {
      body: {
        type: 'object',
        required: ['nome', 'origem_lat', 'origem_lon', 'stops'],
        properties: {
          nome: { type: 'string', minLength: 1 },
          vehicle_id: { type: ['integer', 'null'] },
          origem_lat: { type: 'number' },
          origem_lon: { type: 'number' },
          dist_km: { type: ['number', 'null'] },
          dur_min: { type: ['number', 'null'] },
          preco_litro: { type: ['number', 'null'] },
          litros: { type: ['number', 'null'] },
          custo_total: { type: ['number', 'null'] },
          geometry: {},
          template: { type: 'boolean' },
          recorrencia: { type: ['string', 'null'] },
          stops: {
            type: 'array', minItems: 1,
            items: {
              type: 'object',
              required: ['company_id', 'seq', 'lat', 'lon'],
              properties: {
                company_id: { type: 'integer' },
                seq: { type: 'integer' },
                lat: { type: 'number' }, lon: { type: 'number' },
                leg_dist_km: { type: ['number', 'null'] },
                leg_dur_min: { type: ['number', 'null'] },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const b = req.body as Parameters<typeof persistRoute>[2];

    // valida o veículo (se houver) pela org
    if (b.vehicle_id != null) {
      const v = await one('SELECT id FROM vehicles WHERE id = $1 AND org_id = $2', [b.vehicle_id, orgId]);
      if (!v) return reply.code(404).send({ error: 'veículo não encontrado' });
    }

    const route = await persistRoute(orgId, req.auth!.userId, b);
    return reply.code(201).send({ route });
  });

  // Lista as rotas salvas da org. Rep vê as próprias + as compartilhadas
  // (owner NULL, criadas antes da Fase 3); admin tudo + filtro por vendedor.
  app.get('/api/routes', {
    preHandler: [requireAuth, requirePermission('routes.list')],
    schema: { querystring: { type: 'object', properties: { owner_user_id: { type: 'integer' } } } },
  }, async (req) => {
    const orgId = req.auth!.orgId;
    const { owner_user_id } = req.query as { owner_user_id?: number };
    const where: string[] = ['r.org_id = $1'];
    const params: unknown[] = [orgId];
    scopeOwner(req, where, params, 'r.owner_user_id', owner_user_id, { nullVisible: true });
    const routes = await query(
      `SELECT r.id, r.nome, r.owner_user_id, r.vehicle_id, v.nome AS veiculo, r.dist_km, r.dur_min,
              r.litros, r.custo_total, r.template, r.recorrencia, r.created_at,
              (SELECT count(*) FROM route_stops s WHERE s.route_id = r.id) AS paradas
       FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id
       WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`, params,
    );
    return { routes };
  });

  // Detalhe de uma rota + paradas ordenadas.
  app.get('/api/routes/:id', {
    preHandler: [requireAuth, requirePermission('routes.read')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const route = await one<Record<string, unknown> & { owner_user_id: string | null }>(
      `SELECT r.id, r.nome, r.owner_user_id, r.vehicle_id, v.nome AS veiculo, r.origem_lat, r.origem_lon,
              r.dist_km, r.dur_min, r.preco_litro, r.litros, r.custo_total, r.geometry,
              r.template, r.recorrencia, r.created_at
       FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.id = $1 AND r.org_id = $2`, [id, orgId],
    );
    if (!route) return reply.code(404).send({ error: 'rota não encontrada' });
    if (!canWriteOwned(req, route.owner_user_id === null ? null : Number(route.owner_user_id), { nullWritable: true })) {
      return reply.code(404).send({ error: 'rota não encontrada' });
    }
    const stops = await query(
      `SELECT s.seq, s.company_id, s.lat, s.lon, s.leg_dist_km, s.leg_dur_min,
              c.razao_social, c.nome_fantasia, c.uf, m.nome AS cidade
       FROM route_stops s
       JOIN companies c ON c.id = s.company_id
       LEFT JOIN municipios m ON m.id = c.municipio_id
       WHERE s.route_id = $1 ORDER BY s.seq`, [id],
    );
    return { route, stops };
  });

  // Marca/desmarca uma rota como template (e edita nome/recorrência). Fase 5.3.
  app.patch('/api/routes/:id', {
    preHandler: [requireAuth, requirePermission('routes.update')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string', minLength: 1 },
          template: { type: 'boolean' },
          recorrencia: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const b = req.body as { nome?: string; template?: boolean; recorrencia?: string | null };
    const route = await one<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM routes WHERE id = $1 AND org_id = $2', [id, orgId],
    );
    if (!route) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWriteOwned(req, route.owner_user_id === null ? null : Number(route.owner_user_id), { nullWritable: true })) {
      return reply.code(403).send({ error: 'rota de outro vendedor' });
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const k of ['nome', 'template', 'recorrencia'] as const) {
      if (k in b) { params.push(b[k]); sets.push(`${k} = $${params.length}`); }
    }
    if (sets.length === 0) return reply.code(400).send({ error: 'nada para atualizar' });
    params.push(id, orgId);
    const rows = await query(
      `UPDATE routes SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length}
       RETURNING id, nome, template, recorrencia`,
      params,
    );
    return { route: rows[0] };
  });

  // Reusar rota (Fase 5.3): re-otimiza as paradas de uma rota existente
  // (template ou não) — as empresas podem ter mudado de endereço — e persiste
  // uma rota nova, do vendedor logado. Reaproveita o mesmo veículo.
  app.post('/api/routes/:id/reuse', {
    preHandler: [requireAuth, requirePermission('routes.reuse')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: { type: 'object', properties: { nome: { type: 'string', minLength: 1 } } },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const b = req.body as { nome?: string };
    const route = await one<{ owner_user_id: string | null; nome: string; vehicle_id: string | null }>(
      'SELECT owner_user_id, nome, vehicle_id FROM routes WHERE id = $1 AND org_id = $2', [id, orgId],
    );
    if (!route) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWriteOwned(req, route.owner_user_id === null ? null : Number(route.owner_user_id), { nullWritable: true })) {
      return reply.code(404).send({ error: 'não encontrado' });
    }
    const stops = await query<{ company_id: string }>(
      'SELECT company_id FROM route_stops WHERE route_id = $1 ORDER BY seq', [id],
    );
    if (stops.length === 0) return reply.code(400).send({ error: 'rota sem paradas' });
    const companyIds = stops.map((s) => Number(s.company_id));
    // Veículo da rota original pode ter sido excluído desde então: reusa sem
    // veículo em vez de abortar o reuse inteiro com 404 "veículo não encontrado".
    let vehicleId = route.vehicle_id != null ? Number(route.vehicle_id) : null;
    if (vehicleId != null) {
      const v = await one('SELECT id FROM vehicles WHERE id = $1 AND org_id = $2', [vehicleId, orgId]);
      if (!v) vehicleId = null;
    }

    const out = await computeRoute(req, orgId, companyIds, vehicleId, null);
    if (!out.ok) return reply.code(out.code).send({ error: out.error });
    const r = out.result;
    const saved = await persistRoute(orgId, req.auth!.userId, {
      nome: b.nome ?? `${route.nome} (cópia)`,
      vehicle_id: vehicleId,
      origem_lat: r.origem.lat, origem_lon: r.origem.lon,
      dist_km: r.dist_km, dur_min: r.dur_min, preco_litro: r.preco_litro,
      litros: r.litros, custo_total: r.custo_total, geometry: r.geometry,
      stops: r.stops.map((s) => ({
        company_id: s.company_id, seq: s.seq, lat: s.lat, lon: s.lon,
        leg_dist_km: s.leg_dist_km, leg_dur_min: s.leg_dur_min,
      })),
    });
    return reply.code(201).send({ route: { id: saved.id }, skipped: r.skipped });
  });

  // Criar compromissos a partir de uma rota (Fase 5.2 — caminho inverso): uma
  // activity de visita por parada, com horário estimado a partir do leg_dur_min
  // somado em sequência. As atividades são do vendedor logado.
  app.post('/api/routes/:id/agenda', {
    preHandler: [requireAuth, requirePermission('routes.agenda')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: {
        type: 'object',
        required: ['start_at'],
        properties: { start_at: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const { start_at } = req.body as { start_at: string };
    const route = await one<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM routes WHERE id = $1 AND org_id = $2', [id, orgId],
    );
    if (!route) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWriteOwned(req, route.owner_user_id === null ? null : Number(route.owner_user_id), { nullWritable: true })) {
      return reply.code(404).send({ error: 'não encontrado' });
    }
    const stops = await query<{ company_id: string; razao_social: string; nome_fantasia: string | null; leg_dur_min: string | null }>(
      `SELECT s.company_id, s.leg_dur_min, c.razao_social, c.nome_fantasia
       FROM route_stops s JOIN companies c ON c.id = s.company_id
       WHERE s.route_id = $1 ORDER BY s.seq`, [id],
    );
    if (stops.length === 0) return reply.code(400).send({ error: 'rota sem paradas' });

    const base = new Date(start_at);
    if (Number.isNaN(base.getTime())) return reply.code(400).send({ error: 'start_at inválido' });

    // Monta os horários em sequência (deslocamento + 30 min de visita por parada).
    const titulos: string[] = [];
    const starts: string[] = [];
    const companyIds: number[] = [];
    let cursor = base.getTime();
    for (const s of stops) {
      titulos.push(`Visita: ${s.nome_fantasia || s.razao_social}`);
      starts.push(new Date(cursor).toISOString());
      companyIds.push(Number(s.company_id));
      const legMin = s.leg_dur_min != null ? Number(s.leg_dur_min) : 30;
      cursor += (legMin + 30) * 60_000;
    }
    // INSERT multi-row único: 1 round-trip e atômico por si só (tudo-ou-nada,
    // sem precisar de transação explícita) — se um FK estourar, nada é criado.
    const rows = await query<{ id: string }>(
      `INSERT INTO activities (org_id, tipo, titulo, start_at, owner_user_id, company_id, status)
       SELECT $1, 'visita', t.titulo, t.start_at::timestamptz, $2, t.company_id, 'pendente'
       FROM unnest($3::text[], $4::text[], $5::bigint[]) AS t(titulo, start_at, company_id)
       RETURNING id`,
      [orgId, req.auth!.userId, titulos, starts, companyIds],
    );
    const created = rows.map((r) => Number(r.id));
    return reply.code(201).send({ created: created.length, ids: created });
  });

  // Lançar despesa de viagem (Fase 6.1): cria um finance_entry pagar/viagem com
  // o custo de combustível da rota. Idempotente por rota — segunda chamada
  // devolve 409 com o lançamento existente (evita duplicar o custo).
  app.post('/api/routes/:id/expense', {
    preHandler: [requireAuth, requirePermission('routes.expense')],
    schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
      body: { type: 'object', properties: { vencimento: { type: 'string' }, valor: { type: 'number', minimum: 0 } } },
    },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const b = req.body as { vencimento?: string; valor?: number };
    const route = await one<{ owner_user_id: string | null; nome: string; custo_total: string | null }>(
      'SELECT owner_user_id, nome, custo_total FROM routes WHERE id = $1 AND org_id = $2', [id, orgId],
    );
    if (!route) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWriteOwned(req, route.owner_user_id === null ? null : Number(route.owner_user_id), { nullWritable: true })) {
      return reply.code(403).send({ error: 'rota de outro vendedor' });
    }
    const existing = await one<{ id: string }>('SELECT id FROM finance_entries WHERE route_id = $1 AND org_id = $2', [id, orgId]);
    if (existing) return reply.code(409).send({ error: 'despesa desta rota já lançada', finance_id: Number(existing.id) });

    const valor = b.valor ?? (route.custo_total != null ? Number(route.custo_total) : null);
    if (valor == null || valor <= 0) return reply.code(400).send({ error: 'rota sem custo calculado; informe um valor' });
    const owner = route.owner_user_id != null ? Number(route.owner_user_id) : req.auth!.userId;
    const rows = await query<{ id: string }>(
      `INSERT INTO finance_entries
         (org_id, kind, descricao, valor, vencimento, status, categoria, route_id, owner_user_id)
       VALUES ($1, 'pagar', $2, $3, COALESCE($4::date, current_date), 'pendente', 'viagem', $5, $6)
       RETURNING id`,
      [orgId, `Viagem: ${route.nome}`, valor, b.vencimento ?? null, id, owner],
    );
    return reply.code(201).send({ finance_id: Number(rows[0]!.id) });
  });

  app.delete('/api/routes/:id', {
    preHandler: [requireAuth, requirePermission('routes.delete')],
    schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } } },
  }, async (req, reply) => {
    const orgId = req.auth!.orgId;
    const { id } = req.params as { id: number };
    const route = await one<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM routes WHERE id = $1 AND org_id = $2', [id, orgId],
    );
    if (!route) return reply.code(404).send({ error: 'não encontrado' });
    if (!canWriteOwned(req, route.owner_user_id === null ? null : Number(route.owner_user_id), { nullWritable: true })) {
      return reply.code(403).send({ error: 'rota de outro vendedor' });
    }
    const rows = await query('DELETE FROM routes WHERE id = $1 AND org_id = $2 RETURNING id', [id, orgId]);
    if (rows.length === 0) return reply.code(404).send({ error: 'não encontrado' });
    return { deleted: true };
  });
}
