// Single source of truth for third-party GitHub Action pins used by the
// generated workflows (see tests/github-workflows.test.js: every `uses:`
// in templates/github/*.yml must match this map). Bump a SHA here, run
// the workflow test to find every template site, and keep the `# tag`
// comment in sync so humans can still read the major version at a
// glance. Verified against the GitHub API; SHAs are commit SHAs, never
// tag objects.
export const ACTION_PINS = {
    'actions/checkout': { sha: '11d5960a326750d5838078e36cf38b85af677262', tag: 'v4' },
    'actions/github-script': { sha: 'f28e40c7f34bde8b3046d885e986cb6290c5673b', tag: 'v7' },
    'actions/setup-node': { sha: '49933ea5288caeca8642d1e84afbd3f7d6820020', tag: 'v4' },
    'aquasecurity/trivy-action': { sha: 'ed142fd0673e97e23eac54620cfb913e5ce36c25', tag: 'v0.36.0' },
    'aws-actions/amazon-ecr-login': { sha: '03f1aad4c6c7ffd436567f42f9384779290529bd', tag: 'v2' },
    'aws-actions/configure-aws-credentials': { sha: '7474bc4690e29a8392af63c5b98e7449536d5c3a', tag: 'v4' },
    'grada-run/grada-action': { sha: '12227808ae4caafaec1041319645586a1132fc57', tag: 'v1' },
    'hashicorp/setup-terraform': { sha: 'b9cd54a3c349d3f38e8881555d616ced269862dd', tag: 'v3' },
};

// Renders a pinned `uses:` value (`owner/name@sha # tag`) for generated
// workflow content. Throws on unknown actions — a typo must fail the
// unit suite, not ship a broken step.
export function pinnedActionUse(action) {
    const pin = ACTION_PINS[action];
    if (!pin) throw new Error(`Unknown action pin: ${action}`);
    return `${action}@${pin.sha} # ${pin.tag}`;
}
