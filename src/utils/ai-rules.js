import fsSync from 'fs';

// Per-target architecture lines so generated rules describe the actual
// topology instead of hardcoding ECS. Unknown/legacy contexts fall back
// to the ECS description.
export const ARCHITECTURE_BY_TARGET = {
    ecs: [
        'The infrastructure is an AWS ECS Fargate cluster.',
        'It uses an Application Load Balancer (ALB).',
        'CI/CD is handled securely via GitHub Actions OIDC (no long-lived IAM keys).',
        'Preview environments (Ephemeral PRs) are managed via Terraform Workspaces.',
    ],
    lambda: [
        'The infrastructure is a scale-to-zero AWS Lambda function (container image via the Lambda Web Adapter).',
        'It is fronted by an API Gateway HTTP API and CloudFront.',
        'CI/CD is handled securely via GitHub Actions OIDC (no long-lived IAM keys).',
        'There are no ECS services to scale, shell into, or roll back.',
    ],
    static: [
        'The infrastructure is zero-compute: pre-built assets on S3 fronted by CloudFront.',
        'There is no container, VPC, database, or secrets vault.',
        'Deploys sync the build output directory to the site bucket.',
    ],
};

export const getBaseRules = (context = {}) => {
    const target = Object.hasOwn(ARCHITECTURE_BY_TARGET, context.target) ? context.target : 'ecs';
    const architectureLines = ARCHITECTURE_BY_TARGET[target].map((line) => `   - ${line}`).join('\n');
    return `
# Grada Infrastructure Context

This project's AWS infrastructure is managed strictly by the \`grada\` CLI.
**DO NOT** generate custom Terraform, AWS CloudFormation, or raw AWS CLI commands to deploy this application or modify the architecture.

### Standard Operating Procedures

1. **Applying Changes:** If the user asks to deploy, provision, or update the infrastructure, instruct them to run:
   \`npx grada-run apply\`

2. **Environment Variables:** If the user asks to add an environment variable, or you modify \`.env\`, you MUST explicitly remind the user to run \`npx grada-run secrets audit\` and then \`npx grada-run secrets push <path-to-env-file>\` to sync the secret to AWS.

3. **Teardown:** If the user wants to destroy the AWS environment, instruct them to run:
   \`npx grada-run destroy\`

4. **Terraform Validation:** When you modify any \`.tf\` file, you MUST automatically run \`terraform validate\` to ensure syntax correctness.

5. **Infrastructure Sync:** If you modify a \`package.json\` build script or framework output directory, remind the user to run \`npx grada-run apply\` if the infrastructure needs to be updated.

6. **Architecture Details:**
   - **AWS Region:** \`${context.region || 'Unknown (Check terraform/main.tf)'}\`
   - **Container Port:** \`${context.port || 'Unknown'}\`
   - **Compute Target:** \`${target}\`
${architectureLines}
`;
};

export const getCursorRules = (context = {}) => `---
description: "Rules for deploying the application and managing AWS infrastructure"
globs: ["terraform/*.tf", ".github/workflows/*.yml", "Dockerfile"]
---${getBaseRules(context)}`;

export function injectManagedBlock(filePath, content, isMarkdown = true) {
    const beginMarker = isMarkdown ? '<!-- BEGIN GRADA CONTEXT -->' : '# BEGIN GRADA CONTEXT';
    const endMarker = isMarkdown ? '<!-- END GRADA CONTEXT -->' : '# END GRADA CONTEXT';
    const legacyBeginMarker = isMarkdown ? '<!-- BEGIN DEPLOY-STACK CONTEXT -->' : '# BEGIN DEPLOY-STACK CONTEXT';
    const legacyEndMarker = isMarkdown ? '<!-- END DEPLOY-STACK CONTEXT -->' : '# END DEPLOY-STACK CONTEXT';
    const block = `\n${beginMarker}\n${content.trim()}\n${endMarker}\n`;

    if (fsSync.existsSync(filePath)) {
        let fileContent = fsSync.readFileSync(filePath, 'utf8');
        // Replace an existing block in either brand variant so re-runs
        // refresh legacy files instead of appending a duplicate block.
        // (Markers carry no regex metacharacters, so direct interpolation
        // is safe.)
        const regex = new RegExp(`\\n?(?:${beginMarker}|${legacyBeginMarker})[\\s\\S]*?(?:${endMarker}|${legacyEndMarker})\\n?`);

        if (regex.test(fileContent)) {
            fileContent = fileContent.replace(regex, block); // Replace our old rules
        } else {
            fileContent = fileContent.trim() + '\n' + block; // Append to bottom
        }
        fsSync.writeFileSync(filePath, fileContent);
    } else {
        // File doesn't exist, create it cleanly
        fsSync.writeFileSync(filePath, block.trim() + '\n');
    }
}