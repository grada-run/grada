import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand, BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { ECSClient, ListServicesCommand } from '@aws-sdk/client-ecs';
import { EC2Client, DescribeAddressesCommand, ReleaseAddressCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import color from 'picocolors';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure, setActiveCommandName, resetActiveCommandName } from '../core/telemetry.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { resolveRegion, resolveProjectName, resolveCluster, resolveCwd, isComputeTarget, readResourceSuffix } from '../utils/resolvers.js';
import { resolveClient } from '../utils/aws.js';
import { failCommand, failProjectNotInitialized, isProgrammaticCall, refuseIfNonInteractive, refuseUnknownFlags, shouldAutoApprove } from '../utils/command.js';
import { parseStateBucketBackend } from '../utils/terraform-metadata.js';

export const CONFIRM_MESSAGE = 'Are you sure you want to permanently delete these orphaned resources? (y/N)';

export function parseGcArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'gc') args.shift();
    // --yes auto-confirms the delete prompt (explicit opt-in; the default
    // path still prompts). --deep adds the report-only deep scan.
    const { options, unknown } = parseFlags(args, {
        string: ['region', 'project-name'],
        boolean: ['deep', 'yes', 'headless'],
    });
    if (unknown.length > 0) options.unknownFlags = unknown;
    return options;
}

export function isUntaggedImageDetail(detail = {}) {
    if (Array.isArray(detail.imageTags)) return detail.imageTags.length === 0;
    if (typeof detail.imageTag === 'string') return detail.imageTag.trim().length === 0;
    if (detail.imageTag == null && detail.imageDigest) return true;
    return !detail.imageTags;
}

export function filterUntaggedImages(imageDetails = []) {
    return (imageDetails || []).filter(isUntaggedImageDetail);
}

export function isUnattachedAddress(address = {}) {
    return !address.AssociationId;
}

export function filterUnattachedAddresses(addresses = []) {
    return (addresses || []).filter(isUnattachedAddress);
}

// Project ownership tag (set by generated default_tags): gc only ever
// proposes resources whose tag value EXACTLY equals the project name.
// Prefix matching would fratricide `myapp-evil` from `myapp` in shared
// accounts; untagged resources are never proposed (report-only at most).
export const GRADA_PROJECT_TAG_KEY = 'GradaProject';

export function hasExactProjectTag(tags, projectName) {
    return Array.isArray(tags) && tags.some(
        (tag) => tag?.Key === GRADA_PROJECT_TAG_KEY && tag?.Value === projectName
    );
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Grada renders exactly one ECR repo per tree: `<project><suffix>-repo`
// (previews push tags; they never mint repos). Anything else sharing
// the prefix is foreign — never propose it.
function projectRepoName(projectName, resourceSuffix = '') {
    return `${projectName}${resourceSuffix}-repo`;
}

// Preview log groups carry the `-pr-<n>` workspace infix at a fixed
// position (`<project>-pr-<n><suffix>`); anchor both ends so foreign
// lookalikes (`myapp-evil-pr-2`) never match.
function previewLogGroupPattern({ projectName, resourceSuffix = '', isLambda = false }) {
    const base = `${escapeRegExp(projectName)}-pr-\\d+${escapeRegExp(resourceSuffix)}`;
    return isLambda ? new RegExp(`^/aws/lambda/${base}-fn$`) : new RegExp(`^/ecs/${base}$`);
}

// Standard target discovery: untagged ECR images in the project's own
// repo. Both DescribeRepositories and DescribeImages are paginated.
async function discoverUntaggedImages({ ecrClient, projectName, resourceSuffix = '' }) {
    const untaggedImages = [];
    const repositories = [];
    const ownRepo = projectRepoName(projectName, resourceSuffix);
    let reposNextToken;
    do {
        const reposResp = await ecrClient.send(new DescribeRepositoriesCommand({ nextToken: reposNextToken }));
        for (const repo of reposResp.repositories || []) {
            if (repo.repositoryName === ownRepo) repositories.push(repo);
        }
        reposNextToken = reposResp.nextToken;
    } while (reposNextToken);
    for (const repo of repositories) {
        let imagesNextToken;
        do {
            const imagesResp = await ecrClient.send(
                new DescribeImagesCommand({ repositoryName: repo.repositoryName, nextToken: imagesNextToken })
            );
            for (const detail of filterUntaggedImages(imagesResp.imageDetails || [])) {
                if (!detail.imageDigest) continue;
                untaggedImages.push({
                    repositoryName: repo.repositoryName,
                    imageDigest: detail.imageDigest,
                    imageSizeInBytes: detail.imageSizeInBytes,
                    imagePushedAt: detail.imagePushedAt,
                });
            }
            imagesNextToken = imagesResp.nextToken;
        } while (imagesNextToken);
    }
    return untaggedImages;
}

// Lambda function listing without a new SDK dependency, mirroring
// diagnose's AWS CLI usage. Throws when the CLI is missing, fails, or
// returns unparseable output — the caller treats that as unknown.
function defaultListLambdaFunctionNames({ region, spawnSyncImpl } = {}) {
    const runSync = spawnSyncImpl || spawnSync;
    const res = runSync('aws', [
        'lambda', 'list-functions',
        '--query', 'Functions[].FunctionName',
        '--output', 'json',
        ...(region ? ['--region', region] : []),
    ], { encoding: 'utf-8' });
    if (res?.status !== 0 || res?.error) {
        throw new Error(res?.error?.message || String(res?.stderr || 'aws lambda list-functions failed').trim());
    }
    const names = JSON.parse(String(res.stdout || '[]'));
    if (!Array.isArray(names)) throw new Error('unexpected list-functions output');
    return names;
}

// Log groups whose preview compute still exists: ECS services for Fargate
// trees, Lambda functions for serverless ones. Never throws — any scan
// failure resolves to `unknown` so discovery fails closed instead of
// proposing live-preview groups.
export async function discoverLivePreviewLogGroups({
    ecsClient = null,
    cluster = null,
    projectName,
    resourceSuffix = '',
    isLambda = false,
    listFunctionsImpl = defaultListLambdaFunctionNames,
    spawnSyncImpl = null,
    region = null,
} = {}) {
    const live = new Set();
    try {
        const base = `${escapeRegExp(projectName)}-pr-\\d+${escapeRegExp(resourceSuffix)}`;
        if (isLambda) {
            const fnPattern = new RegExp(`^${base}-fn$`);
            const names = await listFunctionsImpl({ region, spawnSyncImpl });
            for (const name of names || []) {
                if (typeof name === 'string' && fnPattern.test(name)) live.add(`/aws/lambda/${name}`);
            }
        } else {
            if (!ecsClient || !cluster) return { groups: live, unknown: false };
            const servicePattern = new RegExp(`^${base}-service$`);
            let nextToken;
            do {
                const resp = await ecsClient.send(new ListServicesCommand({ cluster, nextToken, maxResults: 100 }));
                for (const arn of resp.serviceArns || []) {
                    const name = String(arn).split('/').pop();
                    if (servicePattern.test(name)) live.add(`/ecs/${name.slice(0, -'-service'.length)}`);
                }
                nextToken = resp.nextToken;
            } while (nextToken);
        }
    } catch {
        return { groups: live, unknown: true };
    }
    return { groups: live, unknown: false };
}

// Standard target discovery: orphaned CloudWatch log groups for deleted
// preview environments. Candidates must match the anchored preview shape
// (foreign lookalikes rejected), must not be the live group, and must
// not belong to a still-running preview. When liveness is unknown the
// scan fails closed and proposes nothing.
async function discoverOrphanedLogGroups({
    logsClient,
    projectName,
    logGroupPrefix,
    excludeLogGroup,
    resourceSuffix = '',
    isLambda = false,
    livePreviewGroups = null,
    previewLivenessUnknown = false,
}) {
    if (previewLivenessUnknown) return [];
    const orphanedLogGroups = [];
    const groupPrefix = logGroupPrefix || `/ecs/${projectName}-`;
    const previewPattern = previewLogGroupPattern({ projectName, resourceSuffix, isLambda });
    const live = livePreviewGroups instanceof Set ? livePreviewGroups : new Set();
    let nextToken;
    do {
        const logsResp = await logsClient.send(
            new DescribeLogGroupsCommand({ logGroupNamePrefix: groupPrefix, nextToken })
        );
        for (const group of logsResp.logGroups || []) {
            const name = group.logGroupName;
            if (!name || name === excludeLogGroup) continue;
            if (!previewPattern.test(name)) continue;
            if (live.has(name)) continue;
            orphanedLogGroups.push({ logGroupName: name, storedBytes: group.storedBytes });
        }
        nextToken = logsResp.nextToken;
    } while (nextToken);
    return orphanedLogGroups;
}

// Standard target discovery: unattached Elastic IPs (hourly charge when
// idle). Tag-scoped: only addresses exactly tagged to this project are
// ever proposed — foreign and untagged EIPs stay untouched.
async function discoverUnattachedEips({ ec2Client, projectName }) {
    const unattachedEips = [];
    const addressesResp = await ec2Client.send(new DescribeAddressesCommand({}));
    for (const address of filterUnattachedAddresses(addressesResp.Addresses || [])) {
        if (!hasExactProjectTag(address.Tags, projectName)) continue;
        unattachedEips.push({ PublicIp: address.PublicIp, AllocationId: address.AllocationId });
    }
    return unattachedEips;
}

// Deep target discovery: VPCs partitioned by the STRICT deletion
// predicate — exact project tag only. Foreign and untagged VPCs land in
// reportOnly, never in deletable, so prefix lookalikes (`myapp-evil`)
// and legacy resources can never enter the deletion set.
async function discoverDeepVpcs({ ec2Client, projectName }) {
    const deletable = [];
    const reportOnly = [];
    let nextToken;
    do {
        const resp = await ec2Client.send(new DescribeVpcsCommand({ NextToken: nextToken }));
        for (const vpc of resp.Vpcs || []) {
            const entry = { kind: 'vpc', id: vpc.VpcId };
            if (hasExactProjectTag(vpc.Tags, projectName)) {
                deletable.push(entry);
            } else {
                reportOnly.push({
                    ...entry,
                    reason: Array.isArray(vpc.Tags) && vpc.Tags.length > 0 ? 'foreign-project' : 'unscoped',
                });
            }
        }
        nextToken = resp.NextToken;
    } while (nextToken);
    return { deletable, reportOnly };
}

// Deep target discovery: secrets are report-only, never deletable —
// even exact-tagged ones. Candidates are exact-tagged secrets plus
// name-prefix matches (prefix matching may feed report-only listing,
// never deletion); unrelated secrets stay out of the report.
async function discoverDeepSecrets({ secretsClient, projectName }) {
    const reportOnly = [];
    let nextToken;
    do {
        const resp = await secretsClient.send(new ListSecretsCommand({ NextToken: nextToken }));
        for (const secret of resp.SecretList || []) {
            const owned = hasExactProjectTag(secret.Tags, projectName);
            const prefixMatch = typeof secret.Name === 'string' && secret.Name.startsWith(`${projectName}-`);
            if (!owned && !prefixMatch) continue;
            reportOnly.push({
                kind: 'secret',
                id: secret.Name,
                reason: owned ? 'owned-report-only' : 'prefix-report-only',
            });
        }
        nextToken = resp.NextToken;
    } while (nextToken);
    return { deletable: [], reportOnly };
}

// Deep target discovery: the state bucket is report-only, never
// deletable — deleting state orphans every resource it maps.
async function discoverDeepStateBucket({ cwd }) {
    let backend = '';
    try {
        backend = fs.readFileSync(path.join(cwd, 'terraform', 'backend.tf'), 'utf8');
    } catch {
        return { deletable: [], reportOnly: [] };
    }
    const { bucket } = parseStateBucketBackend(backend);
    if (!bucket) return { deletable: [], reportOnly: [] };
    return {
        deletable: [],
        reportOnly: [{ kind: 'state-bucket', id: bucket, reason: 'never-auto-deleted' }],
    };
}

// GC target registry: `{id, label, scope, field?, summary?, discover,
// remove?, format?, listCap?}`. Standard targets feed the confirm/delete
// flow; deep targets (remove: null — report-only by construction) feed
// the --deep audit. Generic runners below iterate the registry so new
// targets are data, not new code paths.
export const GC_TARGETS = [
    {
        id: 'ecr-images', label: 'Untagged ECR images', scope: 'standard',
        field: 'untaggedImages', summary: 'deletedImages',
        discover: discoverUntaggedImages, remove: removeUntaggedImages,
        format: (image) => `${image.repositoryName}@${String(image.imageDigest).slice(0, 19)}`,
        listCap: 10,
    },
    {
        id: 'log-groups', label: 'Orphaned log groups', scope: 'standard',
        field: 'orphanedLogGroups', summary: 'deletedLogGroups',
        discover: discoverOrphanedLogGroups, remove: removeOrphanedLogGroups,
        format: (group) => group.logGroupName,
        listCap: 10,
    },
    {
        id: 'eips', label: 'Unattached Elastic IPs', scope: 'standard',
        field: 'unattachedEips', summary: 'releasedEips',
        discover: discoverUnattachedEips, remove: releaseUnattachedEips,
        format: (eip) => eip.PublicIp || eip.AllocationId,
        listCap: Infinity,
    },
    {
        id: 'vpcs', label: 'VPCs', kind: 'vpc', scope: 'deep',
        discover: discoverDeepVpcs, remove: null,
    },
    {
        id: 'secrets', label: 'Secrets', kind: 'secret', scope: 'deep',
        discover: discoverDeepSecrets, remove: null,
    },
    {
        id: 'state-bucket', label: 'State bucket', kind: 'state-bucket', scope: 'deep',
        discover: discoverDeepStateBucket, remove: null,
    },
];

export async function discoverOrphanedResources(ctx) {
    const discovered = {};
    for (const target of GC_TARGETS.filter((entry) => entry.scope === 'standard')) {
        discovered[target.field] = await target.discover(ctx);
    }
    discovered.totalCount = GC_TARGETS
        .filter((entry) => entry.scope === 'standard')
        .reduce((sum, entry) => sum + discovered[entry.field].length, 0);
    return discovered;
}

export async function discoverDeepOrphans(ctx) {
    const deletable = [];
    const reportOnly = [];
    for (const target of GC_TARGETS.filter((entry) => entry.scope === 'deep')) {
        const found = await target.discover(ctx);
        deletable.push(...(found.deletable || []));
        reportOnly.push(...(found.reportOnly || []));
    }
    return { deletable, reportOnly };
}

export const ECR_BATCH_DELETE_LIMIT = 100;

export function chunkArray(items = [], size = ECR_BATCH_DELETE_LIMIT) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

// Group untagged images by repository for batch deletion.
// BatchDeleteImage accepts at most 100 image IDs per request.
async function removeUntaggedImages({ ecrClient }, images) {
    let deletedImages = 0;
    const byRepo = new Map();
    for (const image of images || []) {
        if (!byRepo.has(image.repositoryName)) byRepo.set(image.repositoryName, []);
        byRepo.get(image.repositoryName).push({ imageDigest: image.imageDigest });
    }
    for (const [repositoryName, imageIds] of byRepo) {
        for (const batch of chunkArray(imageIds, ECR_BATCH_DELETE_LIMIT)) {
            await ecrClient.send(new BatchDeleteImageCommand({ repositoryName, imageIds: batch }));
            deletedImages += batch.length;
        }
    }
    return deletedImages;
}

async function removeOrphanedLogGroups({ logsClient }, groups) {
    let deletedLogGroups = 0;
    for (const group of groups || []) {
        await logsClient.send(new DeleteLogGroupCommand({ logGroupName: group.logGroupName }));
        deletedLogGroups += 1;
    }
    return deletedLogGroups;
}

async function releaseUnattachedEips({ ec2Client }, eips) {
    let releasedEips = 0;
    for (const eip of eips || []) {
        await ec2Client.send(new ReleaseAddressCommand({ AllocationId: eip.AllocationId }));
        releasedEips += 1;
    }
    return releasedEips;
}

export async function deleteDiscoveredResources(clients, discovered) {
    const summary = {};
    for (const target of GC_TARGETS.filter((entry) => entry.scope === 'standard' && typeof entry.remove === 'function')) {
        summary[target.summary] = await target.remove(clients, discovered[target.field] || []);
    }
    return summary;
}

function printDiscovery(discovered) {
    console.log('');
    for (const target of GC_TARGETS.filter((entry) => entry.scope === 'standard')) {
        const items = discovered[target.field] || [];
        console.log(`  ${color.bold(`${target.label}:`)} ${items.length}`);
        for (const item of items.slice(0, target.listCap)) {
            console.log(`    ${color.dim('-')} ${target.format(item)}`);
        }
        if (items.length > target.listCap) {
            console.log(`    ${color.dim(`…and ${items.length - target.listCap} more`)}`);
        }
    }
    console.log('');
}

function printDeepReport(deep, projectName) {
    console.log(color.bold(`\nDeep scan — tag-keyed orphans for project ${color.cyan(projectName)} (dry run, nothing deleted):`));
    console.log(`  ${color.bold('Deletion candidates (exact GradaProject tag):')} ${deep.deletable.length}`);
    for (const entry of deep.deletable) {
        console.log(`    ${color.dim('-')} ${entry.kind}/${entry.id}`);
    }
    console.log(`  ${color.bold('Report-only (never deleted by gc):')} ${deep.reportOnly.length}`);
    for (const entry of deep.reportOnly) {
        const why = entry.reason === 'unscoped'
            ? 'untagged — manual review'
            : entry.reason === 'foreign-project'
                ? 'foreign project tag'
                : entry.reason === 'owned-report-only'
                    ? 'owned — secrets are never auto-deleted'
                    : entry.reason === 'prefix-report-only'
                        ? 'name-prefix match — review before acting'
                        : 'never deleted by gc';
        console.log(`    ${color.dim('-')} ${entry.kind}/${entry.id} ${color.dim(`(${why})`)}`);
    }
    console.log('');
}

// Programmatic entry wrapper: stamps cli_command for telemetry on every
// invocation path, including direct imports that bypass bin/cli.js and MCP.
export async function runGc(input = {}) {
    setActiveCommandName('gc');
    try {
        return await runGcMain(input);
    } finally {
        resetActiveCommandName();
    }
}

async function runGcMain(input = {}) {
    const options = normalizeOptions(input);
    const unknownRefusal = await refuseUnknownFlags(options, { command: 'gc', event: 'gc_run' });
    if (unknownRefusal) return unknownRefusal;
    let cwd;
    let region;
    let projectName;
    try {
        cwd = resolveCwd(options);
        region = resolveRegion(options, cwd);
        projectName = resolveProjectName(options, cwd);
    } catch {
        return failProjectNotInitialized({ event: 'gc_run' });
    }

    const ecrClient = resolveClient(options.ecrClient, ECRClient, { region });
    const logsClient = resolveClient(options.logsClient, CloudWatchLogsClient, { region });
    const ec2Client = resolveClient(options.ec2Client, EC2Client, { region });
    const ecsClient = resolveClient(options.ecsClient, ECSClient, { region });
    const secretsClient = resolveClient(options.secretsClient, SecretsManagerClient, { region });
    const deep = options.deep === true || options.deep === 'true';

    intro(color.bgCyan(color.black(' grada gc 🧹 ')));

    const s = spinner();
    s.start('Scanning for orphaned resources (dry run)...');

    let discovered;
    let previewLivenessUnknown = false;
    try {
        const isLambda = isComputeTarget(cwd, 'lambda');
        const suffix = readResourceSuffix(cwd);
        const liveness = await discoverLivePreviewLogGroups({
            ecsClient,
            cluster: resolveCluster(options, cwd),
            projectName,
            resourceSuffix: suffix,
            isLambda,
            spawnSyncImpl: options.spawnSyncImpl,
            region,
        });
        previewLivenessUnknown = liveness.unknown;
        discovered = await discoverOrphanedResources({
            ecrClient,
            logsClient,
            ec2Client,
            projectName,
            resourceSuffix: suffix,
            isLambda,
            logGroupPrefix: isLambda ? `/aws/lambda/${projectName}-` : undefined,
            // Exact match: the live group carries the suffix on suffixed
            // trees, and proposing it for deletion would be catastrophic.
            excludeLogGroup: isLambda
                ? `/aws/lambda/${projectName}${suffix}-fn`
                : `/ecs/${projectName}${suffix}`,
            livePreviewGroups: liveness.groups,
            previewLivenessUnknown: liveness.unknown,
        });
    } catch (error) {
        s.stop(color.red('❌ Discovery failed.'));
        await trackFailure('gc_run', { projectName, error_message: error?.message });
        return failCommand({
            noExit: isProgrammaticCall(options),
            message: `✖ ${error?.message || error}`,
            hint: 'Check your AWS credentials and region, then try again.',
            resultExtra: { projectName, region },
        });
    }
    s.stop('Discovery complete.');
    if (previewLivenessUnknown) {
        console.log(color.yellow('⚠ Preview liveness could not be verified — no preview log groups will be proposed. Check credentials (ECS) / AWS CLI (Lambda) and retry.'));
    }

    console.log(color.bold(`\nDry run — orphaned resources for project ${color.cyan(projectName)}:`));
    printDiscovery(discovered);
    console.log(color.dim(`Total orphaned resources: ${discovered.totalCount}`));

    // Deep scan (opt-in): report-only audit of tag-keyed orphans (VPCs,
    // secrets, state bucket). Never prompts, never deletes — the
    // deletable partition only admits exact project tags, but even those
    // need orphan verification (a live project's VPC matches too) before
    // any future deletion acts on them.
    if (deep) {
        const ds = spinner();
        ds.start('Deep scanning tag-keyed orphans...');
        let deepResult;
        try {
            deepResult = await discoverDeepOrphans({ ec2Client, secretsClient, cwd, projectName });
        } catch (error) {
            ds.stop(color.red('❌ Deep discovery failed.'));
            await trackFailure('gc_run', { projectName, deep: true, error_message: error?.message });
            return failCommand({
                noExit: isProgrammaticCall(options),
                message: `✖ ${error?.message || error}`,
                hint: 'Check your AWS credentials and region, then try again.',
                resultExtra: { projectName, region },
            });
        }
        ds.stop('Deep discovery complete.');
        printDeepReport(deepResult, projectName);
        const deepCounts = {
            vpc_deletable: deepResult.deletable.filter((entry) => entry.kind === 'vpc').length,
            vpc_report_only: deepResult.reportOnly.filter((entry) => entry.kind === 'vpc').length,
            secret_report_only: deepResult.reportOnly.filter((entry) => entry.kind === 'secret').length,
            state_bucket_report_only: deepResult.reportOnly.filter((entry) => entry.kind === 'state-bucket').length,
        };
        trackEvent('gc_deep_report', { projectName, ...deepCounts });
        await trackSuccess('gc_run', {
            projectName,
            deleted: false,
            deep: true,
            total: discovered.totalCount,
            deep_deletable: deepResult.deletable.length,
            deep_report_only: deepResult.reportOnly.length,
        });
        outro(color.green('Deep scan complete — report only, nothing was deleted. ✅'));
        return { ...discovered, deep: deepResult, deleted: false };
    }

    if (discovered.totalCount === 0) {
        outro(color.green('No orphaned resources found. ✅'));
        await trackSuccess('gc_run', { projectName, deleted: false, total: 0 });
        return { ...discovered, deleted: false };
    }

    // Safety: only a literal `true` from the interactive prompt proceeds.
    // Anything else (false, undefined, cancelled symbol) aborts deletion.
    // --yes (or any auto-approve flag) skips the prompt explicitly.
    if (!shouldAutoApprove(options)) {
        const refused = await refuseIfNonInteractive(options, {
            message: `\n✖ gc needs confirmation before deleting orphaned resources.`,
            hint: '  Re-run with --yes to delete non-interactively.\n',
            event: 'gc_run',
            telemetry: { projectName },
            errorCode: 'GC_NON_INTERACTIVE',
        });
        if (refused) return refused;
    }
    const confirmed = shouldAutoApprove(options)
        ? true
        : await confirm({ message: color.yellow(CONFIRM_MESSAGE), initialValue: false });

    if (confirmed !== true) {
        cancel('Cancelled. No resources were deleted.');
        await trackSuccess('gc_run', { projectName, deleted: false, total: discovered.totalCount, confirmed: false });
        return { ...discovered, deleted: false, confirmed: false };
    }

    const del = spinner();
    del.start('Deleting orphaned resources...');
    const summary = await deleteDiscoveredResources({ ecrClient, logsClient, ec2Client }, discovered);
    del.stop('Deletion complete.');

    outro(color.green(`Deleted ${summary.deletedImages} image(s), ${summary.deletedLogGroups} log group(s), released ${summary.releasedEips} Elastic IP(s). ✅`));
    await trackSuccess('gc_run', { projectName, deleted: true, ...summary, total: discovered.totalCount });
    return { ...discovered, ...summary, deleted: true, confirmed: true };
}
