const crypto = require('crypto');
const { Op } = require('sequelize');
const { AiModelConfig, AiProviderCredential, AiModelEvent } = require('./db');

const TOGETHER_URL = 'https://api.together.ai/v1/chat/completions';
const CAPABILITIES = new Set(['ocr', 'agent', 'chat', 'pdf', 'embedding', 'rerank']);

const ocrSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['documentType', 'documentTypeEs', 'fields', 'productos', 'rawText', 'confidence'],
  properties: {
    documentType: { type: 'string', enum: ['Invoice', 'Receipt', 'Contract', 'Identity document', 'Business card', 'Medical prescription', 'Notes', 'Sign', 'Other'] },
    documentTypeEs: { type: 'string', enum: ['Factura', 'Recibo', 'Contrato', 'Documento de identidad', 'Tarjeta de presentación', 'Receta médica', 'Apuntes', 'Cartel', 'Otro'] },
    fields: {
      type: 'object', additionalProperties: false,
      required: ['nombre', 'empresa', 'fecha', 'total', 'subtotal', 'iva', 'moneda', 'numeroDocumento', 'email', 'telefono', 'direccion'],
      properties: {
        nombre: { type: 'string' }, empresa: { type: 'string' }, fecha: { type: 'string' },
        total: { type: 'string' }, subtotal: { type: 'string' }, iva: { type: 'string' }, moneda: { type: 'string' },
        numeroDocumento: { type: 'string' }, email: { type: 'string' }, telefono: { type: 'string' }, direccion: { type: 'string' },
      },
    },
    productos: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['nombre', 'cantidad', 'precioUnitario', 'total'],
        properties: {
          nombre: { type: 'string' }, cantidad: { type: 'number' }, precioUnitario: { type: 'number' }, total: { type: 'number' },
        },
      },
    },
    rawText: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const agentSchema = {
  type: 'object', additionalProperties: false,
  required: ['answer', 'insights', 'suggestedQuestions', 'riskLevel'],
  properties: {
    answer: { type: 'string' },
    insights: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    suggestedQuestions: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
};

const normalizeSettings = value => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

const normalizeMetadata = metadata => ({
  client_id: String(metadata?.clientId || '').slice(0, 100) || null,
  tenant_id: String(metadata?.tenantId || '').slice(0, 180) || null,
  user_id: String(metadata?.userId || '').slice(0, 180) || null,
  channel: String(metadata?.channel || '').slice(0, 30) || null,
});

const credentialKey = () => {
  const configured = String(process.env.AI_CREDENTIALS_MASTER_KEY || '');
  if (!configured) return null;
  if (/^[a-f0-9]{64}$/i.test(configured)) return Buffer.from(configured, 'hex');
  try {
    const decoded = Buffer.from(configured, 'base64');
    return decoded.length === 32 ? decoded : null;
  } catch { return null; }
};

const encryptCredential = secret => {
  const key = credentialKey();
  if (!key) throw new Error('AI_CREDENTIALS_MASTER_KEY debe ser una clave de 32 bytes en hex o Base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return { encryptedSecret: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
};

const decryptCredential = row => {
  const key = credentialKey();
  if (!key) throw new Error('No se puede descifrar la credencial del cliente');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.encryption_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.encryption_tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(row.encrypted_secret, 'base64')), decipher.final()]).toString('utf8');
};

const resolveProviderCredential = async metadata => {
  const tenantId = String(metadata?.tenantId || '').slice(0, 180);
  if (tenantId) {
    const credential = await AiProviderCredential.findOne({
      where: { tenant_id: tenantId, provider: 'together', enabled: true },
      order: [['updatedAt', 'DESC']],
    });
    if (credential) {
      return { apiKey: decryptCredential(credential), credential, billingSource: 'customer' };
    }
  }
  if (!process.env.TOGETHER) throw new Error('Proveedor Together no configurado');
  return { apiKey: process.env.TOGETHER, credential: null, billingSource: 'platform' };
};

const usageAndCost = (usage, config) => {
  const input = Number(usage?.prompt_tokens || usage?.input_tokens || 0);
  const output = Number(usage?.completion_tokens || usage?.output_tokens || 0);
  const total = Number(usage?.total_tokens || input + output);
  const cached = Number(usage?.prompt_tokens_details?.cached_tokens || usage?.cached_input_tokens || 0);
  const inputPrice = config.input_price_per_million == null ? null : Number(config.input_price_per_million);
  const outputPrice = config.output_price_per_million == null ? null : Number(config.output_price_per_million);
  const cachedPrice = config.cached_input_price_per_million == null ? inputPrice : Number(config.cached_input_price_per_million);
  const priced = inputPrice != null && outputPrice != null;
  const cost = priced
    ? (((Math.max(0, input - cached) * inputPrice) + (cached * cachedPrice) + (output * outputPrice)) / 1000000)
    : null;
  return {
    input_tokens: input || null, cached_input_tokens: cached || null, output_tokens: output || null, total_tokens: total || null,
    estimated_cost_usd: cost == null ? null : cost.toFixed(9), pricing_status: priced ? 'estimated' : 'unpriced',
  };
};

const listModels = async (capability, modelId) => {
  if (!CAPABILITIES.has(capability)) throw new Error('Capacidad de IA no válida');
  return AiModelConfig.findAll({
    where: {
      capability,
      ...(modelId ? { id: modelId } : {}),
      enabled: true,
      [Op.or]: [{ cooldown_until: null }, { cooldown_until: { [Op.lte]: new Date() } }],
    },
    order: [['priority', 'ASC'], ['id', 'ASC']],
  });
};

const togetherCompletion = async (payload, apiKey = process.env.TOGETHER) => {
  if (!apiKey) throw new Error('Proveedor Together no configurado');
  const response = await fetch(TOGETHER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(Number(process.env.TOGETHER_TIMEOUT_MS || 60000)),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result?.error?.message || result?.message || `Together respondió ${response.status}`);
    error.status = response.status;
    error.code = result?.error?.code || `http_${response.status}`;
    throw error;
  }
  const message = result?.choices?.[0]?.message;
  if (!message) throw new Error('Together no devolvió una respuesta utilizable');
  return { message, usage: result.usage || null };
};

const syncTogetherPricing = async () => {
  if (!process.env.TOGETHER) return { catalogModels: 0, updated: 0 };
  const response = await fetch('https://api.together.ai/v1/models', {
    headers: { Authorization: `Bearer ${process.env.TOGETHER}` },
    signal: AbortSignal.timeout(30000),
  });
  const catalog = await response.json().catch(() => []);
  if (!response.ok || !Array.isArray(catalog)) throw new Error('No se pudo consultar el catálogo de Together');
  const rows = await AiModelConfig.findAll();
  let updated = 0;
  for (const row of rows) {
    const remote = catalog.find(item => item.id === row.model);
    if (!remote?.pricing) continue;
    await row.update({
      display_name: remote.display_name || row.display_name,
      input_price_per_million: remote.pricing.input ?? null,
      cached_input_price_per_million: remote.pricing.cached_input ?? null,
      output_price_per_million: remote.pricing.output ?? null,
      pricing_synced_at: new Date(),
    });
    updated += 1;
  }
  return { catalogModels: catalog.length, updated };
};

const runWithFallback = async ({ capability, modelId, requestId = crypto.randomUUID(), metadata, buildPayload, validateResult }) => {
  const models = await listModels(capability, modelId);
  if (!models.length) throw new Error(`No hay modelos activos para ${capability}`);
  const providerCredential = await resolveProviderCredential(metadata);
  const failures = [];
  for (const config of models) {
    const startedAt = Date.now();
    try {
      const settings = normalizeSettings(config.settings);
      const result = await togetherCompletion(buildPayload(config.model, settings), providerCredential.apiKey);
      const validated = validateResult ? validateResult(result) : undefined;
      const financialUsage = usageAndCost(result.usage, config);
      const billing = {
        credential_id: providerCredential.credential?.id || null,
        billing_source: providerCredential.billingSource,
        platform_cost_usd: providerCredential.billingSource === 'platform' ? financialUsage.estimated_cost_usd : '0.000000000',
      };
      await Promise.all([
        config.update({ last_success_at: new Date(), failure_count: 0, cooldown_until: null }),
        providerCredential.credential?.update({ last_used_at: new Date() }),
        AiModelEvent.create({ request_id: requestId, capability, provider: config.provider, model: config.model, ...normalizeMetadata(metadata), ...billing, status: 'success', latency_ms: Date.now() - startedAt, ...financialUsage }),
      ]);
      return { ...result, validated, model: config.model, requestId };
    } catch (error) {
      const credentialFailure = [401, 403].includes(Number(error.status));
      const nextFailureCount = Number(config.failure_count || 0) + (credentialFailure ? 0 : 1);
      const cooldownMinutes = Math.min(30, Math.max(2, nextFailureCount * 2));
      await Promise.all([
        config.update(credentialFailure
          ? { last_failure_at: new Date() }
          : { last_failure_at: new Date(), failure_count: nextFailureCount, cooldown_until: new Date(Date.now() + cooldownMinutes * 60000) }),
        AiModelEvent.create({
          request_id: requestId, capability, provider: config.provider, model: config.model, ...normalizeMetadata(metadata),
          credential_id: providerCredential.credential?.id || null, billing_source: providerCredential.billingSource,
          platform_cost_usd: providerCredential.billingSource === 'platform' ? null : '0.000000000', status: 'failure',
          latency_ms: Date.now() - startedAt, error_code: String(error.code || error.status || 'provider_error').slice(0, 80),
          error_message: String(error.message || 'Error del proveedor').slice(0, 500),
        }),
      ]);
      failures.push(`${config.model}: ${error.message}`);
      if (credentialFailure) break;
    }
  }
  const error = new Error(`Ningún modelo disponible pudo completar ${capability}`);
  error.details = failures;
  throw error;
};

const validateImageInput = value => {
  const imageUrl = String(value || '').trim();
  if (!imageUrl) throw new Error('imageUrl es obligatorio');
  const dataMatch = imageUrl.match(/^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (dataMatch) {
    const approximateBytes = Math.floor(dataMatch[2].replace(/\s/g, '').length * 0.75);
    if (approximateBytes > Number(process.env.MAX_IMAGE_BYTES || 8 * 1024 * 1024)) throw new Error('La imagen supera el tamaño permitido');
    return imageUrl;
  }
  let url;
  try { url = new URL(imageUrl); } catch { throw new Error('La URL de imagen no es válida'); }
  if (url.protocol !== 'https:') throw new Error('La imagen remota debe usar HTTPS');
  if (imageUrl.length > 4096 || url.username || url.password) throw new Error('La URL de imagen no está permitida');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname === '::1') {
    throw new Error('El host de imagen no está permitido');
  }
  return imageUrl;
};

const extractDocument = async (imageInput, metadata, modelId) => {
  const imageUrl = validateImageInput(imageInput);
  const prompt = `Extrae con precisión todo el contenido visible. Está optimizado para facturas y recibos de Ecuador, pero puede ser cualquier documento o cartel. Devuelve únicamente el JSON solicitado. Conserva el texto completo en rawText, usa fecha YYYY-MM-DD si es inequívoca, valores monetarios con punto decimal y moneda ISO (USD cuando corresponda). No inventes campos ilegibles.`;
  const result = await runWithFallback({
    capability: 'ocr',
    modelId,
    metadata,
    buildPayload: (model, settings) => ({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }],
      temperature: Number(settings.temperature ?? 0.1),
      max_tokens: Number(settings.maxTokens ?? 3000),
      reasoning: { enabled: false },
      response_format: { type: 'json_schema', json_schema: { name: 'guaba_document', schema: ocrSchema } },
      stream: false,
    }),
    validateResult: result => {
      try { return JSON.parse(result.message.content); }
      catch { throw new Error('El modelo devolvió un documento con formato inválido'); }
    },
  });
  return { document: result.validated, model: result.model, requestId: result.requestId, usage: result.usage };
};

const answerAgent = async ({ messages, context, locale = 'es-EC', metadata }) => {
  const safeMessages = Array.isArray(messages) ? messages.slice(-12).map(item => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: String(item?.content || '').slice(0, 4000),
  })).filter(item => item.content) : [];
  if (!safeMessages.length) throw new Error('Envía al menos un mensaje');
  const contextJson = JSON.stringify(context || {}).slice(0, 30000);
  const system = `Eres Guaba, un copiloto de salud financiera claro, prudente y accionable. Responde en ${locale}. Usa exclusivamente los datos suministrados. No inventes movimientos ni cifras. Diferencia observaciones de recomendaciones. No ejecutes cambios: esta fase es solo lectura. Evita juicios y explica riesgos con lenguaje sencillo. Devuelve únicamente JSON válido siguiendo exactamente este esquema: ${JSON.stringify(agentSchema)}. Contexto financiero del usuario: ${contextJson}`;
  const result = await runWithFallback({
    capability: 'agent',
    metadata,
    buildPayload: (model, settings) => ({
      model,
      messages: [{ role: 'system', content: system }, ...safeMessages],
      temperature: Number(settings.temperature ?? 0.25),
      max_tokens: Number(settings.maxTokens ?? 1800),
      reasoning: { enabled: false },
      response_format: { type: 'json_schema', json_schema: { name: 'guaba_agent_answer', schema: agentSchema } },
      stream: false,
    }),
    validateResult: result => {
      let parsed;
      try { parsed = JSON.parse(result.message.content); }
      catch { throw new Error('El agente devolvió una respuesta con formato inválido'); }
      const answer = String(parsed?.answer || '').trim();
      if (answer.length < 12 || !/[\p{L}\p{N}]/u.test(answer)) {
        throw new Error('El agente devolvió una respuesta vacía o insuficiente');
      }
      return parsed;
    },
  });
  return { response: result.validated, model: result.model, requestId: result.requestId, usage: result.usage };
};

module.exports = { CAPABILITIES, extractDocument, answerAgent, runWithFallback, togetherCompletion, encryptCredential, syncTogetherPricing };
