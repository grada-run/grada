import { ECRClient, DescribeRepositoriesCommand, DescribeImagesCommand, BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, DeleteLogGroupCommand } from '@aws-sdk/client-cloudwatch-logs';
import { EC2Client, DescribeAddressesCommand, ReleaseAddressCommand } from '@aws-sdk/client-ec2';
import color from 'picocolors';
import { intro, outro, confirm, spinner, cancel } from '@clack/prompts';
import { trackEvent, flushTelemetry, trackSuccess, trackFailure } from '../core/telemetry.js';
import { parseFlags, normalizeOptions, normalizeArgv } from '../utils/args.js';
import { resolveRegion, resolveProjectName, resolveCwd, isComputeTarget } from '../utils/resolvers.js';
import { resolveClient } from '../utils/aws.js';
import { failProjectNotInitialized } from '../utils/command.js';

export const CONFIRM_MESSAGE = 'Are you sure you want to permanently delete these orphaned resources? (y/N)';

export function parseGcArgs(argv = []) {
    const args = normalizeArgv(argv);
    if (args[0] === 'gc') args.shift();
    // NOTE: intentionally no --yes flag. Deletion always requires
    // explicit interactive confirmation to prevent CI accidents.
    const { options } = parseFlags(args, { string: ['region', 'project-name'] });
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

function matchesProjectRepo(repositoryName, projectName) {
    return typeof repositoryName === 'string' && repositoryName.startsWith(`${projectName}-`);
}

export async function discoverOrphanedResources({ ecrClient, logsClient, ec2Client, projectName, logGroupPrefix, excludeLogGroup }) {
    const untaggedImages = [];
    const orphanedLogGroups = [];
    const unattachedEips = [];

    // Target 1: untagged ECR images in project-prefixed repos.
    // Both DescribeRepositories and DescribeImages are paginated.
    const repositories = [];
    let reposNextToken;
    do {
        const reposResp = await ecrClient.send(new DescribeRepositoriesCommand({ nextToken: reposNextToken }));
        for (const repo of reposResp.repositories || []) {
            if (matchesProjectRepo(repo.repositoryName, projectName)) repositories.push(repo);
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

    // Target 2: orphaned CloudWatch log groups for deleted preview environments.
    // The live service log group is `/ecs/<project>` (Lambda: `/aws/lambda/<project>-fn`,
    // no trailing dash after the project name); preview leftovers carry a
    // `-pr-*` suffix, so a prefix scan isolates candidates.
    const groupPrefix = logGroupPrefix || `/ecs/${projectName}-`;
    let nextToken;
    do {
        const logsResp = await logsClient.send(
            new DescribeLogGroupsCommand({ logGroupNamePrefix: groupPrefix, nextToken })
        );
        for (const group of logsResp.logGroups || []) {
            // The Lambda live group (`/aws/lambda/<project>-fn`) matches the
            // preview prefix scan, so it is excluded explicitly — it must
            // never be proposed for deletion.
            if (group.logGroupName && group.logGroupName !== excludeLogGroup) {
                orphanedLogGroups.push({ logGroupName: group.logGroupName, storedBytes: group.storedBytes });
            }
        }
        nextToken = logsResp.nextToken;
    } while (nextToken);

    // Target 3: unattached Elastic IPs (hourly charge when idle).
    const addressesResp = await ec2Client.send(new DescribeAddressesCommand({}));
    for (const address of filterUnattachedAddresses(addressesResp.Addresses || [])) {
        unattachedEips.push({ PublicIp: address.PublicIp, AllocationId: address.AllocationId });
    }

    return {
        untaggedImages,
        orphanedLogGroups,
        unattachedEips,
        totalCount: untaggedImages.length + orphanedLogGroups.length + unattachedEips.length,
    };
}

export const ECR_BATCH_DELETE_LIMIT = 100;

export function chunkArray(items = [], size = ECR_BATCH_DELETE_LIMIT) {
    const chunks = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

export async function deleteDiscoveredResources({ ecrClient, logsClient, ec2Client }, discovered) {
    let deletedImages = 0;
    let deletedLogGroups = 0;
    let releasedEips = 0;

    // Group untagged images by repository for batch deletion.
    // BatchDeleteImage accepts at most 100 image IDs per request.
    const byRepo = new Map();
    for (const image of discovered.untaggedImages || []) {
        if (!byRepo.has(image.repositoryName)) byRepo.set(image.repositoryName, []);
        byRepo.get(image.repositoryName).push({ imageDigest: image.imageDigest });
    }
    for (const [repositoryName, imageIds] of byRepo) {
        for (const batch of chunkArray(imageIds, ECR_BATCH_DELETE_LIMIT)) {
            await ecrClient.send(new BatchDeleteImageCommand({ repositoryName, imageIds: batch }));
            deletedImages += batch.length;
        }
    }

    for (const group of discovered.orphanedLogGroups || []) {
        await logsClient.send(new DeleteLogGroupCommand({ logGroupName: group.logGroupName }));
        deletedLogGroups += 1;
    }

    for (const eip of discovered.unattachedEips || []) {
        await ec2Client.send(new ReleaseAddressCommand({ AllocationId: eip.AllocationId }));
        releasedEips += 1;
    }

    return { deletedImages, deletedLogGroups, releasedEips };
}

function printDiscovery(discovered) {
    console.log('');
    console.log(`  ${color.bold('Untagged ECR images:')} ${discovered.untaggedImages.length}`);
    for (const image of discovered.untaggedImages.slice(0, 10)) {
        console.log(`    ${color.dim('-')} ${image.repositoryName}@${String(image.imageDigest).slice(0, 19)}`);
    }
    if (discovered.untaggedImages.length > 10) {
        console.log(`    ${color.dim(`…and ${discovered.untaggedImages.length - 10} more`)}`);
    }
    console.log(`  ${color.bold('Orphaned log groups:')} ${discovered.orphanedLogGroups.length}`);
    for (const group of discovered.orphanedLogGroups.slice(0, 10)) {
        console.log(`    ${color.dim('-')} ${group.logGroupName}`);
    }
    if (discovered.orphanedLogGroups.length > 10) {
        console.log(`    ${color.dim(`…and ${discovered.orphanedLogGroups.length - 10} more`)}`);
    }
    console.log(`  ${color.bold('Unattached Elastic IPs:')} ${discovered.unattachedEips.length}`);
    for (const eip of discovered.unattachedEips) {
        console.log(`    ${color.dim('-')} ${eip.PublicIp || eip.AllocationId}`);
    }
    console.log('');
}

export async function runGc(input = {}) {
    const options = normalizeOptions(input);
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

    intro(color.bgCyan(color.black(' grada gc 🧹 ')));

    const s = spinner();
    s.start('Scanning for orphaned resources (dry run)...');

    let discovered;
    try {
        const isLambda = isComputeTarget(cwd, 'lambda');
        discovered = await discoverOrphanedResources({
            ecrClient,
            logsClient,
            ec2Client,
            projectName,
            logGroupPrefix: isLambda ? `/aws/lambda/${projectName}-` : undefined,
            excludeLogGroup: isLambda ? `/aws/lambda/${projectName}-fn` : undefined,
        });
    } catch (error) {
        s.stop(color.red('❌ Discovery failed.'));
        console.log(color.red(`✖ ${error?.message || error}`));
        await trackFailure('gc_run', { projectName, error_message: error?.message });
        throw error;
    }
    s.stop('Discovery complete.');

    console.log(color.bold(`\nDry run — orphaned resources for project ${color.cyan(projectName)}:`));
    printDiscovery(discovered);
    console.log(color.dim(`Total orphaned resources: ${discovered.totalCount}`));

    if (discovered.totalCount === 0) {
        outro(color.green('No orphaned resources found. ✅'));
        await trackSuccess('gc_run', { projectName, deleted: false, total: 0 });
        return { ...discovered, deleted: false };
    }

    // Safety: only a literal `true` from the interactive prompt proceeds.
    // Anything else (false, undefined, cancelled symbol) aborts deletion.
    const confirmed = await confirm({ message: color.yellow(CONFIRM_MESSAGE), initialValue: false });

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
