# Guaba AI Service

Servicio transversal de IA desplegable en Railway. Los clientes finales no deben llamarlo directamente: cada backend de producto lo consume mediante una firma HMAC.

## Capacidades actuales

- OCR estructurado para facturas, recibos, documentos y carteles.
- Agente financiero de solo lectura con planificador y respuesta estructurada independientes.
- Selección de modelos por capacidad, prioridad, health y fallback.
- Cambio, activación y prueba de modelos sin reiniciar el servicio.
- BYOK por organización: claves de Together cifradas con AES-256-GCM.
- FinOps por llamada: tokens, latencia, errores, costo estimado y costo asumido por Guaba.

## Flujo

`móvil/web -> guaba-api -> Guaba AI Service -> Together AI`

Guaba API conserva la autenticación de usuarios, el aislamiento por propietario y el acceso a datos financieros. Este servicio recibe solo el contexto mínimo necesario.

## Tablas

- `ai_model_configs`: modelos activos, prioridad, configuración, precio y estado de fallback.
- `ai_provider_credentials`: credenciales BYOK cifradas y asociadas a un `tenant_id`.
- `ai_model_events`: una fila por intento de modelo con cliente, canal, tenant, tokens, costos, latencia y error.

`estimated_cost_usd` representa el valor estimado de todo el consumo. `platform_cost_usd` representa únicamente el gasto realizado con la clave de Guaba; para BYOK es cero. `pricing_status = unpriced` evita reportar falsos ceros cuando falta una tarifa.

## Endpoints de producto

- `POST /v1/ocr/extract`
- `POST /v1/agent/plan`: selecciona herramientas autorizadas; no ejecuta operaciones ni recibe acceso directo a la base de datos.
- `POST /v1/agent/respond`

El flujo recomendado del agente es `plan -> ejecución segura en guaba-api -> respond`. Los resultados de herramientas se tratan como datos no confiables y la respuesta final incluye evidencias que el backend debe validar contra los identificadores realmente consultados.

La selección de modelos se divide por responsabilidad:

- `ocr`: modelo visual y fallback propios.
- `agent_planner`: `openai/gpt-oss-20b`, con `Qwen/Qwen3.5-9B` como fallback.
- `agent_response`: `openai/gpt-oss-120b`, con `Qwen/Qwen3.5-9B` como fallback y `openai/gpt-oss-20b` como último recurso.

Cada fila puede definir `requestTimeoutMs` en `settings`. Al superar ese tiempo, el intento se registra como fallo, entra temporalmente en cooldown y la solicitud continúa con el siguiente modelo activo por prioridad.

Si todos los modelos de una capacidad coinciden temporalmente en cooldown, el servicio realiza una prueba controlada con el modelo de menor conteo de fallos. Esto evita responder que no existen modelos activos cuando en realidad hay modelos configurados atravesando una recuperación transitoria.

También se conservan temporalmente `/extract-info`, `/callApiChatTogether` y `/callApiChatTogetherRag` para migrar consumidores anteriores.

## Endpoints administrativos

Requieren firma HMAC y `X-Admin-Key`.

- `GET/POST/PATCH /v1/admin/models`
- `POST /v1/admin/models/sync-pricing`
- `POST /v1/admin/models/:id/test`
- `GET/POST/PATCH /v1/admin/credentials`
- `POST /v1/admin/credentials/:id/rotate`
- `GET /v1/admin/usage/summary`
- `GET /v1/admin/usage/events`

## Clave de Together por cliente (BYOK)

`TOGETHER` es la credencial de plataforma y funciona solamente como respaldo. Para registrar la clave propia de un cliente se usa `POST /v1/admin/credentials` con firma HMAC, `X-Admin-Key` y este cuerpo:

```json
{
  "tenantId": "id-del-cliente",
  "provider": "together",
  "label": "Together principal",
  "apiKey": "clave-del-cliente"
}
```

El servicio cifra la clave con `AI_CREDENTIALS_MASTER_KEY`; las consultas administrativas solo muestran sus cuatro últimos caracteres. `guaba-api` envía el mismo `tenantId` en cada solicitud, por lo que la selección es automática: primero BYOK y, si no existe una credencial activa, la clave de plataforma. La rotación se realiza mediante `POST /v1/admin/credentials/:id/rotate` sin reiniciar el servicio.

La lista completa de variables está en `.env.example`.

## Despliegue seguro

1. Configurar `GUABA_SERVICE_KEY`, `GUABA_SERVICE_SECRET`, `AI_ADMIN_KEY` y `AI_CREDENTIALS_MASTER_KEY` en Railway.
2. Desplegar este servicio manteniendo `ALLOW_LEGACY_BASIC_AUTH=true`.
3. Configurar en Guaba API `AI_SERVICE_URL`, `AI_SERVICE_KEY` y `AI_SERVICE_SECRET`.
4. Verificar OCR y agente.
5. Cambiar `ALLOW_LEGACY_BASIC_AUTH=false` y retirar las claves de Together/Basic de los clientes móviles.

No cambies `AI_CREDENTIALS_MASTER_KEY` después de guardar credenciales BYOK sin ejecutar antes un proceso de rotación, porque las claves existentes dejarían de poder descifrarse.
