import { ListTaskDefinitionsCommand } from '@aws-sdk/client-ecs';

// Target-agnostic rollback candidate discovery (the reuse seam for a
// future native lambda ECR-tag adapter). Adapters feed revision ARNs;
// the flow — newest-first filter, headless-newest pick, interactive
// cap — is shared. Case-B callers pass an adapter; ECS callers build
// one with createEcsRevisionAdapter.
//
// Adapter shape: `{ listRevisionArns(family) => Promise<string[]> }`.
// A lambda adapter would list ECR image tags newest-first instead.

export const INTERACTIVE_CANDIDATE_LIMIT = 5;

export function parseEcsRevisionFromArn(arn) {
    return Number(String(arn).split(':').pop());
}

// Keeps revisions strictly older than the deployed one, preserving the
// adapter's newest-first order. Pure over the ARN list.
export function filterEligibleRevisions(arns, currentRevNum, parseRevision = parseEcsRevisionFromArn) {
    return (arns || []).filter((arn) => parseRevision(arn) < currentRevNum);
}

export async function discoverEligibleRevisions(adapter, family, currentRevNum) {
    const arns = await adapter.listRevisionArns(family);
    return filterEligibleRevisions(arns, currentRevNum);
}

// Headless selection: the newest eligible revision, or null when empty.
export function pickNewestEligible(eligibleArns) {
    return eligibleArns.length > 0 ? eligibleArns[0] : null;
}

export function createEcsRevisionAdapter(ecsClient) {
    return {
        listRevisionArns: async (family) => {
            const listResp = await ecsClient.send(new ListTaskDefinitionsCommand({
                familyPrefix: family,
                status: 'ACTIVE',
                sort: 'DESC',
                maxResults: 10,
            }));
            return listResp.taskDefinitionArns || [];
        },
    };
}
