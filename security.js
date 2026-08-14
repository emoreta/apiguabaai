const crypto = require('crypto');

const replayCache = new Map();
const rateBuckets = new Map();

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const prune = (map, now) => {
  for (const [key, expiry] of map.entries()) {
    if (expiry <= now) map.delete(key);
  }
};

const authenticateService = (req, res, next) => {
  const keyId = String(req.get('x-guaba-key') || '');
  const timestamp = String(req.get('x-guaba-timestamp') || '');
  const nonce = String(req.get('x-guaba-nonce') || '');
  const signature = String(req.get('x-guaba-signature') || '');
  const contentHash = String(req.get('x-guaba-content-sha256') || '');
  const expectedKey = String(process.env.GUABA_SERVICE_KEY || '');
  const secret = String(process.env.GUABA_SERVICE_SECRET || '');

  if (keyId && timestamp && nonce && signature && contentHash && expectedKey && secret) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const requestSeconds = Number(timestamp);
    if (!Number.isFinite(requestSeconds) || Math.abs(nowSeconds - requestSeconds) > 300) {
      return res.status(401).json({ error: 'Firma vencida.' });
    }
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(nonce)) {
      return res.status(401).json({ error: 'Nonce inválido.' });
    }
    const rawBody = req.rawBody || Buffer.from('');
    const actualHash = crypto.createHash('sha256').update(rawBody).digest('hex');
    const canonical = [req.method.toUpperCase(), req.originalUrl.split('?')[0], timestamp, nonce, actualHash].join('\n');
    const expectedSignature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    if (!safeEqual(keyId, expectedKey) || !safeEqual(contentHash, actualHash) || !safeEqual(signature, expectedSignature)) {
      return res.status(403).json({ error: 'Firma incorrecta.' });
    }
    prune(replayCache, Date.now());
    const replayKey = `${keyId}:${nonce}`;
    if (replayCache.has(replayKey)) return res.status(409).json({ error: 'Solicitud repetida.' });
    replayCache.set(replayKey, Date.now() + 5 * 60 * 1000);
    req.serviceClient = keyId;
    return next();
  }

  // Compatibilidad temporal mientras los consumidores migran a HMAC.
  if (String(process.env.ALLOW_LEGACY_BASIC_AUTH || 'true').toLowerCase() !== 'false') {
    const header = String(req.get('authorization') || '');
    const configuredUser = String(process.env.AUTH_USERNAME || '');
    const configuredPassword = String(process.env.AUTH_PASSWORD || '');
    if (configuredUser && configuredPassword && header.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        const user = separator >= 0 ? decoded.slice(0, separator) : '';
        const password = separator >= 0 ? decoded.slice(separator + 1) : '';
        if (safeEqual(user, configuredUser) && safeEqual(password, configuredPassword)) {
          req.serviceClient = 'legacy-basic';
          return next();
        }
      } catch {}
    }
  }
  return res.status(401).json({ error: 'Autenticación de servicio requerida.' });
};

const authenticateAdmin = (req, res, next) => {
  const configured = String(process.env.AI_ADMIN_KEY || '');
  const supplied = String(req.get('x-admin-key') || '');
  if (!configured) return res.status(503).json({ error: 'Administración de modelos no configurada.' });
  if (!safeEqual(configured, supplied)) return res.status(403).json({ error: 'Acceso administrativo denegado.' });
  next();
};

const rateLimit = ({ windowMs = 60000, max = Number(process.env.RATE_LIMIT_PER_MINUTE || 90) } = {}) => (req, res, next) => {
  const now = Date.now();
  const key = `${req.serviceClient || req.ip}:${req.path}`;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > max) {
    res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Demasiadas solicitudes. Intenta nuevamente en unos segundos.' });
  }
  next();
};

module.exports = { authenticateService, authenticateAdmin, rateLimit };
