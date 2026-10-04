import { note, confirm, isCancel, cancel } from '@clack/prompts';
import pc from 'picocolors';
import fs from 'fs';
import path from 'path';
import { ADDON_REGISTRY } from './addons.js';
import { detectComputeTargetFromMainTf } from './resolvers.js';
import { trackEvent, flushTelemetry, trackFailure } from '../core/telemetry.js';

export const COST_ESTIMATE_MARKER = 'Estimated Fixed Monthly Baseline:';
export const LEGACY_COST_ESTIMATE_MARKER = 'Estimated Monthly Cost:';

// Cost benchmarks for AWS us-east-2 baseline (Fargate + ALB)
const PRICING_TABLE = {
    fargate: {
        cpuPerHour: 0.04048,   // per vCPU hour
        memoryPerHour: 0.004445 // per GB hour
    },
    alb: {
        basePerHour: 0.0225,   // ~$16.43/month base
        lcuPerHour: 0.008      // Baseline ~1 LCU (~$5.84/month)
    },
    rds: {
        microPerHour: 0.016,   // ~$11.68/mo for db.t4g.micro
        storagePerMonth: 2.30,  // 20GB gp3 storage baseline
        auroraAcuPerHour: 0.12  // Serverless v2 compute when active ($0/mo idle at 0 ACU)
    },
    secretsManagerPerSecret: 0.40 // per secret per month
};

// 1. Parse the local terraform files to extract the actual configuration
export function parseTerraformConfig(tfDir) {
    const tfvarsPath = path.join(tfDir, 'terraform.tfvars');
    let region = 'us-east-2';
    let cpu = 256;
    let memory = 512;
    let framework = 'Application';

    // Read rendered cpu/memory from main.tf first so non-micro sizes chosen
    // at init time survive apply previews and README cost syncs.
    const mainTfPath = path.join(tfDir, 'main.tf');
    let computeTarget = 'ecs';
    if (fs.existsSync(mainTfPath)) {
        const mainTf = fs.readFileSync(mainTfPath, 'utf-8');
        const renderedCpu = mainTf.match(/cpu\s*=\s*"(\d+)"/);
        if (renderedCpu) cpu = parseInt(renderedCpu[1], 10);
        const renderedMemory = mainTf.match(/memory\s*=\s*"(\d+)"/);
        if (renderedMemory) memory = parseInt(renderedMemory[1], 10);
        computeTarget = detectComputeTargetFromMainTf(mainTf);
    }

    // terraform.tfvars overrides rendered values when present; hard defaults
    // apply only when neither source specifies them.
    if (fs.existsSync(tfvarsPath)) {
        const content = fs.readFileSync(tfvarsPath, 'utf-8');

        // Use regex to pull values out of the HCL format
        const regionMatch = content.match(/aws_region\s*=\s*"([^"]+)"/);
        if (regionMatch) region = regionMatch[1];

        const cpuMatch = content.match(/container_cpu\s*=\s*(\d+)/);
        if (cpuMatch) cpu = parseInt(cpuMatch[1], 10);

        const memoryMatch = content.match(/container_memory\s*=\s*(\d+)/);
        if (memoryMatch) memory = parseInt(memoryMatch[1], 10);
    }

    // Check if database files exist
    const hasDb = fs.existsSync(path.join(tfDir, 'rds.tf')) || fs.existsSync(path.join(tfDir, 'database.tf'));
    const hasWorker = fs.existsSync(path.join(tfDir, 'worker.tf'));
    const hasSecrets = fs.existsSync(path.join(tfDir, 'secrets.tf'));

    // Detect the provisioned engine from database.tf content (Aurora
    // cluster first, then MySQL; anything else is standard PostgreSQL).
    let dbEngine = 'postgres';
    if (hasDb) {
        const databaseTfPath = path.join(tfDir, 'database.tf');
        if (fs.existsSync(databaseTfPath)) {
            const databaseTf = fs.readFileSync(databaseTfPath, 'utf-8');
            if (databaseTf.includes('resource "aws_rds_cluster"')) {
                dbEngine = 'aurora-postgresql';
            } else if (/engine\s*=\s*"mysql"/.test(databaseTf)) {
                dbEngine = 'mysql';
            }
        }
    }

    // Registry-driven addon detection: capability keys whose .tf file exists.
    const addons = [];
    for (const [capability, entry] of Object.entries(ADDON_REGISTRY)) {
        if (!entry) continue;
        if (fs.existsSync(path.join(tfDir, entry.file))) addons.push(capability);
    }

    return { framework, region, cpu, memory, hasDb, dbEngine, hasWorker, hasSecrets, addons, computeTarget };
}

// 2. Calculate itemized monthly costs based on task definition settings
export function estimateMonthlyCost({ cpu = 256, memory = 512, hasDb = false, dbEngine = 'postgres', hasWorker = false, hasSecrets = false, addons = [], computeTarget = 'ecs' }) {
    const vCpu = cpu / 1024;
    const memGb = memory / 1024;
    const hoursInMonth = 730;

    // If a worker service exists, we are running a second identical Fargate task.
    // Lambda web functions are scale-to-zero (usage-based, $0 fixed); only a
    // hand-attached Fargate worker would still bill.
    const taskMultiplier = computeTarget === 'static'
        ? 0 // S3 + CloudFront: no containers, no fixed compute baseline.
        : computeTarget === 'lambda' ? (hasWorker ? 1 : 0) : (hasWorker ? 2 : 1);

    const fargateCost = ((vCpu * PRICING_TABLE.fargate.cpuPerHour) +
        (memGb * PRICING_TABLE.fargate.memoryPerHour)) * hoursInMonth * taskMultiplier;
    // API Gateway HTTP API v2 is usage-based ($1.00 per million requests)
    // with no fixed hourly baseline.
    const albCost = computeTarget === 'lambda' || computeTarget === 'static'
        ? 0
        : (PRICING_TABLE.alb.basePerHour + PRICING_TABLE.alb.lcuPerHour) * hoursInMonth;
    // Aurora Serverless v2 idles at 0 ACU: $0/mo idle compute baseline
    // (+$0.12/ACU-hr when active); managed instances bill the micro rate.
    const dbCost = !hasDb
        ? 0
        : dbEngine === 'aurora-postgresql'
            ? 0
            : (PRICING_TABLE.rds.microPerHour * hoursInMonth) + PRICING_TABLE.rds.storagePerMonth;

    // Secrets Manager bills per secret: one for the base app-secrets JSON
    // secret plus one for the RDS managed master password when hasDb is true.
    const secretCount = (hasSecrets ? 1 : 0) + (hasDb ? 1 : 0);
    const secretsCost = secretCount * PRICING_TABLE.secretsManagerPerSecret;

    // Future addons may carry a fixed monthly fee via cost.monthlyFixed.
    let addonsFixedCost = 0;
    for (const key of addons || []) {
        const entry = ADDON_REGISTRY[key];
        if (!entry) continue;
        if (entry.cost && entry.cost.monthlyFixed > 0) addonsFixedCost += entry.cost.monthlyFixed;
    }

    const total = fargateCost + albCost + dbCost + secretsCost + addonsFixedCost;

    return {
        fargateMonthly: fargateCost.toFixed(2),
        albMonthly: albCost.toFixed(2),
        dbMonthly: dbCost.toFixed(2),
        secretsMonthly: secretsCost.toFixed(2),
        totalMonthly: total.toFixed(2)
    };
}

// FinOps savings while an environment sleeps: paused Fargate replicas plus
// paused RDS compute. Storage, ALB, and Secrets Manager keep billing, so
// they are excluded here. Aurora Serverless v2 idles at 0 ACU, so its
// compute savings are $0 (stopping only prevents active wake-ups).
export function estimateSleepSavings({ cpu = 256, memory = 512, hasDb = false, dbEngine = 'postgres', appReplicas = 1, workerReplicas = 0 } = {}) {
    const vCpu = cpu / 1024;
    const memGb = memory / 1024;
    const hoursInMonth = 730;
    const perReplicaMonthly = ((vCpu * PRICING_TABLE.fargate.cpuPerHour)
        + (memGb * PRICING_TABLE.fargate.memoryPerHour)) * hoursInMonth;
    const fargateMonthly = perReplicaMonthly * (Math.max(0, appReplicas) + Math.max(0, workerReplicas));
    const dbComputeMonthly = !hasDb || dbEngine === 'aurora-postgresql'
        ? 0
        : PRICING_TABLE.rds.microPerHour * hoursInMonth;
    const monthly = fargateMonthly + dbComputeMonthly;
    return {
        fargateMonthly: fargateMonthly.toFixed(2),
        dbComputeMonthly: dbComputeMonthly.toFixed(2),
        monthly: monthly.toFixed(2),
        hourly: (monthly / hoursInMonth).toFixed(3),
    };
}

// Visible width of a styled line (ANSI escapes don't occupy columns).
function visibleLength(text) {
    return String(text).replace(/\[[0-9;]*m/g, '').length;
}

function formatBaselineLine(totalMonthly, parts, suffix = '') {
    const breakdown = parts.length > 0 && suffix
        ? `${parts.join(', ')} ${suffix}`
        : [...parts, suffix].filter(Boolean).join(', ');
    return `${pc.bold('Fixed Baseline:')} ${pc.green(pc.bold(`~$${totalMonthly}/mo`))} ${pc.dim(`(${breakdown})`)}`;
}

// Builds the Fixed Baseline line, folding Secrets/Addons into a compact
// `+$X other` part when the full breakdown would exceed 90 visible columns.
export function buildBaselineLine(totalMonthly, costParts, secretsMonthly = 0, addonsMonthly = 0, suffix = '') {
    const full = formatBaselineLine(totalMonthly, costParts, suffix);
    if (visibleLength(full) <= 90) return full;

    const folded = (Number(secretsMonthly) || 0) + (Number(addonsMonthly) || 0);
    const compactParts = costParts.filter(
        (part) => !part.startsWith('Secrets: ') && !part.startsWith('Addons: ')
    );
    if (folded > 0) compactParts.push(`+$${folded.toFixed(2)} other`);
    const compact = formatBaselineLine(totalMonthly, compactParts, suffix);
    if (visibleLength(compact) <= 90) return compact;

    const bare = `${pc.bold('Fixed Baseline:')} ${pc.green(pc.bold(`~$${totalMonthly}/mo`))}`;
    return suffix ? `${bare} ${pc.dim(`(${suffix})`)}` : bare;
}

// Topology line for the managed database, per provisioned engine.
function dbTopologyLabel(dbEngine) {
    if (dbEngine === 'aurora-postgresql') {
        return `✨ ${pc.yellow('Amazon Aurora PostgreSQL')} (Serverless v2 · 0–2 ACU scale-to-zero)`;
    }
    if (dbEngine === 'mysql') {
        return `🐬 ${pc.yellow('Amazon RDS')} (MySQL managed instance)`;
    }
    return `🐘 ${pc.yellow('Amazon RDS')} (PostgreSQL managed instance)`;
}

// 3. Render the terminal architecture visualization and requests confirmation
export async function renderDryRunPreview(config, isDryRunFlag = false) {
    const { framework = 'Node.js', region = 'us-east-2', cpu = 256, memory = 512, hasDb = false, dbEngine = 'postgres', hasWorker = false, hasSecrets = false, addons = [], computeTarget = 'ecs' } = config;
    const isLambda = computeTarget === 'lambda';
    const isStatic = computeTarget === 'static';

    // Fixed the duplicate hasWorker argument
    const cost = estimateMonthlyCost({ cpu, memory, hasDb, dbEngine, hasWorker, hasSecrets, addons, computeTarget });

    const hourlyRate = (Number(cost.totalMonthly) / 730).toFixed(3); // 730 hours in a month
    const secretCount = (hasSecrets ? 1 : 0) + (hasDb ? 1 : 0);

    const validAddons = (addons || []).filter((key) => Boolean(ADDON_REGISTRY[key]));

    let addonsMonthly = 0;
    for (const key of validAddons) {
        addonsMonthly += ADDON_REGISTRY[key]?.cost?.monthlyFixed || 0;
    }

    // Lambda compute and API Gateway are usage-based with no fixed
    // baseline, so the Lambda breakdown starts at the database. Static has
    // no fixed-cost parts at all — its baseline line is built separately.
    const costParts = (isLambda || isStatic)
        ? []
        : [`Fargate: $${cost.fargateMonthly}`, `ALB: $${cost.albMonthly}`];
    if (hasDb) costParts.push(`RDS: $${cost.dbMonthly}`);
    const secretsMonthly = Number(cost.secretsMonthly) || 0;
    if (secretsMonthly > 0) costParts.push(`Secrets: $${cost.secretsMonthly}`);
    if (addonsMonthly > 0) costParts.push(`Addons: $${addonsMonthly.toFixed(2)}`);

    const addonNodes = [];
    if (validAddons.length >= 3) {
        addonNodes.push(`  ${pc.gray('├──')} 🧩 [${pc.bold(`Addons (${validAddons.length}): ${validAddons.join(', ')}`)}]`);
    } else {
        for (const key of validAddons) {
            const entry = ADDON_REGISTRY[key];
            addonNodes.push(`  ${pc.gray('├──')} 🧩 [${pc.bold(entry.label)}] ${pc.dim(`(${key})`)}`);
        }
    }
    const usageBasedCount = validAddons.filter((key) => (ADDON_REGISTRY[key]?.cost?.monthlyFixed || 0) === 0).length;
    const usageLine = usageBasedCount > 0
        ? `  + Usage-based (${usageBasedCount} addon${usageBasedCount === 1 ? '' : 's'}): $0/mo fixed · per request, storage & egress`
        : '';

    // Static hosting is exactly $0.00 fixed (no approximation tilde) with
    // all spend usage-based through S3 and CloudFront.
    const baselineLine = isStatic
        ? `${pc.bold('Fixed Baseline:')} ${pc.green(pc.bold(`$${cost.totalMonthly}/mo`))} ${pc.dim('(Usage-based only via S3/CloudFront)')}`
        : buildBaselineLine(cost.totalMonthly, costParts, secretsMonthly, addonsMonthly, isLambda ? '+ API GW & Lambda usage' : '');

    // Flattened the tree to eliminate nesting and vertical bloat
    const treeOutput = [
        `${pc.bold('Topology')} (${pc.cyan(region)}):`,
        isStatic
            ? `  ${pc.gray('├──')} 🌐 ${pc.bold('CloudFront')} (Global CDN)`
            : isLambda
                ? `  ${pc.gray('├──')} 🌐 ${pc.bold('API Gateway HTTP API v2')} (Scale-to-zero HTTPS entry)`
                : `  ${pc.gray('├──')} 🌐 ${pc.bold('ALB')} (Public Entry & Health: ${pc.green('200 OK')})`,
        isStatic
            ? `  ${pc.gray('├──')} 🔒 ${pc.bold('IAM OIDC')} (GitHub Auth)`
            : `  ${pc.gray('├──')} 🔒 ${pc.bold('IAM OIDC')} (GitHub Auth) & 🐳 ${pc.bold('ECR')} (Registry)`,
        hasDb ? `  ${pc.gray('├──')} ${dbTopologyLabel(dbEngine)}` : '',
        secretCount > 0 ? `  ${pc.gray('├──')} 🔑 [${pc.bold('Secrets Manager')} (${secretCount === 1 ? '1 secret' : `${secretCount} secrets`})]` : '',
        ...addonNodes,
        isStatic
            ? `  ${pc.gray('└──')} 📦 ${pc.bold('S3 Private Origin')} (Static Assets)`
            : isLambda
                ? `  ${pc.gray('└──')} ⚡ ${pc.bold('AWS Lambda Web Service')} 🟢 ${pc.green(framework)} [512 MB · Scale-to-zero]`
                : `  ${pc.gray(hasWorker ? '├──' : '└──')} 📦 ${pc.bold('ECS Web Service')} 🟢 ${pc.green(framework)} [${cpu} CPU / ${memory} MB]`,
        !isLambda && !isStatic && hasWorker ? `  ${pc.gray('└──')} 📦 ${pc.bold('ECS Worker Service')} 🔄 Background Tasks [${cpu} CPU / ${memory} MB]` : '',
        '',
        baselineLine,
        usageLine,
        `  ${pc.dim(`* ~$${hourlyRate}/hr (us-east-2 rates) · Destroy anytime: "npx grada-run destroy"`)}`
    ].filter(Boolean).join('\n');

    note(treeOutput, 'Cloud Infrastructure Pre-Flight Inspection');

    // 4. Check if this is a dry run (print & exit) or full apply (prompt & proceed)
    if (isDryRunFlag) {
        return true;
    }

    const shouldProceed = await confirm({
        message: 'Review completed. Provision this infrastructure to AWS now?',
        initialValue: true
    });

    if (isCancel(shouldProceed) || !shouldProceed) {
        cancel('Operation canceled. No infrastructure was created.');
        await trackFailure('infrastructure_applied', {
            status: 'cancelled_at_preview',
            ...buildCostTelemetryProps(config, cost),
        });
        process.exit(0);
    }

    return true;
}

// Shared cost/shape telemetry properties so visualizer.js and apply.js emit
// the exact same shape. projectName flows into telemetry's hashed distinct_id,
// keeping per-project funnels joinable without storing raw names.
export function buildCostTelemetryProps(config = {}, costs = estimateMonthlyCost(config)) {
    return {
        projectName: config.projectName || path.basename(process.cwd()),
        estimated_monthly_usd: Number(costs.totalMonthly),
        compute_target: config.computeTarget || 'ecs',
        cpu: config.cpu ?? 256,
        memory: config.memory ?? 512,
        has_db: Boolean(config.hasDb),
        db_engine: config.hasDb ? (config.dbEngine || 'postgres') : 'none',
        has_worker: Boolean(config.hasWorker),
        addons: config.addons || [],
        addon_count: (config.addons || []).length,
    };
}

const DOC_COST_LINE = (total) =>
    `* **${COST_ESTIMATE_MARKER}** ~$${total}/month (us-east-2 reference rates; excludes variable traffic, ECR/CloudWatch storage, and usage-based addons)`;

function buildActiveAddonsSection(addons = []) {
    const lines = [];
    for (const key of addons || []) {
        const entry = ADDON_REGISTRY[key];
        if (!entry) continue;
        lines.push(`- \`${key}\` (${entry.label}): ${entry.cost.summary}`);
    }
    if (lines.length === 0) return '';
    return ['### Active Addons (Usage-Based)', '', ...lines].join('\n');
}

// Refresh the cost baseline (and usage-based addon list) in the generated
// deployment docs after `grada add`. Checks DEPLOYMENT.md, README.md,
// GRADA.md, then legacy DEPLOY-STACK.md; no-ops gracefully when no file
// exists or the user removed the cost marker. Returns the updated file
// path, or null when untouched.
export function syncDocCostEstimate(cwd = process.cwd()) {
    const tfDir = path.join(cwd, 'terraform');
    if (!fs.existsSync(path.join(tfDir, 'main.tf'))) return null;

    let targetPath = null;
    for (const name of ['DEPLOYMENT.md', 'README.md', 'GRADA.md', 'DEPLOY-STACK.md']) {
        const candidate = path.join(cwd, name);
        if (!fs.existsSync(candidate)) continue;
        const content = fs.readFileSync(candidate, 'utf-8');
        if (content.includes(COST_ESTIMATE_MARKER) || content.includes(LEGACY_COST_ESTIMATE_MARKER)) {
            targetPath = candidate;
            break;
        }
    }
    if (!targetPath) return null;

    const detected = parseTerraformConfig(tfDir);
    const costs = estimateMonthlyCost(detected);

    const lines = fs.readFileSync(targetPath, 'utf-8').split('\n');
    const markerIdx = lines.findIndex(
        (line) => line.includes(COST_ESTIMATE_MARKER) || line.includes(LEGACY_COST_ESTIMATE_MARKER)
    );
    if (markerIdx === -1) return null;
    lines[markerIdx] = DOC_COST_LINE(costs.totalMonthly);

    // Drop any previously rendered Active Addons section (heading, blank
    // separators, and our `- \`key\`` bullets) so reruns replace rather than
    // duplicate it. Anything else is user content and stays untouched.
    const sectionIdx = lines.findIndex((line) => line.trim() === '### Active Addons (Usage-Based)');
    if (sectionIdx !== -1) {
        let endIdx = sectionIdx + 1;
        while (endIdx < lines.length && lines[endIdx].trim() === '') endIdx++;
        while (endIdx < lines.length && lines[endIdx].trim().startsWith('- `')) endIdx++;
        lines.splice(sectionIdx, endIdx - sectionIdx);
        if (lines[sectionIdx] === '' && lines[sectionIdx + 1] === '') lines.splice(sectionIdx, 1);
    }

    const section = buildActiveAddonsSection(detected.addons);
    if (section) {
        lines.splice(markerIdx + 1, 0, '', section);
    }

    fs.writeFileSync(targetPath, lines.join('\n'));
    return targetPath;
}