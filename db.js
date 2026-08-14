const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE,
  process.env.MYSQLUSER,
  process.env.MYSQLPASSWORD,
  {
    host: process.env.MYSQLHOST,
    port: process.env.MYSQLPORT || 3306,
    dialect: 'mysql',
    logging: false,
    pool: { max: 5, min: 0, acquire: 120000, idle: 10000 },
  }
);

const Document = sequelize.define('Document', {
  id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING(900), allowNull: true },
  extension: { type: DataTypes.STRING(900), allowNull: true },
  document_id: { type: DataTypes.STRING(900), allowNull: true },
  author: { type: DataTypes.STRING(500), allowNull: true },
  pages: { type: DataTypes.STRING(100), allowNull: true },
  description: { type: DataTypes.STRING(1000), allowNull: true },
  name_json: { type: DataTypes.STRING(1000), allowNull: true },
  url_json: { type: DataTypes.STRING(8000), allowNull: true },
  upload_date: { type: DataTypes.DATE, allowNull: true },
  created_date: { type: DataTypes.DATE, allowNull: true },
  isActive: { type: DataTypes.BOOLEAN, allowNull: true },
  userId: { type: DataTypes.BIGINT, allowNull: true },
  TypeDocumentId: { type: DataTypes.STRING(8000), allowNull: true },
}, { tableName: 'Document', timestamps: false });

const AiModelConfig = sequelize.define('AiModelConfig', {
  id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  capability: { type: DataTypes.STRING(40), allowNull: false },
  provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'together' },
  model: { type: DataTypes.STRING(180), allowNull: false },
  display_name: { type: DataTypes.STRING(180), allowNull: true },
  priority: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 100 },
  enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  settings: { type: DataTypes.JSON, allowNull: true },
  input_price_per_million: { type: DataTypes.DECIMAL(14, 6), allowNull: true },
  cached_input_price_per_million: { type: DataTypes.DECIMAL(14, 6), allowNull: true },
  output_price_per_million: { type: DataTypes.DECIMAL(14, 6), allowNull: true },
  price_currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'USD' },
  pricing_synced_at: { type: DataTypes.DATE, allowNull: true },
  last_success_at: { type: DataTypes.DATE, allowNull: true },
  last_failure_at: { type: DataTypes.DATE, allowNull: true },
  failure_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  cooldown_until: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'ai_model_configs',
  underscored: true,
  indexes: [
    { unique: true, fields: ['capability', 'provider', 'model'], name: 'uq_ai_model_capability' },
    { fields: ['capability', 'enabled', 'priority'], name: 'idx_ai_model_selection' },
  ],
});

const AiProviderCredential = sequelize.define('AiProviderCredential', {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  tenant_id: { type: DataTypes.STRING(180), allowNull: false },
  provider: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'together' },
  label: { type: DataTypes.STRING(120), allowNull: false, defaultValue: 'Principal' },
  encrypted_secret: { type: DataTypes.TEXT('long'), allowNull: false },
  encryption_iv: { type: DataTypes.STRING(64), allowNull: false },
  encryption_tag: { type: DataTypes.STRING(64), allowNull: false },
  key_version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  last_four: { type: DataTypes.STRING(8), allowNull: true },
  last_used_at: { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'ai_provider_credentials',
  underscored: true,
  indexes: [
    { unique: true, fields: ['tenant_id', 'provider', 'label'], name: 'uq_ai_credential_tenant_provider_label' },
    { fields: ['tenant_id', 'provider', 'enabled'], name: 'idx_ai_credential_selection' },
  ],
});

const AiModelEvent = sequelize.define('AiModelEvent', {
  id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  request_id: { type: DataTypes.STRING(64), allowNull: false },
  capability: { type: DataTypes.STRING(40), allowNull: false },
  provider: { type: DataTypes.STRING(40), allowNull: false },
  model: { type: DataTypes.STRING(180), allowNull: false },
  credential_id: { type: DataTypes.UUID, allowNull: true },
  billing_source: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'platform' },
  client_id: { type: DataTypes.STRING(100), allowNull: true },
  tenant_id: { type: DataTypes.STRING(180), allowNull: true },
  user_id: { type: DataTypes.STRING(180), allowNull: true },
  channel: { type: DataTypes.STRING(30), allowNull: true },
  status: { type: DataTypes.STRING(30), allowNull: false },
  latency_ms: { type: DataTypes.INTEGER, allowNull: true },
  input_tokens: { type: DataTypes.INTEGER, allowNull: true },
  cached_input_tokens: { type: DataTypes.INTEGER, allowNull: true },
  output_tokens: { type: DataTypes.INTEGER, allowNull: true },
  total_tokens: { type: DataTypes.INTEGER, allowNull: true },
  estimated_cost_usd: { type: DataTypes.DECIMAL(18, 9), allowNull: true },
  platform_cost_usd: { type: DataTypes.DECIMAL(18, 9), allowNull: true },
  pricing_status: { type: DataTypes.STRING(30), allowNull: false, defaultValue: 'unpriced' },
  error_code: { type: DataTypes.STRING(80), allowNull: true },
  error_message: { type: DataTypes.STRING(500), allowNull: true },
}, {
  tableName: 'ai_model_events',
  underscored: true,
  updatedAt: false,
  indexes: [
    { fields: ['capability', 'created_at'], name: 'idx_ai_events_capability_date' },
    { fields: ['request_id'], name: 'idx_ai_events_request' },
    { fields: ['client_id', 'created_at'], name: 'idx_ai_events_client_date' },
    { fields: ['tenant_id', 'created_at'], name: 'idx_ai_events_tenant_date' },
  ],
});

const seedModels = async () => {
  const configuredModel = (name, fallback) => {
    const value = String(process.env[name] || '').trim();
    return !value || /Llama-Vision-Free/i.test(value) ? fallback : value;
  };
  const seeds = [
    { capability: 'ocr', model: configuredModel('MODEL_VISION1', 'moonshotai/Kimi-K2.6'), priority: 10 },
    { capability: 'ocr', model: configuredModel('MODEL_VISION_FALLBACK', 'google/gemma-4-31B-it'), priority: 20 },
    {
      capability: 'agent_planner',
      model: configuredModel('MODEL_AGENT_PLANNER', 'openai/gpt-oss-20b'),
      priority: 10,
      settings: { plannerTemperature: 0, plannerMaxTokens: 350, requestTimeoutMs: 12000 },
    },
    {
      capability: 'agent_planner',
      model: configuredModel('MODEL_AGENT_PLANNER_FALLBACK', 'Qwen/Qwen3.5-9B'),
      priority: 20,
      settings: { plannerTemperature: 0, plannerMaxTokens: 350, requestTimeoutMs: 12000 },
    },
    {
      capability: 'agent_response',
      model: configuredModel('MODEL_AGENT_RESPONSE', 'openai/gpt-oss-120b'),
      priority: 10,
      settings: { temperature: 0.2, maxTokens: 800, requestTimeoutMs: 12000 },
    },
    {
      capability: 'agent_response',
      model: configuredModel('MODEL_AGENT_RESPONSE_FALLBACK', 'Qwen/Qwen3.5-9B'),
      priority: 20,
      settings: { temperature: 0.2, maxTokens: 800, requestTimeoutMs: 12000 },
    },
    {
      capability: 'agent_response',
      model: configuredModel('MODEL_AGENT_RESPONSE_LAST_RESORT', 'openai/gpt-oss-20b'),
      priority: 30,
      settings: { temperature: 0.15, maxTokens: 700, requestTimeoutMs: 10000 },
    },
  ];
  for (const seed of seeds) {
    await AiModelConfig.findOrCreate({
      where: { capability: seed.capability, provider: 'together', model: seed.model },
      defaults: seed,
    });
  }
  // Conserva el historial de FinOps, pero retira la capacidad anterior que mezclaba ambas etapas.
  await AiModelConfig.update({ enabled: false }, { where: { capability: 'agent' } });
};

const initializeDatabase = async () => {
  await sequelize.authenticate();
  await AiModelConfig.sync();
  await AiProviderCredential.sync();
  await AiModelEvent.sync();
  await seedModels();
  console.log('[database] connection ready');
};

module.exports = { sequelize, Document, AiModelConfig, AiProviderCredential, AiModelEvent, initializeDatabase };
