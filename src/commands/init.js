import fsSync from 'fs';
import path from 'path';
import { intro, outro, spinner, log, confirm, multiselect, select, cancel } from '@clack/prompts';
import color from 'picocolors';

import { checkDependency } from '../utils/system.js';
import { normalizeOptions } from '../utils/args.js';
import {
    detectFramework,
    parseProcfile,
    parseVercelConfig,
    analyzeNextConfig,
    analyzeSvelteConfig,
    analyzeAstroConfig,
    analyzeNestApp,
    splitProcfileCommand
} from '../utils/detector.js';
import { detectProjectCapabilities } from '../utils/capabilities.js';
import { ADDON_REGISTRY } from '../utils/addons.js';
import { validateAddonFlags, resolveAddonOptions, scaffoldAddon, DEFAULT_BEDROCK_MODEL } from './add.js';
import { injectMigrationGate } from './db/migrate.js';
import { scaffoldDriftWorkflow } from './drift.js';
import { trackEvent, flushTelemetry, getCliVersion } from '../core/telemetry.js';
import { failCommand } from '../utils/command.js';
import { getFrameworkWarning } from '../utils/warnings.js';
import { provisionStateBucket } from '../utils/aws.js';
import { generateTemplates } from '../utils/generator.js';
import { handleExistingFiles } from '../utils/backup.js';
import { estimateMonthlyCost, parseTerraformConfig, renderDryRunPreview } from '../utils/visualizer.js';
import { getTargetDirectory, getProjectConfig, promptWorkerCommand } from '../utils/prompts.js';
import { resolveDjangoWsgi, handleRailsCI } from '../utils/frameworks.js';
import { parseDockerCompose } from '../utils/dockerCompose.js';
import { getBaseRules, getCursorRules, injectManagedBlock } from '../utils/ai-rules.js';
import { readFileSafe, COMPUTE_TARGETS } from '../utils/resolvers.js';
import { parseDomainTf } from '../utils/domains.js';

// Single source of truth for the CLI version (telemetry resolver: upward
// manifest walk + env fallback). A local duplicate read here previously
// risked crashing the whole CLI at import time when the manifest path
// didn't resolve under global installs.
const CLI_VERSION = getCliVersion();

export async function mainStack(input = {}) {
    const options = normalizeOptions(input);
    const { isHeadless = false } = options;
    const isPreconfigured = options.isPreconfigured === true || process.argv.includes('--preconfigured');
    const headlessOptions = normalizeOptions(options.headlessOptions);
    const initOptions = normalizeOptions(options.initOptions);
    const isInteractive = !isHeadless && !isPreconfigured;
    const startTime = Date.now();

    // 1. Silent Pre-flight check
    const hasTerraform = await checkDependency('terraform');
    if (!hasTerraform) {
        await failCommand({
            print: () => {
                console.error(color.red('✖ Terraform is not installed.'));
                console.log(color.yellow('Please run "npx grada-run doctor" to check your environment.'));
            },
        });
    }

    if (!isHeadless) intro(color.bgCyan(color.black(' grada ☁️  ')));

    // 2. Resolve Target & Scan Codebase
    const dirConfig = await getTargetDirectory(isHeadless, headlessOptions);

    // 2b. Fail-fast validation of init composition flags — before any
    // prompts, AWS calls, backups, or file writes.
    const withList = Array.isArray(initOptions.with)
        ? initOptions.with.filter((cap) => typeof cap === 'string')
        : [];
    const unknownCaps = withList.filter((cap) => !ADDON_REGISTRY[cap]);
    if (unknownCaps.length > 0) {
        return failCommand({
            message: `\n✖ Unknown addon capabilities: ${unknownCaps.join(', ')}.`,
            hint: `  Valid capabilities: ${Object.keys(ADDON_REGISTRY).join(', ')}.\n`,
            event: 'cli-error',
            telemetry: { step: 'init_validation', error_code: 'UNSUPPORTED_CAPABILITY' },
            reason: 'unsupported-capability',
            resultExtra: { capabilities: withList },
        });
    }
    const VALID_DB_ENGINES = ['postgres', 'mysql', 'aurora-postgresql'];
    const explicitDbEngine = typeof initOptions.dbEngine === 'string' && initOptions.dbEngine.trim() !== ''
        ? initOptions.dbEngine.trim()
        : null;
    if (explicitDbEngine !== null && !VALID_DB_ENGINES.includes(explicitDbEngine)) {
        return failCommand({
            message: `\n✖ Invalid --db-engine "${explicitDbEngine}".`,
            hint: `  Valid engines: ${VALID_DB_ENGINES.join(', ')}.\n`,
            event: 'cli-error',
            telemetry: { step: 'init_validation', error_code: 'INVALID_DB_ENGINE' },
            reason: 'invalid-db-engine',
        });
    }
    const explicitTarget = typeof initOptions.target === 'string' && initOptions.target.trim() !== ''
        ? initOptions.target.trim()
        : null;
    const normalizedExplicitTarget = explicitTarget === 'fargate' ? 'ecs' : explicitTarget;
    if (explicitTarget !== null && !COMPUTE_TARGETS.includes(normalizedExplicitTarget)) {
        return failCommand({
            message: `\n✖ Invalid compute target "${explicitTarget}". Supported targets: ecs, lambda, static.`,
            hint: '  Use --target ecs (or fargate) for always-on containers, --target lambda for scale-to-zero serverless, or --target static for zero-compute S3 + CloudFront hosting.\n',
            event: 'cli-error',
            telemetry: { step: 'init_validation', error_code: 'INVALID_COMPUTE_TARGET' },
            reason: 'invalid-compute-target',
        });
    }
    const addonFlagOptions = {
        model: initOptions.model ?? undefined,
        domain: initOptions.domain ?? undefined,
        zoneId: initOptions.zoneId ?? undefined,
        fromEmail: initOptions.fromEmail ?? undefined,
    };
    for (const cap of withList) {
        // Per-capability scoped: irrelevant flags are silently ignored.
        const flagError = validateAddonFlags(cap, addonFlagOptions);
        if (flagError) {
            return failCommand({
                message: flagError.message,
                hint: flagError.hint ?? null,
                event: 'cli-error',
                telemetry: { step: 'init_validation', error_code: flagError.errorCode },
                reason: flagError.reason,
                resultExtra: { capability: cap },
            });
        }
    }
    if (withList.includes('email:ses') && !isInteractive) {
        const hasDomainFlag = typeof initOptions.domain === 'string' && initOptions.domain.trim() !== '';
        let domainTfHasDomain = false;
        if (!hasDomainFlag) {
            const domainTf = readFileSafe(path.join(dirConfig.targetDir, 'terraform', 'domain.tf'));
            domainTfHasDomain = Boolean(domainTf && parseDomainTf(domainTf)?.domain);
        }
        if (!hasDomainFlag && !domainTfHasDomain) {
            return failCommand({
                message: '\n✖ No domain for Amazon SES. Pass --domain <domain> or run from a project with terraform/domain.tf.\n',
                event: 'cli-error',
                telemetry: { step: 'init_validation', error_code: 'MISSING_SES_DOMAIN' },
                reason: 'missing-ses-domain',
                resultExtra: { capability: 'email:ses' },
            });
        }
    }

    // Compute target: explicit flag wins (headless defaults to ECS);
    // interactive runs prompt when the flag was not passed.
    let target = normalizedExplicitTarget || 'ecs';
    if (isInteractive && normalizedExplicitTarget === null) {
        log.info(`${color.gray('📖 Compare tradeoffs (cost crossover, cold starts, DB connections):')} ${color.underline('https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/architecture.md')}`);
        const targetAnswer = await select({
            message: 'Select your AWS compute target:',
            options: [
                { value: 'ecs', label: 'ECS Fargate + ALB', hint: 'Always-on, persistent DB connections, zero cold starts (Starts at ~$31/mo)' },
                { value: 'lambda', label: 'AWS Lambda + API Gateway v2', hint: 'Scale-to-zero, usage-based compute, 3-5s VPC cold starts ($0/mo idle)' },
                { value: 'static', label: 'Static site (S3 + CloudFront)', hint: 'Zero-compute hosting for SPAs/SSGs ($0/mo idle)' },
            ],
        });
        if (typeof targetAnswer === 'symbol') process.exit(0);
        target = targetAnswer;
    }

    const detectedFramework = detectFramework(dirConfig.targetDir);
    const procfile = parseProcfile(dirConfig.targetDir);
    const vercelRules = parseVercelConfig(dirConfig.targetDir);
    const dockerCompose = parseDockerCompose(dirConfig.targetDir);
    const capabilities = detectProjectCapabilities(dirConfig.targetDir);

    if (!isHeadless) {
        if (detectedFramework) log.success(`Auto-detected framework: ${detectedFramework.name}`);
        if (procfile && procfile.web) log.success(`Auto-detected Procfile (web command: ${procfile.web.join(' ')})`);
        if (vercelRules) log.success(`Auto-detected vercel.json (Migrating edge network rules)`);
        if (dockerCompose) log.success(`Auto-detected docker-compose.yml (${dockerCompose.length} services mapped)`);
    }

    if (isHeadless) console.log(color.cyan(`🤖 Running grada in headless mode`));

    // 3. Gather Configuration & Framework Quirks
    const config = await getProjectConfig(isHeadless, headlessOptions, dirConfig.targetDir, detectedFramework, { capabilities, dbEngine: explicitDbEngine, target });
    config.target = target;
    // Explicit flag wins everywhere (headless defaults to postgres, the
    // interactive prompt is skipped); anything else falls back to postgres.
    if (explicitDbEngine) {
        config.dbEngine = explicitDbEngine;
    } else if (!VALID_DB_ENGINES.includes(config.dbEngine)) {
        config.dbEngine = 'postgres';
    }
    const djangoWsgi = await resolveDjangoWsgi(dirConfig.targetDir, procfile, config.framework, isHeadless);
    const disableDefaultCI = await handleRailsCI(dirConfig.targetDir, config.framework, isHeadless);

    // 3b. Dependency-aware composition (worker, migration gate, addons).
    // Everything here resolves before backups, AWS calls, or file writes.
    const isStaticSite = config.framework === 'static';
    // Static exports (Next.js output:'export', SvelteKit adapter-static)
    // carry no server, so --target static admits them like static presets.
    // This extends only the gate — prompts.js still resolves the container
    // preset from the detected id on ecs/lambda.
    const isStaticExport = detectedFramework?.isStaticExport === true;
    if (target === 'static' && !isStaticSite && !isStaticExport) {
        return failCommand({
            message: `\n✖ --target static only supports static-site frameworks (detected: ${config.framework}).\n`,
            hint: '  Use --target ecs for containerized apps or --target lambda for scale-to-zero serverless.\n',
            event: 'cli-error',
            telemetry: { step: 'init_validation', error_code: 'STATIC_TARGET_FRAMEWORK_MISMATCH' },
            reason: 'static-target-framework-mismatch',
            resultExtra: { framework: config.framework },
        });
    }
    if (target === 'static' && (procfile?.worker || capabilities.worker.detected)) {
        log.warn(color.yellow('⚠️  Skipping the background worker: static targets serve files from S3 + CloudFront with no compute to run it on.'));
    }
    if (target === 'static' && config.needsDatabase) {
        log.warn(color.yellow('⚠️  Skipping the database: static targets have no compute to connect from. Provision data separately if the site needs an API.'));
        config.needsDatabase = false;
    }
    const failAddonResolution = (cap, resolved) => {
        if (!resolved.ok && resolved.cancelled) {
            return failCommand({
                print: () => cancel('Selection cancelled.'),
                event: 'cli-error',
                telemetry: { step: 'init_addons', reason: 'cancelled' },
                reason: 'cancelled',
                exitCode: null,
            });
        }
        return failCommand({
            message: resolved.message,
            hint: resolved.hint ?? null,
            event: 'cli-error',
            telemetry: { step: 'init_addons', error_code: resolved.errorCode },
            reason: resolved.reason,
            resultExtra: { capability: cap },
        });
    };

    // Worker command: Procfile-driven as before, plus detection-driven.
    // Lambda targets have no ECS worker service, so the prompt is skipped
    // and any Procfile worker process is left out of the generated stack.
    let workerCommandHcl = '';
    if (isInteractive && !isStaticSite && target !== 'lambda' && target !== 'static' && (procfile?.worker || capabilities.worker.detected)) {
        const workerAnswer = await promptWorkerCommand(procfile, capabilities);
        if (workerAnswer.trim() !== '') {
            workerCommandHcl = `command = ${JSON.stringify(splitProcfileCommand(workerAnswer.trim()))}`;
        }
    }
    if (target === 'lambda' && (procfile?.worker || capabilities.worker.detected)) {
        log.warn(color.yellow('⚠️  Skipping the background worker: Lambda targets run a single scale-to-zero function with no ECS worker service.'));
    }
    if (target === 'lambda' && config.needsDatabase) {
        log.warn(color.yellow('⚠️  Lambda opens a database connection per concurrent execution with no proxy in between — bursts can exhaust RDS limits. Keep pools tiny (tradeoffs: https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/architecture.md#fargate-vs-lambda-tradeoffs).'));
    }
    const willHaveWorker = target !== 'lambda' && target !== 'static' && (Boolean(procfile?.worker) || workerCommandHcl !== '');

    // Pre-deploy migration gate: explicit flag wins, else prompt.
    const migrationCmd = capabilities.migration.command;
    const setupCiMigrateFlag = initOptions.setupCiMigrate === true;
    let migrationGateEnabled = false;
    if ((target === 'lambda' || target === 'static') && (setupCiMigrateFlag || (config.needsDatabase && migrationCmd))) {
        log.warn(color.yellow(`⚠️  Skipping the pre-deploy migration gate: it runs migrations as an ephemeral ECS task, which ${target === 'static' ? 'static' : 'Lambda'} targets don't provision. Run migrations from CI against your database endpoint instead.`));
    } else if (config.needsDatabase && migrationCmd) {
        if (setupCiMigrateFlag) {
            migrationGateEnabled = true;
        } else if (isInteractive) {
            const gateAnswer = await confirm({
                message: `Enable pre-deploy database migration gate in GitHub Actions? (detected: ${migrationCmd})`,
                initialValue: true,
            });
            if (typeof gateAnswer === 'symbol') process.exit(0);
            migrationGateEnabled = gateAnswer === true;
        }
    } else if (setupCiMigrateFlag) {
        log.warn(color.yellow('⚠️  --setup-ci-migrate was passed but no database is configured or no migration command was detected; skipping the migration gate.'));
    }

    // Scheduled IaC drift detection: explicit flag wins, else offer.
    // Opt-in by default — the workflow opens GitHub Issues on its own.
    const setupCiDriftFlag = initOptions.setupCiDrift === true;
    let driftEnabled = false;
    if (setupCiDriftFlag) {
        driftEnabled = true;
    } else if (isInteractive) {
        const driftAnswer = await confirm({
            message: 'Set up scheduled IaC drift detection (daily terraform plan + GitHub Issues)?',
            initialValue: false,
        });
        if (typeof driftAnswer === 'symbol') process.exit(0);
        driftEnabled = driftAnswer === true;
    }

    // Addon selection: interactive multiselect, or explicit --with.
    let selectedAddons;
    if (isInteractive && !isStaticSite) {
        const addonOptions = Object.keys(ADDON_REGISTRY).map((cap) => {
            const entry = ADDON_REGISTRY[cap];
            const addonState = capabilities.addons[cap];
            const detected = addonState?.detected === true;
            const evidence = detected ? (addonState.evidence || []).join(', ') : '';
            const monthlyFixed = entry.cost.monthlyFixed || 0;
            const costLabel = monthlyFixed > 0 ? `~$${monthlyFixed}/mo` : '$0/mo + usage';
            return {
                value: cap,
                label: `${cap} — ${entry.label}`,
                hint: detected ? `detected: ${evidence} · ${costLabel}` : costLabel,
            };
        });
        const initialValues = Object.keys(ADDON_REGISTRY).filter((cap) =>
            withList.includes(cap) || capabilities.addons[cap]?.detected === true
        );
        const selection = await multiselect({
            message: 'Select cloud addons to scaffold (Space to toggle, Enter to confirm):',
            options: addonOptions,
            initialValues,
            required: false,
        });
        if (typeof selection === 'symbol') {
            cancel('Operation cancelled.');
            process.exit(0);
        }
        selectedAddons = Array.isArray(selection) ? selection : [];
    } else {
        selectedAddons = [...withList];
    }
    const selectedSet = new Set(selectedAddons);
    selectedAddons = Object.keys(ADDON_REGISTRY).filter((cap) => selectedSet.has(cap));

    // Resolve per-addon options (template vars, env, follow-up prompts).
    const resolvedByCap = {};
    const explicitModel = typeof initOptions.model === 'string' && initOptions.model !== '' ? initOptions.model : null;
    for (const cap of selectedAddons) {
        if (cap === 'ai:bedrock' && isInteractive && !explicitModel) {
            const useDefault = await confirm({
                message: `Use recommended Bedrock model (${DEFAULT_BEDROCK_MODEL})?`,
                initialValue: true,
            });
            if (typeof useDefault === 'symbol') process.exit(0);
            const resolved = await resolveAddonOptions(cap, {}, {
                cwd: dirConfig.targetDir, region: config.region, isInteractive: !useDefault,
            });
            if (!resolved.ok) return failAddonResolution(cap, resolved);
            resolvedByCap[cap] = resolved;
            continue;
        }
        const opts = cap === 'ai:bedrock'
            ? { model: explicitModel ?? undefined, modelProvided: explicitModel !== null }
            : cap === 'email:ses'
                ? { domain: initOptions.domain ?? undefined, zoneId: initOptions.zoneId ?? undefined, fromEmail: initOptions.fromEmail ?? undefined }
                : {};
        const resolved = await resolveAddonOptions(cap, opts, {
            cwd: dirConfig.targetDir,
            region: config.region,
            isInteractive: isInteractive && cap === 'email:ses',
        });
        if (!resolved.ok) return failAddonResolution(cap, resolved);
        resolvedByCap[cap] = resolved;
    }

    // 3.5 Docker Compose Overrides
    if (dockerCompose && dockerCompose.length > 0) {
        // Find the first service that has an exposed port
        const webService = dockerCompose.find(s => s.port);
        if (webService && webService.port) {
            // Override the config port with the one from Docker Compose
            config.port = webService.port.toString();
            if (!isHeadless) {
                console.log(color.cyan(`   🐳 Docker Compose overrides: Port set to ${config.port} via service "${webService.name}"`));
            }
        }
    }

    // 4. Framework Migration Checks (Vercel Escape Hatch)
    if ((target === 'lambda' || target === 'static') && vercelRules?.redirects?.length > 0) {
        const remedy = target === 'static'
            ? 'Recreate them as CloudFront Functions after provisioning.'
            : 'Recreate them as API Gateway routes after provisioning.';
        log.warn(color.yellow(`⚠️  vercel.json redirects were detected, but ${target === 'static' ? 'static' : 'Lambda'} targets have no ALB listener rules to translate them into. ${remedy}`));
    }

    if (config.framework === 'nestjs') {
        const nestAnalysis = analyzeNestApp(dirConfig.targetDir);
        if (nestAnalysis.hasMain && !nestAnalysis.listensOnAllInterfaces) {
            log.warn(color.yellow(`⚠️  NestJS must listen on 0.0.0.0 to receive traffic in ${target === 'lambda' ? 'AWS Lambda' : 'AWS Fargate'}.`));
            console.log(color.cyan(`   In ${nestAnalysis.filePath}, update your bootstrap:`));
            console.log(color.green(`   await app.listen(process.env.PORT ?? 3000, '0.0.0.0');\n`));
        }
    } else if (config.framework === 'nextjs') {
        const nextConfig = analyzeNextConfig(dirConfig.targetDir);
        // Static exports need no container, so the standalone warning
        // (container-image slimming) does not apply to them.
        if (nextConfig.hasConfig && !nextConfig.isStandalone && !nextConfig.isExport) {
            log.warn(color.yellow('⚠️ Next.js config is missing "output: \'standalone\'".'));
            console.log(color.cyan('   Fix it here: https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/migrations/nextjs-vercel-to-aws.md'));
        }
    } else if (detectedFramework?.id === 'svelte') {
        const svelteConfig = analyzeSvelteConfig(dirConfig.targetDir);
        if (svelteConfig.adapter === 'vercel' || svelteConfig.adapter === 'auto') {
            log.warn(color.yellow('⚠️ SvelteKit is locked into the Vercel/Auto adapter.'));
            console.log(color.cyan('   Fix it here: https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/migrations/sveltekit-vercel-to-aws.md'));
        }
    } else if (detectedFramework?.name === 'Astro') {
        const astroConfig = analyzeAstroConfig(dirConfig.targetDir);
        if (astroConfig.adapter === 'vercel') {
            log.warn(color.yellow('⚠️ Astro is locked into the Vercel adapter.'));
            console.log(color.cyan('   Fix it here: https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/migrations/astro-vercel-to-aws.md'));
        }
    }

    // 5. Calculate Derived Values
    const cpu = config.size === 'small' ? '512' : '256';
    const memory = config.size === 'small' ? '1024' : '512';
    const computeTier = config.size === 'small' ? 'Small (0.5 vCPU, 1GB RAM)' : 'Micro (0.25 vCPU, 512MB RAM)';

    const costs = estimateMonthlyCost({
        cpu: parseInt(cpu),
        memory: parseInt(memory),
        hasDb: config.needsDatabase,
        dbEngine: config.dbEngine,
        hasWorker: willHaveWorker,
        hasSecrets: target !== 'static',
        addons: selectedAddons,
        computeTarget: target,
    });
    const estimatedCost = costs.totalMonthly;
    const buildDir = detectedFramework?.buildDir || 'dist';

    // 6. Handle Backups & Provision Remote State
    await handleExistingFiles(dirConfig.targetDir, isHeadless);

    const s = spinner();
    s.start('Provisioning infrastructure...');

    let awsAccountId, stateBucketName;
    try {
        const bucketData = await provisionStateBucket(config.region, dirConfig.actualProjectName);
        awsAccountId = bucketData.awsAccountId;
        stateBucketName = bucketData.stateBucketName;
    } catch (error) {
        s.stop('❌ Failed to provision remote state or authenticate with AWS.');
        return failCommand({
            message: `AWS Error: ${error.message}`,
            useErrorStream: true,
            event: 'cli-error',
            telemetry: { step: 'aws_provisioning', error_code: error.name || 'UNKNOWN', error_message: error.message },
        });
    }

    // 7. Synthesize Templates
    s.message('Synthesizing Terraform templates...');
    await generateTemplates(dirConfig.targetDir, {
        PROJECT_NAME: dirConfig.actualProjectName,
        REGION: config.region,
        PORT: config.port,
        CPU: cpu,
        MEMORY: memory,
        COMPUTE_TIER: computeTier,
        ESTIMATED_COST: estimatedCost,
        STATE_BUCKET: stateBucketName,
        AWS_ACCOUNT_ID: awsAccountId,
        HEALTH_CHECK_PATH: config.healthCheckPath,
        DESIRED_COUNT: config.desiredCount,
        DEPLOY_BRANCH: config.branch,
        BUILD_DIR: buildDir,
        finalFramework: config.framework,
        NEEDS_DATABASE: config.needsDatabase,
        DB_ENGINE: config.dbEngine,
        DJANGO_WSGI: djangoWsgi,
        DISABLE_DEFAULT_CI: disableDefaultCI,
        PROCFILE: procfile,
        VERCEL_RULES: vercelRules,
        DOCKER_COMPOSE: dockerCompose,
        ENABLE_PR_PREVIEWS: config.enablePrPreviews,
        WORKER_COMMAND: workerCommandHcl,
        TARGET: target
    });

    // 7b. Scaffold selected addons (registry order), then wire the
    // pre-deploy migration gate into the generated workflow.
    for (const cap of selectedAddons) {
        const scaffolded = await scaffoldAddon(cap, resolvedByCap[cap], { cwd: dirConfig.targetDir, region: config.region });
        console.log(color.green(`✅ Scaffolded terraform/${scaffolded.file} (${cap})`));
    }

    if (migrationGateEnabled && migrationCmd) {
        const deployYmlPath = path.join(dirConfig.targetDir, '.github', 'workflows', 'deploy.yml');
        const workflowContent = readFileSafe(deployYmlPath);
        const gated = workflowContent ? injectMigrationGate(workflowContent, { cmd: migrationCmd }) : null;
        if (gated) {
            fsSync.writeFileSync(deployYmlPath, gated);
            console.log(color.green('✅ Wired the pre-deploy database migration gate into .github/workflows/deploy.yml'));
        } else {
            log.warn(color.yellow('⚠️  Could not wire the migration gate: the deploy workflow anchor was not found.'));
        }
    }

    if (driftEnabled) {
        const drifted = scaffoldDriftWorkflow(dirConfig.targetDir, {
            region: config.region,
            roleArn: `arn:aws:iam::${awsAccountId}:role/${dirConfig.actualProjectName}-github-actions-role`,
        });
        if (drifted.ok) {
            console.log(color.green('✅ Scaffolded .github/workflows/drift.yml (scheduled IaC drift detection)'));
        }
    }

    // 7c. Print-only stack preview when addons were scaffolded (default
    // no-addon output is untouched).
    if (selectedAddons.length > 0) {
        const parsed = parseTerraformConfig(path.join(dirConfig.targetDir, 'terraform'));
        parsed.projectName = dirConfig.actualProjectName;
        parsed.framework = detectedFramework?.name || config.framework;
        await renderDryRunPreview(parsed, true);
    }

    // 8. Telemetry
    trackEvent('project_provisioned', {
        // 1. Core & Context
        projectName: dirConfig.actualProjectName,
        cli_version: CLI_VERSION,
        is_headless: isHeadless,
        setup_mode: config.setupType,
        duration_ms: Date.now() - startTime,

        // 2. Infrastructure Shape
        target,
        framework: config.framework,
        specific_framework: detectedFramework?.name || config.framework,
        region: config.region,
        size: config.size,
        desired_count: parseInt(config.desiredCount),
        has_database: config.needsDatabase,
        db_engine: config.needsDatabase ? config.dbEngine : 'none',
        has_custom_health_check: config.healthCheckPath !== '/',

        // 3. Advanced Features & PaaS Context
        has_worker: willHaveWorker,
        is_heroku_migration: !!procfile,
        is_vercel_migration: !!vercelRules,
        is_docker_compose: !!dockerCompose,
        has_pr_previews: config.enablePrPreviews,
        ai_assistants_configured: config.aiAssistants || [],

        // 4. Dependency-aware composition
        selected_addons: selectedAddons,
        detected_addons: Object.keys(ADDON_REGISTRY).filter((cap) => capabilities.addons[cap]?.detected === true),
        migration_gate_enabled: migrationGateEnabled,
        drift_detection_enabled: driftEnabled,
    });

    s.stop('Infrastructure provisioned successfully!');

    // 8.5 Configure AI Context
    s.start('Configuring AI workspace rules...');
    const aiContext = { region: config.region, port: config.port, target: config.target };
    const cwd = dirConfig.targetDir;

    if (config.setupType === 'advanced') {
        // --- ADVANCED MODE: Explicitly respect user choices ---
        if (config.aiAssistants.includes('cursor')) {
            const cursorDir = path.join(cwd, '.cursor', 'rules');
            if (!fsSync.existsSync(cursorDir)) fsSync.mkdirSync(cursorDir, { recursive: true });
            fsSync.writeFileSync(path.join(cursorDir, 'grada.mdc'), getCursorRules(aiContext));
        }
        if (config.aiAssistants.includes('roo')) {
            const rooDir = path.join(cwd, '.roo', 'rules');
            if (!fsSync.existsSync(rooDir)) fsSync.mkdirSync(rooDir, { recursive: true });
            fsSync.writeFileSync(path.join(rooDir, 'grada.md'), getBaseRules(aiContext));
        }
        if (config.aiAssistants.includes('trae')) {
            const traeDir = path.join(cwd, '.trae', 'rules');
            if (!fsSync.existsSync(traeDir)) fsSync.mkdirSync(traeDir, { recursive: true });
            injectManagedBlock(path.join(traeDir, 'project_rules.md'), getBaseRules(aiContext), true);
        }
        if (config.aiAssistants.includes('continue')) {
            const promptsDir = path.join(cwd, '.prompts');
            if (!fsSync.existsSync(promptsDir)) fsSync.mkdirSync(promptsDir, { recursive: true });
            fsSync.writeFileSync(path.join(promptsDir, 'grada.prompt'), getBaseRules(aiContext));
        }
        if (config.aiAssistants.includes('windsurf')) {
            injectManagedBlock(path.join(cwd, '.windsurfrules'), getBaseRules(aiContext), false);
        }
        if (config.aiAssistants.includes('copilot')) {
            const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
            if (!fsSync.existsSync(path.dirname(copilotPath))) fsSync.mkdirSync(path.dirname(copilotPath), { recursive: true });
            injectManagedBlock(copilotPath, getBaseRules(aiContext), true);
        }
        if (config.aiAssistants.includes('claude')) {
            injectManagedBlock(path.join(cwd, 'CLAUDE.md'), getBaseRules(aiContext), true);
        }
        if (config.aiAssistants.includes('goose')) {
            injectManagedBlock(path.join(cwd, '.goosehints'), getBaseRules(aiContext), true);
        }
        if (config.aiAssistants.includes('aider')) {
            injectManagedBlock(path.join(cwd, '.aider.conf.yml'), getBaseRules(aiContext), false);
        }
    } else {
        // --- QUICKSTART MODE: Silent Auto-Detection ---
        if (fsSync.existsSync(path.join(cwd, '.cursor'))) {
            const cursorDir = path.join(cwd, '.cursor', 'rules');
            if (!fsSync.existsSync(cursorDir)) fsSync.mkdirSync(cursorDir, { recursive: true });
            fsSync.writeFileSync(path.join(cursorDir, 'grada.mdc'), getCursorRules(aiContext));
        }
        if (fsSync.existsSync(path.join(cwd, '.roo')) || fsSync.existsSync(path.join(cwd, '.roorules'))) {
            const rooDir = path.join(cwd, '.roo', 'rules');
            if (!fsSync.existsSync(rooDir)) fsSync.mkdirSync(rooDir, { recursive: true });
            fsSync.writeFileSync(path.join(rooDir, 'grada.md'), getBaseRules(aiContext));
        }
        if (fsSync.existsSync(path.join(cwd, '.trae'))) {
            const traeDir = path.join(cwd, '.trae', 'rules');
            if (!fsSync.existsSync(traeDir)) fsSync.mkdirSync(traeDir, { recursive: true });
            injectManagedBlock(path.join(traeDir, 'project_rules.md'), getBaseRules(aiContext), true);
        }
        if (fsSync.existsSync(path.join(cwd, '.continue')) || fsSync.existsSync(path.join(cwd, '.prompts'))) {
            const promptsDir = path.join(cwd, '.prompts');
            if (!fsSync.existsSync(promptsDir)) fsSync.mkdirSync(promptsDir, { recursive: true });
            fsSync.writeFileSync(path.join(promptsDir, 'grada.prompt'), getBaseRules(aiContext));
        }
        if (fsSync.existsSync(path.join(cwd, '.windsurf')) || fsSync.existsSync(path.join(cwd, '.windsurfrules'))) {
            injectManagedBlock(path.join(cwd, '.windsurfrules'), getBaseRules(aiContext), false);
        }

        const copilotPath = path.join(cwd, '.github', 'copilot-instructions.md');
        if (fsSync.existsSync(copilotPath)) injectManagedBlock(copilotPath, getBaseRules(aiContext), true);
        if (fsSync.existsSync(path.join(cwd, 'CLAUDE.md'))) injectManagedBlock(path.join(cwd, 'CLAUDE.md'), getBaseRules(aiContext), true);
        if (fsSync.existsSync(path.join(cwd, '.goosehints'))) injectManagedBlock(path.join(cwd, '.goosehints'), getBaseRules(aiContext), true);

        if (fsSync.existsSync(path.join(cwd, '.aider.conf.yml'))) {
            injectManagedBlock(path.join(cwd, '.aider.conf.yml'), getBaseRules(aiContext), false);
        } else if (fsSync.existsSync(path.join(cwd, '.aider.model.settings.yml'))) {
            injectManagedBlock(path.join(cwd, '.aider.model.settings.yml'), getBaseRules(aiContext), false);
        }
    }
    s.stop('AI rules configured successfully!');

    // 9. Output
    let frameworkWarnings = '';

    if (!isPreconfigured && !(config.framework === 'static' && detectedFramework?.buildDir)) {
        frameworkWarnings = getFrameworkWarning(config.framework);
    }

    // 9b. Post-init capability hints (interactive only, so headless
    // stdout stays byte-identical).
    if (isInteractive) {
        const upcoming = capabilities.upcomingHints;
        if (upcoming.vector) {
            console.log(color.dim('  💡 Vector-search dependencies detected: managed pgvector support is coming soon.'));
        }
        if (upcoming.cron) {
            console.log(color.dim('  💡 Scheduled-task dependencies detected: scaffold a schedule with "grada add cron".'));
        }
        if (upcoming.mysql) {
            console.log(color.dim('  💡 MySQL dependencies detected: RDS currently provisions PostgreSQL; MySQL support is coming soon.'));
        }
    }

    const isGitInitialized = fsSync.existsSync(path.join(dirConfig.targetDir, '.git'));
    const needsCd = dirConfig.projectName && dirConfig.projectName !== '.';
    const applyStep = needsCd ? `cd ${dirConfig.projectName} && npx --yes grada-run apply` : 'npx --yes grada-run apply';
    const gitInstructions = isGitInitialized
        ? `git add . && git commit -m "chore: add AWS infrastructure and CI/CD" && git push`
        : `git init && git add . && git commit -m "chore: add AWS infrastructure and CI/CD" && git branch -M ${config.branch} && git remote add origin https://github.com/your-username/your-repo.git && git push -u origin ${config.branch}`;

    let docsTip = '';
    if (procfile) {
        docsTip = `\n  ${color.blue('📘 Read the Heroku Migration Guide:')} ${color.underline('https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/migrations/heroku-procfile-to-aws.md')}`;
    } else if (config.needsDatabase) {
        docsTip = `\n  ${color.blue('📘 Read the Database Connections Guide:')} ${color.underline('https://github.com/grada-run/grada/blob/main/apps/docs/src/content/docs/guides/database-connections.md')}`;
    }

    outro(`${color.green('✅ Templates generated!')} ${color.blue('🛡️ DevSecOps scanning enabled.')}
    ${frameworkWarnings ? `\n  ${frameworkWarnings}` : ''}
    ${color.yellow('Next steps:')}
    1. ${color.cyan(applyStep)}
    2. ${color.cyan(gitInstructions)}
    ${color.magenta('🚀 Need help?')} ${color.underline('https://calendly.com/anton-codes-iac/15min')}`);

    await flushTelemetry();
}