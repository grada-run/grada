---
title: Troubleshooting AWS Credentials & Authentication
description: Troubleshooting AWS authentication, expired tokens, and SSO logins.
sidebar:
  order: 9
---

`grada` interacts directly with AWS APIs (Secrets Manager, ECS, CloudWatch, S3) using the official AWS SDK v3 default credential provider chain.

When you encounter an `UnrecognizedClientException` or `ExpiredTokenException`, your local AWS authentication state has lapsed. Every command reports this identically: it stops its spinner, suggests `aws sso login` or `aws configure`, links back to this guide, and exits 1.

If the message instead says the AWS CLI was not found, install it first ([install guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)), then refresh your credentials as below.

---

## 1. Quick Refresh by Setup Type

### A. AWS IAM Identity Center (AWS SSO)
If your organization or personal account uses IAM Identity Center / SSO:

```bash
# Log in to refresh your active session token
aws sso login
```

If you use named profiles:
```bash
aws sso login --profile your-profile-name
export AWS_PROFILE=your-profile-name
```

---

### B. Standard Long-Lived Access Keys (`~/.aws/credentials`)
If you use long-lived `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` pairs:

1. Verify credentials configured:
   ```bash
   aws sts get-caller-identity
   ```
2. If invalid or missing:
   ```bash
   aws configure
   ```

---

### C. Temporary Session Tokens (`AWS_SESSION_TOKEN`)
If you assumed an IAM role or exported manual session tokens in your terminal:

Check if stale environment variables are overriding your global credentials:
```bash
echo $AWS_SESSION_TOKEN
```
If expired, clear them:
```bash
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
```
Then re-authenticate via `aws configure` or `aws sso login`.

---

### D. CI (GitHub Actions)
If a workflow fails with `ExpiredTokenException`, the job's credentials were never configured or the step ordering dropped them. Use OIDC — no long-lived keys:

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::<account-id>:role/<role-name>
    aws-region: us-east-2
```

---

## 2. Verify the fix

Run `npx grada-run doctor` — the `AWS Credentials` line should turn green. If it stays red, re-check for stale `AWS_*` environment overrides (section C) or an `AWS_PROFILE` pointing at an unconfigured profile.

## 3. Common Error References

| Error Name | Root Cause | Solution |
| :--- | :--- | :--- |
| `UnrecognizedClientException` | The security token is unrecognized, mistyped, or expired. | Run `aws sso login` or re-run `aws configure`. |
| `ExpiredTokenException` | Temporary STS credentials passed their validity window (typically 1–12 hrs). | Refresh STS credentials or log into SSO again. |
| `AccessDeniedException` | User or role lacks IAM permissions for ECS, Secrets Manager, or S3. | Ensure your IAM user has adequate deployment permissions. |
| `ResourceNotFoundException` | Target cluster, secret, or log group does not exist in target region. | Verify `AWS_REGION` and ensure infrastructure was provisioned via `grada apply`. |