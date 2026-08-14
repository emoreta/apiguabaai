const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const { sequelize, Document, AiModelConfig, AiProviderCredential, AiModelEvent, initializeDatabase } = require('./db');
const { authenticateService, authenticateAdmin, rateLimit } = require('./security');
const { CAPABILITIES, extractDocument, planAgentTools, answerAgent, runWithFallback, encryptCredential, syncTogetherPricing } = require('./aiCore');

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origen no permitido'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'X-Admin-Key', 'X-Guaba-Key', 'X-Guaba-Timestamp',
    'X-Guaba-Nonce', 'X-Guaba-Signature', 'X-Guaba-Content-Sha256',
  ],
}));
app.use(express.json({
  limit: process.env.JSON_BODY_LIMIT || '10mb',
  verify(req, _res, buffer) { req.rawBody = Buffer.from(buffer); },
}));

const metadataFor = req => ({
  clientId: req.serviceClient,
  tenantId: req.body?.metadata?.tenantId,
  userId: req.body?.metadata?.userId,
  channel: req.body?.metadata?.channel,
});

const publicModel = row => ({
  id: row.id,
  capability: row.capability,
  provider: row.provider,
  model: row.model,
  displayName: row.display_name,
  priority: row.priority,
  enabled: Boolean(row.enabled),
  settings: row.settings || {},
  pricing: {
    inputPerMillion: row.input_price_per_million == null ? null : Number(row.input_price_per_million),
    cachedInputPerMillion: row.cached_input_price_per_million == null ? null : Number(row.cached_input_price_per_million),
    outputPerMillion: row.output_price_per_million == null ? null : Number(row.output_price_per_million),
    currency: row.price_currency,
    syncedAt: row.pricing_synced_at,
  },
  health: {
    failureCount: row.failure_count,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    cooldownUntil: row.cooldown_until,
  },
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'guaba-ai', version: '2.0.0' }));
app.get('/health', async (_req, res) => {
  try {
    await sequelize.authenticate();
    res.json({ status: 'ok', database: 'ready', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'degraded', database: 'unavailable', timestamp: new Date().toISOString() });
  }
});

const service = express.Router();
service.use(authenticateService);
service.use(rateLimit());

service.post('/v1/ocr/extract', async (req, res) => {
  try {
    const result = await extractDocument(req.body?.imageUrl, metadataFor(req));
    res.json({
      status: 'success',
      data: result,
      document: result.document,
      rawText: result.document.rawText,
      extractedText: JSON.stringify(result.document),
    });
  } catch (error) {
    const invalidInput = /obligatorio|URL|imagen|host|tamaño/i.test(error.message);
    res.status(invalidInput ? 400 : 502).json({ status: 'error', error: error.message, requestId: error.requestId });
  }
});

service.post('/extract-info', async (req, res) => {
  try {
    const result = await extractDocument(req.body?.imageUrl, metadataFor(req));
    res.json({
      status: 'success', document: result.document, rawText: result.document.rawText,
      extractedText: JSON.stringify(result.document), model: result.model, requestId: result.requestId, usage: result.usage,
    });
  } catch (error) {
    const invalidInput = /obligatorio|URL|imagen|host|tamaño/i.test(error.message);
    res.status(invalidInput ? 400 : 502).json({ status: 'error', error: error.message });
  }
});

service.post('/v1/agent/respond', async (req, res) => {
  try {
    const result = await answerAgent({
      messages: req.body?.messages,
      context: req.body?.context,
      locale: req.body?.locale,
      metadata: metadataFor(req),
    });
    res.json({ status: 'success', data: result });
  } catch (error) {
    res.status(/mensaje/i.test(error.message) ? 400 : 502).json({ status: 'error', error: error.message });
  }
});

service.post('/v1/agent/plan', async (req, res) => {
  try {
    const result = await planAgentTools({
      messages: req.body?.messages,
      range: req.body?.range,
      tools: req.body?.tools,
      locale: req.body?.locale,
      metadata: metadataFor(req),
    });
    res.json({ status: 'success', data: result });
  } catch (error) {
    res.status(/mensaje|herramienta|esquema|argumentos/i.test(error.message) ? 400 : 502).json({ status: 'error', error: error.message });
  }
});

// Contratos heredados. Se mantienen para no romper otros productos durante la migración.
service.post('/callApiChatTogether', async (req, res) => {
  try {
    const result = await answerAgent({
      messages: [{ role: 'user', content: String(req.body?.query || '') }],
      context: req.body?.context || {}, metadata: metadataFor(req),
    });
    res.json({ Answer: result.response.answer, data: result.response, requestId: result.requestId });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
service.post('/callApiChatTogetherRag', async (req, res) => {
  try {
    const result = await answerAgent({
      messages: [{ role: 'user', content: String(req.body?.query || '') }],
      context: req.body?.context || {}, metadata: metadataFor(req),
    });
    res.json({ Answer: result.response.answer, data: result.response, requestId: result.requestId });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

service.post('/add-document', async (req, res) => {
  const { name, extension, document_id, author, pages, description, name_json, upload_date, created_date, isActive, userId, url_json, json_text, TypeDocumentId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId es obligatorio.' });
  try {
    const document = await Document.create({ name, extension, document_id, author, pages, description, name_json, upload_date, created_date, isActive: Boolean(isActive), userId, url_json, TypeDocumentId });
    let externalApiResponse = null;
    if (json_text && name_json) {
      const response = await axios.post('https://upload.guabastudio.site/save-json', { jsonString: json_text, fileName: name_json, pathFile: 'json_files' }, { timeout: 30000 });
      externalApiResponse = response.data;
    }
    res.status(201).json({ message: 'Documento insertado con éxito', document, externalApiResponse });
  } catch (error) { res.status(500).json({ error: 'Error al insertar el documento.', details: error.message }); }
});
service.get('/documents', async (req, res) => {
  const userId = String(req.query?.userId || '');
  if (!userId) return res.status(400).json({ error: 'userId es obligatorio.' });
  try { res.json(await Document.findAll({ where: { userId }, order: [['id', 'DESC']] })); }
  catch (error) { res.status(500).json({ error: 'Error al obtener documentos.' }); }
});
service.get('/documents/:id', async (req, res) => {
  const userId = String(req.query?.userId || '');
  if (!userId) return res.status(400).json({ error: 'userId es obligatorio.' });
  try {
    const document = await Document.findOne({ where: { id: req.params.id, userId } });
    if (!document) return res.status(404).json({ error: 'Documento no encontrado.' });
    res.json(document);
  } catch { res.status(500).json({ error: 'Error al obtener documento.' }); }
});
service.put('/documents/:id', async (req, res) => {
  const userId = String(req.body?.userId || '');
  if (!userId) return res.status(400).json({ error: 'userId es obligatorio.' });
  try {
    const document = await Document.findOne({ where: { id: req.params.id, userId } });
    if (!document) return res.status(404).json({ error: 'Documento no encontrado.' });
    const allowed = ['name', 'extension', 'document_id', 'author', 'pages', 'description', 'name_json', 'upload_date', 'created_date', 'isActive', 'url_json', 'TypeDocumentId'];
    const changes = Object.fromEntries(allowed.filter(key => req.body[key] !== undefined).map(key => [key, req.body[key]]));
    await document.update(changes);
    res.json({ message: 'Documento actualizado correctamente', document });
  } catch { res.status(500).json({ error: 'Error al actualizar documento.' }); }
});

app.use(service);

const admin = express.Router();
admin.use(authenticateAdmin);
admin.use(rateLimit({ max: 120 }));

admin.get('/models', async (req, res) => {
  const where = req.query.capability ? { capability: String(req.query.capability) } : {};
  const rows = await AiModelConfig.findAll({ where, order: [['capability', 'ASC'], ['priority', 'ASC']] });
  res.json({ status: 'success', data: rows.map(publicModel) });
});
admin.post('/models', async (req, res) => {
  const capability = String(req.body?.capability || '');
  const model = String(req.body?.model || '').trim();
  if (!CAPABILITIES.has(capability) || !model) return res.status(400).json({ error: 'capability y model válidos son obligatorios.' });
  try {
    const row = await AiModelConfig.create({
      capability, provider: 'together', model, display_name: req.body?.displayName || null,
      priority: Number(req.body?.priority || 100), enabled: req.body?.enabled !== false, settings: req.body?.settings || null,
      input_price_per_million: req.body?.pricing?.inputPerMillion ?? null,
      cached_input_price_per_million: req.body?.pricing?.cachedInputPerMillion ?? null,
      output_price_per_million: req.body?.pricing?.outputPerMillion ?? null,
    });
    res.status(201).json({ status: 'success', data: publicModel(row) });
  } catch (error) { res.status(409).json({ error: error.message }); }
});
admin.patch('/models/:id', async (req, res) => {
  const row = await AiModelConfig.findByPk(req.params.id);
  if (!row) return res.status(404).json({ error: 'Modelo no encontrado.' });
  const map = {
    displayName: 'display_name', priority: 'priority', enabled: 'enabled', settings: 'settings',
  };
  const changes = {};
  for (const [input, column] of Object.entries(map)) if (req.body?.[input] !== undefined) changes[column] = req.body[input];
  if (req.body?.pricing?.inputPerMillion !== undefined) changes.input_price_per_million = req.body.pricing.inputPerMillion;
  if (req.body?.pricing?.cachedInputPerMillion !== undefined) changes.cached_input_price_per_million = req.body.pricing.cachedInputPerMillion;
  if (req.body?.pricing?.outputPerMillion !== undefined) changes.output_price_per_million = req.body.pricing.outputPerMillion;
  await row.update(changes);
  res.json({ status: 'success', data: publicModel(row) });
});
admin.post('/models/sync-pricing', async (_req, res) => {
  try { res.json({ status: 'success', data: await syncTogetherPricing() }); }
  catch (error) { res.status(502).json({ error: error.message }); }
});
admin.post('/models/:id/test', async (req, res) => {
  const row = await AiModelConfig.findByPk(req.params.id);
  if (!row) return res.status(404).json({ error: 'Modelo no encontrado.' });
  const startedAt = Date.now();
  try {
    if (row.capability === 'ocr') {
      if (!req.body?.imageUrl) return res.status(400).json({ error: 'imageUrl es obligatoria para probar un modelo OCR.' });
      const result = await extractDocument(req.body.imageUrl, { clientId: 'admin-test', tenantId: req.body?.tenantId, channel: 'admin' }, row.id);
      return res.json({ status: 'success', data: { requestedModel: row.model, selectedModel: result.model, latencyMs: Date.now() - startedAt, usage: result.usage, document: result.document } });
    }
    const result = await runWithFallback({
      capability: row.capability,
      modelId: row.id,
      metadata: { clientId: 'admin-test', channel: 'admin' },
      buildPayload: model => ({ model, messages: [{ role: 'user', content: 'Responde únicamente: OK' }], max_tokens: 10, temperature: 0 }),
    });
    res.json({ status: 'success', data: { requestedModel: row.model, selectedModel: result.model, latencyMs: Date.now() - startedAt, usage: result.usage } });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
admin.get('/credentials', async (req, res) => {
  const where = req.query.tenantId ? { tenant_id: String(req.query.tenantId) } : {};
  const rows = await AiProviderCredential.findAll({ where, order: [['updatedAt', 'DESC']] });
  res.json({ status: 'success', data: rows.map(row => ({
    id: row.id, tenantId: row.tenant_id, provider: row.provider, label: row.label,
    enabled: Boolean(row.enabled), lastFour: row.last_four, lastUsedAt: row.last_used_at,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  })) });
});
admin.post('/credentials', async (req, res) => {
  const tenantId = String(req.body?.tenantId || '').trim();
  const apiKey = String(req.body?.apiKey || '').trim();
  const label = String(req.body?.label || 'Principal').trim().slice(0, 120);
  if (!tenantId || apiKey.length < 20) return res.status(400).json({ error: 'tenantId y apiKey válida son obligatorios.' });
  try {
    const encrypted = encryptCredential(apiKey);
    const row = await AiProviderCredential.create({
      tenant_id: tenantId, provider: 'together', label,
      encrypted_secret: encrypted.encryptedSecret, encryption_iv: encrypted.iv, encryption_tag: encrypted.tag,
      last_four: apiKey.slice(-4), enabled: true,
    });
    res.status(201).json({ status: 'success', data: { id: row.id, tenantId, provider: 'together', label, enabled: true, lastFour: row.last_four } });
  } catch (error) { res.status(409).json({ error: error.message }); }
});
admin.post('/credentials/:id/rotate', async (req, res) => {
  const apiKey = String(req.body?.apiKey || '').trim();
  if (apiKey.length < 20) return res.status(400).json({ error: 'apiKey válida es obligatoria.' });
  const row = await AiProviderCredential.findByPk(req.params.id);
  if (!row) return res.status(404).json({ error: 'Credencial no encontrada.' });
  const encrypted = encryptCredential(apiKey);
  await row.update({
    encrypted_secret: encrypted.encryptedSecret, encryption_iv: encrypted.iv, encryption_tag: encrypted.tag,
    last_four: apiKey.slice(-4), key_version: Number(row.key_version || 1) + 1, enabled: true,
  });
  res.json({ status: 'success', data: { id: row.id, tenantId: row.tenant_id, lastFour: row.last_four, keyVersion: row.key_version } });
});
admin.patch('/credentials/:id', async (req, res) => {
  const row = await AiProviderCredential.findByPk(req.params.id);
  if (!row) return res.status(404).json({ error: 'Credencial no encontrada.' });
  const changes = {};
  if (req.body?.enabled !== undefined) changes.enabled = Boolean(req.body.enabled);
  if (req.body?.label !== undefined) changes.label = String(req.body.label).trim().slice(0, 120);
  await row.update(changes);
  res.json({ status: 'success', data: { id: row.id, tenantId: row.tenant_id, label: row.label, enabled: Boolean(row.enabled), lastFour: row.last_four } });
});
admin.get('/usage/summary', async (req, res) => {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? String(req.query.from) : new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? String(req.query.to) : new Date().toISOString().slice(0, 10);
  const groupMap = { day: 'DATE(created_at)', model: 'model', capability: 'capability', client: 'client_id', channel: 'channel' };
  const groupExpression = groupMap[String(req.query.groupBy || '')];
  const where = ['created_at >= :from', 'created_at < DATE_ADD(:to, INTERVAL 1 DAY)'];
  const replacements = { from, to };
  if (req.query.capability) { where.push('capability = :capability'); replacements.capability = String(req.query.capability); }
  if (req.query.clientId) { where.push('client_id = :clientId'); replacements.clientId = String(req.query.clientId); }
  const selectGroup = groupExpression ? `${groupExpression} AS groupKey,` : '';
  const groupSql = groupExpression ? `GROUP BY ${groupExpression} ORDER BY ${groupExpression}` : '';
  const [rows] = await sequelize.query(`
    SELECT ${selectGroup}
      COUNT(*) AS calls,
      SUM(status = 'success') AS successfulCalls,
      SUM(status = 'failure') AS failedCalls,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cachedInputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens,
      COALESCE(SUM(total_tokens), 0) AS totalTokens,
      COALESCE(SUM(estimated_cost_usd), 0) AS estimatedCostUsd,
      COALESCE(SUM(platform_cost_usd), 0) AS platformCostUsd,
      SUM(billing_source = 'customer') AS customerKeyCalls,
      SUM(pricing_status = 'unpriced') AS unpricedCalls,
      ROUND(AVG(latency_ms), 0) AS averageLatencyMs
    FROM ai_model_events WHERE ${where.join(' AND ')} ${groupSql}
  `, { replacements });
  res.json({ status: 'success', data: { from, to, currency: 'USD', groupBy: groupExpression ? String(req.query.groupBy) : null, rows } });
});
admin.get('/usage/events', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const rows = await AiModelEvent.findAll({ order: [['createdAt', 'DESC']], limit });
  res.json({ status: 'success', data: rows });
});

app.use('/v1/admin', admin);

app.use((error, _req, res, _next) => {
  if (error?.message === 'Origen no permitido') return res.status(403).json({ error: error.message });
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Solicitud demasiado grande.' });
  console.error('[request-error]', error?.message || error);
  res.status(500).json({ error: 'Error interno del servicio.' });
});

initializeDatabase()
  .then(() => app.listen(port, () => {
    console.log(`[guaba-ai] listening on ${port}`);
    syncTogetherPricing().then(result => console.log(`[pricing] ${result.updated} models updated`)).catch(error => console.error('[pricing]', error.message));
    const pricingTimer = setInterval(() => syncTogetherPricing().catch(error => console.error('[pricing]', error.message)), 24 * 60 * 60 * 1000);
    pricingTimer.unref();
  }))
  .catch(error => {
    console.error('[startup] database initialization failed:', error.message);
    process.exit(1);
  });

module.exports = app;
