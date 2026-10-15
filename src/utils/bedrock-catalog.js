import fs from 'fs';
import path from 'path';
import { safeHomedir } from '../core/homedir.js';
import { fileURLToPath } from 'url';
import { log } from '@clack/prompts';
import {
    BedrockClient,
    ListInferenceProfilesCommand,
    ListFoundationModelsCommand,
} from '@aws-sdk/client-bedrock';

export const FALLBACK_BEDROCK_MODEL = 'us.anthropic.claude-sonnet-4-6';
export const GENERIC_MODEL_HINT = 'Live AWS Bedrock model';

// Keep in sync with MODEL_ID_RE in src/commands/add.js (duplicated here to
// avoid a module cycle between add.js and this loader).
const MODEL_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export const FALLBACK_CATALOG = {
    updatedAt: '2026-01-01',
    defaultModelId: FALLBACK_BEDROCK_MODEL,
    providers: [
        {
            provider: 'Anthropic',
            models: [
                {
                    id: FALLBACK_BEDROCK_MODEL,
                    name: 'Claude Sonnet 4.6',
                    hint: 'Recommended default — standard temperature/top_p SDK compatibility',
                    recommended: true,
                    scopes: ['us'],
                },
            ],
        },
    ],
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUNDLED_CATALOG_PATH = path.join(__dirname, '../data/bedrock-models.json');

const PROVIDER_ALIASES = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    deepseek: 'DeepSeek',
    meta: 'Meta',
    amazon: 'Amazon',
    google: 'Google',
    mistral: 'Mistral AI',
    'mistral ai': 'Mistral AI',
    xai: 'xAI',
    moonshot: 'Moonshot AI',
    'moonshot ai': 'Moonshot AI',
    moonshotai: 'Moonshot AI',
    cohere: 'Cohere',
    stability: 'Stability AI',
    twelvelabs: 'TwelveLabs',
    writer: 'Writer',
    nvidia: 'NVIDIA',
    qwen: 'Qwen',
    minimax: 'MiniMax',
    zai: 'Zhipu AI',
    z: 'Zhipu AI',
};

function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

// Returns a durable tier + API-compatibility hint for a model family,
// matched case-insensitively on the normalized provider and model ID
// substrings. Unknown families fall back to GENERIC_MODEL_HINT so the
// maintainer sync can flag models missing hint rules.
export function generateHintForModel(provider, modelId, { defaultModelId = FALLBACK_BEDROCK_MODEL } = {}) {
    if (modelId === defaultModelId) {
        return 'Recommended default — standard temperature/top_p SDK compatibility';
    }
    const id = String(modelId ?? '').toLowerCase();
    const has = (...substrings) => substrings.every((part) => id.includes(part));
    const hasAny = (...substrings) => substrings.some((part) => id.includes(part));

    switch (normalizeProviderName(provider)) {
        case 'Anthropic':
            if (has('fable')) return 'Mythos-tier autonomous workflows & agents (adaptive thinking on; omit temperature)';
            if (has('opus-5') || (has('opus') && has('-5'))) {
                return 'Opus-tier long-horizon coding & agents (adaptive thinking on; omit temperature)';
            }
            if (has('sonnet-5') || (has('sonnet') && has('-5'))) {
                return 'Sonnet-tier coding & agents (adaptive thinking on; omit temperature)';
            }
            if (has('opus')) return 'Opus 4-series deep reasoning & engineering (standard temperature/top_p compatible)';
            if (has('sonnet')) return 'Balanced coding & reasoning (standard temperature/top_p compatible)';
            if (has('haiku')) return 'Haiku-tier low-latency, high-throughput workloads';
            break;
        case 'OpenAI':
            if (has('safeguard')) return 'Safety moderation & content classification';
            if (has('gpt-oss')) return 'Open-weights GPT model for self-hosted or fine-tuned inference';
            if (hasAny('astra', 'gpt-6')) return 'Flagship multi-step reasoning & agentic workflows (Converse API)';
            if (has('sol')) return 'High-depth reasoning & coding (Responses API)';
            if (has('terra')) return 'Balanced everyday production workloads (Responses API)';
            if (has('luna')) return 'Fast, low-cost high-volume tasks (Responses API)';
            if (hasAny('gpt-5', 'gpt-4', 'o1', 'o3', 'o4')) return 'General reasoning & coding (Responses API)';
            break;
        case 'DeepSeek':
            if (has('r1')) return 'Open-weights reasoning model (chain-of-thought)';
            if (hasAny('v3', 'deepseek')) return 'High-efficiency reasoning & code generation';
            break;
        case 'Meta':
            if (has('maverick')) return 'Llama multimodal mixture-of-experts reasoning';
            if (has('scout')) return 'Llama long-context & fast inference';
            if (has('llama')) return 'Open-weights Llama model for general text & coding';
            break;
        case 'Amazon':
            if (has('nova-premier')) return 'Complex multimodal reasoning & teacher distillation';
            if (has('nova-pro')) return 'Multimodal reasoning, coding & agentic workflows (no FTU form required)';
            if (has('nova-lite')) return 'Fast, low-cost multimodal tasks (no FTU form required)';
            if (has('nova-micro')) return 'Ultra-fast, lowest-cost text workloads (no FTU form required)';
            // Catches nova-2 and future nova generations after the known tiers.
            if (has('nova')) return 'Multimodal reasoning, coding & cost-efficient generation';
            if (has('titan')) return 'Amazon Titan text & embeddings model';
            break;
        case 'Google':
            if (has('gemma')) return 'Open-weights multimodal & text reasoning';
            break;
        case 'Mistral AI':
            if (has('voxtral')) return 'Audio & speech-to-text multimodal understanding';
            if (has('devstral')) return 'Specialized software engineering & code reasoning';
            if (has('large')) return 'Complex multilingual reasoning & coding';
            if (has('codestral')) return 'Specialized code generation & completion';
            if (has('pixtral')) return 'Multimodal vision & document understanding';
            if (hasAny('small', 'ministral')) return 'Low-latency, cost-efficient text tasks';
            break;
        case 'xAI':
            if (has('grok')) return 'Real-time reasoning, coding & tool use';
            break;
        case 'Moonshot AI':
            if (has('kimi')) return 'Long-context agentic tool use & coding';
            break;
        case 'Cohere':
            if (has('command')) return 'Enterprise RAG, tool use & multilingual generation';
            if (hasAny('embed', 'rerank')) return 'Enterprise semantic search, embeddings & reranking';
            break;
        case 'Stability AI':
            if (hasAny('stable', 'upscale', 'inpaint', 'outpaint')) return 'Image generation, upscaling & editing';
            break;
        case 'TwelveLabs':
            if (has('pegasus')) return 'Video understanding, search & narrative extraction';
            break;
        case 'Writer':
            if (has('palmyra')) return 'Enterprise-focused writing, document analysis & vision';
            break;
        case 'NVIDIA':
            if (has('nemotron')) return 'High-performance enterprise reasoning & synthetic data generation';
            break;
        case 'Qwen':
            if (has('qwen')) return 'Multilingual reasoning, coding & vision understanding';
            break;
        case 'MiniMax':
            if (has('minimax')) return 'Long-context multilingual generation & agentic workflows';
            break;
        case 'Zhipu AI':
            if (has('glm')) return 'Bilingual Chinese-English reasoning, coding & tool use';
            break;
        default:
            break;
    }
    return GENERIC_MODEL_HINT;
}

// Scans a catalog for models without family-specific hint rules. Fails
// when any flagship (Anthropic/OpenAI) model is unmatched or when the
// generic-hint share exceeds maxGenericRatio.
export function validateCatalogHints(catalog, { maxGenericRatio = 0.15 } = {}) {
    const unmatchedModels = [];
    let totalModels = 0;
    for (const group of catalog?.providers || []) {
        const provider = normalizeProviderName(group?.provider);
        for (const model of group?.models || []) {
            totalModels += 1;
            const generated = generateHintForModel(provider, model?.id, {
                defaultModelId: catalog.defaultModelId,
            });
            if (model?.hint === GENERIC_MODEL_HINT || generated === GENERIC_MODEL_HINT) {
                unmatchedModels.push({ provider, id: model?.id, name: model?.name });
            }
        }
    }
    const unmatchedRatio = totalModels === 0 ? 0 : unmatchedModels.length / totalModels;
    const flagshipUnmatched = unmatchedModels.some(
        (entry) => entry.provider === 'Anthropic' || entry.provider === 'OpenAI'
    );
    return {
        ok: !flagshipUnmatched && unmatchedRatio <= maxGenericRatio,
        totalModels,
        unmatchedModels,
        unmatchedRatio,
    };
}

export function isValidCatalog(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (typeof data.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.updatedAt)) return false;
    if (typeof data.defaultModelId !== 'string' || data.defaultModelId === '') return false;
    if (!Array.isArray(data.providers) || data.providers.length === 0) return false;
    return data.providers.every((group) => {
        if (!group || typeof group !== 'object') return false;
        if (typeof group.provider !== 'string' || group.provider === '') return false;
        if (!Array.isArray(group.models) || group.models.length === 0) return false;
        return group.models.every(
            (model) =>
                model &&
                typeof model === 'object' &&
                typeof model.id === 'string' &&
                model.id !== '' &&
                typeof model.name === 'string' &&
                model.name !== ''
        );
    });
}

// Normalizes provider identifiers from inference profile IDs
// (`us.anthropic.claude-...`), foundation model ARNs
// (`...:foundation-model/anthropic.claude-...`), and plain provider names
// (`Anthropic`, `Mistral`) to one canonical display name.
export const SCOPE_ORDER = ['us', 'global', 'eu', 'apac', 'regional'];
const CANONICAL_SCOPE_PRIORITY = ['us', 'global', 'eu', 'apac'];

// Splits a Bedrock model ID into its cross-region scope and base model:
// `us.anthropic.claude-x` -> `{ scope: 'us', baseId: 'anthropic.claude-x' }`.
// Unprefixed (region-pinned) IDs report `regional` with the ID as its base.
export function parseModelScope(modelId) {
    const match = /^(us|eu|apac|global)\.(.+)$/.exec(modelId || '');
    if (match) return { scope: match[1], baseId: match[2] };
    return { scope: 'regional', baseId: modelId };
}

// Live profile names carry routing prefixes ("US ...", "GLOBAL ...") that
// duplicate the scope routing — strip them for a clean display name.
export function cleanDisplayName(name) {
    return String(name || '').replace(/^(US|GLOBAL|Global) +/, '');
}

export function normalizeProviderName(raw) {
    let token = String(raw ?? '').trim();
    const arnMarker = 'foundation-model/';
    const arnIdx = token.indexOf(arnMarker);
    if (arnIdx !== -1) {
        token = token.slice(arnIdx + arnMarker.length).split('.')[0];
    } else if (token.includes('.') && !token.includes(' ') && !token.includes('/')) {
        const parts = token.split('.');
        // Cross-region profile IDs prefix the provider with a geo scope
        // (`us.anthropic...`); bare model IDs (`deepseek.v3.2`) lead with it.
        const geoPrefixes = new Set(['us', 'eu', 'ap', 'apac', 'sa', 'ca', 'me', 'af', 'il', 'global']);
        token = parts.length > 1 && geoPrefixes.has(parts[0].toLowerCase()) ? parts[1] : parts[0];
    }
    const key = token.trim().toLowerCase();
    if (!key) return 'Other';
    return PROVIDER_ALIASES[key] || token.trim();
}

// Collapses cross-region inference-profile variants (`us.*`, `global.*`,
// unprefixed, ...) of one underlying model into a single entry per baseId.
// The canonical id follows us > global > eu > apac > unprefixed; surviving
// scopes are recorded ordered by SCOPE_ORDER (`regional` drops out when any
// cross-region profile exists). Order of first appearance is preserved.
export function dedupeProviderModels(provider, models, { defaultModelId } = {}) {
    const byBase = new Map();
    for (const model of models || []) {
        const { scope, baseId } = parseModelScope(model?.id);
        if (!byBase.has(baseId)) byBase.set(baseId, []);
        byBase.get(baseId).push({ model, scope });
    }
    const deduped = [];
    for (const [baseId, variants] of byBase) {
        const scopes = [...new Set(variants.map((entry) => entry.scope))]
            .sort((a, b) => SCOPE_ORDER.indexOf(a) - SCOPE_ORDER.indexOf(b));
        const routable = scopes.some((scope) => scope !== 'regional')
            ? scopes.filter((scope) => scope !== 'regional')
            : scopes;
        const canonicalScope = CANONICAL_SCOPE_PRIORITY.find((scope) => routable.includes(scope));
        const canonical = variants.find((entry) => entry.scope === canonicalScope)?.model ?? variants[0].model;
        const entry = {
            ...canonical,
            id: canonicalScope ? `${canonicalScope}.${baseId}` : baseId,
            name: cleanDisplayName(canonical.name),
            scopes: routable,
        };
        if (variants.some((entry) => entry.model.recommended)) {
            entry.recommended = true;
            entry.hint = generateHintForModel(provider, entry.id, { defaultModelId });
        }
        deduped.push(entry);
    }
    return deduped;
}

// Finds a catalog entry by exact ID, then by base model (so an unprefixed
// ID still matches its canonical cross-region entry and vice versa).
export function findCatalogEntry(catalog, modelId) {
    const { baseId } = parseModelScope(modelId);
    for (const group of catalog?.providers || []) {
        const exact = (group.models || []).find((model) => model.id === modelId);
        if (exact) return exact;
    }
    for (const group of catalog?.providers || []) {
        const byBase = (group.models || []).find((model) => parseModelScope(model.id).baseId === baseId);
        if (byBase) return byBase;
    }
    return null;
}

function findCatalogEntryById(modelId) {
    return findCatalogEntry(loadBedrockCatalog(), modelId);
}

// Picks the model ID variant matching the project's AWS region: eu-* regions
// prefer `eu`, ap-* prefer `apac`, and everything else (including us-*)
// prefers `us` — each falling back through `global`, `us`, then the bare
// baseId. Accepts a catalog entry or an ID looked up in the catalog; entries
// without recorded scopes (older caches) resolve from their own ID's scope.
export function resolveModelIdForRegion(modelEntryOrId, awsRegion = 'us-east-2') {
    const entry = typeof modelEntryOrId === 'string' ? findCatalogEntryById(modelEntryOrId) : modelEntryOrId;
    if (!entry || typeof entry.id !== 'string') {
        return typeof modelEntryOrId === 'string' ? modelEntryOrId : undefined;
    }
    const { scope: ownScope, baseId } = parseModelScope(entry.id);
    const scopes = Array.isArray(entry.scopes) && entry.scopes.length > 0 ? entry.scopes : [ownScope];
    const region = awsRegion || 'us-east-2';
    const chain = region.startsWith('eu-')
        ? ['eu', 'global', 'us']
        : region.startsWith('ap-')
            ? ['apac', 'global', 'us']
            : ['us', 'global'];
    for (const scope of chain) {
        if (scopes.includes(scope)) return `${scope}.${baseId}`;
    }
    return baseId;
}

function loadBundledCatalog() {
    try {
        const data = JSON.parse(fs.readFileSync(BUNDLED_CATALOG_PATH, 'utf-8'));
        if (isValidCatalog(data)) return data;
    } catch {
        // Fall through to the in-memory fallback below.
    }
    return deepClone(FALLBACK_CATALOG);
}

function resolveCacheEnvPath() {
    return process.env.GRADA_BEDROCK_CACHE_PATH || process.env.DEPLOY_STACK_BEDROCK_CACHE_PATH;
}

// Home-rooted cache candidate: null when HOME is undeterminable (the
// loader drops null candidates, so homeless runs fall through to the
// bundled catalog instead of throwing at import time).
function homeCachePath(...segments) {
    const home = safeHomedir();
    return home === null ? null : path.join(home, ...segments);
}

function resolveCachePath(options = {}) {
    return (
        options.cachePath ||
        resolveCacheEnvPath() ||
        homeCachePath('.grada', 'bedrock-models-cache.json')
    );
}

function legacyCachePath() {
    return homeCachePath('.deploy-stack', 'bedrock-models-cache.json');
}

export function loadBedrockCatalog(options = {}) {
    const bundled = loadBundledCatalog();
    const explicitCachePath = options.cachePath || resolveCacheEnvPath();
    const testEnv = Boolean(process.env.VITEST || process.env.NODE_ENV === 'test');
    if (testEnv && !explicitCachePath) return bundled;
    // An explicit path wins outright; otherwise the new default path is
    // tried before the legacy one. Null candidates (undeterminable HOME)
    // and unusable files fall through to the bundled catalog.
    const candidates = explicitCachePath
        ? [explicitCachePath]
        : [resolveCachePath(options), legacyCachePath()].filter((candidate) => candidate !== null);
    for (const candidate of candidates) {
        try {
            const cached = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
            if (isValidCatalog(cached) && cached.updatedAt >= bundled.updatedAt) return migrateCacheShape(cached);
        } catch {
            // Missing, unreadable, or invalid cache: try the next candidate.
        }
    }
    return bundled;
}

// Caches written before cross-region dedup carry one entry per inference
// profile variant with no `scopes`. Collapse them in memory so listings and
// the picker stay deduplicated even before the next --refresh rewrites the
// cache file. Already-deduped caches pass through untouched.
function migrateCacheShape(cached) {
    const needsMigration = cached.providers.some((group) =>
        (group.models || []).some((model) => !Array.isArray(model?.scopes))
    );
    if (!needsMigration) return cached;
    const migrated = deepClone(cached);
    for (const group of migrated.providers) {
        group.models = dedupeProviderModels(group.provider, group.models, {
            defaultModelId: migrated.defaultModelId,
        });
    }
    return migrated;
}

async function collectLiveEntries(client) {
    const entries = [];
    let nextToken;
    do {
        const response = await client.send(
            new ListInferenceProfilesCommand({
                typeEquals: 'SYSTEM_DEFINED',
                ...(nextToken ? { nextToken } : {}),
            })
        );
        for (const profile of response.inferenceProfileSummaries || []) {
            if (profile?.status !== 'ACTIVE') continue;
            const id = profile.inferenceProfileId;
            if (typeof id !== 'string' || !MODEL_ID_PATTERN.test(id)) continue;
            const firstArn = profile.models?.[0]?.modelArn || '';
            entries.push({
                id,
                name: profile.inferenceProfileName || id,
                provider: normalizeProviderName(firstArn || id),
            });
        }
        nextToken = response.nextToken;
    } while (nextToken);

    let foundationToken;
    do {
        const response = await client.send(
            new ListFoundationModelsCommand({
                byInferenceType: 'ON_DEMAND',
                ...(foundationToken ? { nextToken: foundationToken } : {}),
            })
        );
        for (const model of response.modelSummaries || []) {
            if (model?.modelLifecycle?.status !== 'ACTIVE') continue;
            const id = model.modelId;
            if (typeof id !== 'string' || !MODEL_ID_PATTERN.test(id)) continue;
            entries.push({
                id,
                name: model.modelName || id,
                provider: normalizeProviderName(model.providerName || id),
            });
        }
        foundationToken = response.nextToken;
    } while (foundationToken);

    return entries;
}

export async function refreshBedrockCatalog(options = {}) {
    const bundled = loadBundledCatalog();
    const region = options.region || process.env.AWS_REGION || 'us-east-2';
    const cachePath = resolveCachePath(options);
    if (cachePath === null) {
        log.warn('Bedrock catalog refresh skipped: the home directory is undeterminable, so there is nowhere to write the cache. Using the bundled catalog.');
        return bundled;
    }
    const pruneMissing = options.pruneMissing === true;
    try {
        const client = options.bedrockClient || new BedrockClient({ region });
        const liveEntries = await collectLiveEntries(client);

        const merged = deepClone(bundled);
        const existingIds = new Set();
        for (const group of merged.providers) {
            for (const model of group.models) existingIds.add(model.id);
        }
        const liveIds = new Set();
        for (const entry of liveEntries) {
            liveIds.add(entry.id);
            if (existingIds.has(entry.id)) continue;
            existingIds.add(entry.id);
            let group = merged.providers.find((candidate) => candidate.provider === entry.provider);
            if (!group) {
                group = { provider: entry.provider, models: [] };
                merged.providers.push(group);
            }
            group.models.push({
                id: entry.id,
                name: entry.name,
                hint: generateHintForModel(entry.provider, entry.id, { defaultModelId: merged.defaultModelId }),
            });
        }

        if (pruneMissing && liveIds.size > 0) {
            for (const group of merged.providers) {
                group.models = group.models.filter(
                    (model) => liveIds.has(model.id) || model.id === merged.defaultModelId
                );
            }
            merged.providers = merged.providers.filter((group) => group.models.length > 0);
            if (!liveIds.has(merged.defaultModelId)) {
                console.warn(`::warning file=src/data/bedrock-models.json::Default model "${merged.defaultModelId}" was not found in live ACTIVE Bedrock results and was only retained by the safety guard. Time to rotate defaultModelId.`);
            }
        }

        for (const group of merged.providers) {
            group.models = dedupeProviderModels(group.provider, group.models, {
                defaultModelId: merged.defaultModelId,
            });
        }

        merged.updatedAt = new Date().toISOString().slice(0, 10);
        fs.mkdirSync(path.dirname(cachePath), { recursive: true });
        fs.writeFileSync(cachePath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
        return merged;
    } catch (error) {
        log.warn(`Bedrock catalog refresh failed (${error?.message || error}); using the bundled catalog.`);
        return bundled;
    }
}
