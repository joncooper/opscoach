# AWS Lab Setup Review

This is the plan before making real AWS changes.

## Target

- Lab account: `opscoach-lab`
- Lab account ID: `210987654321`
- Management account ID: `123456789012`
- Region: `us-east-1`
- Budget alert email: `alerts@example.com`
- Monthly budget alert threshold: `$20`

## Local Machine Changes

- Add a local AWS CLI profile named `opscoach-lab-admin`.
- That profile will use your existing `platform` profile to enter the lab account through:
  - `arn:aws:iam::210987654321:role/OrganizationAccountAccessRole`

This does not create cloud resources. It just gives us a repeatable local profile for setup commands.

## Organization Safety Policy

I will add one account-wide safety policy to the `opscoach-lab` account.

Purpose: prevent accidental expensive work in this lab account.

It will block things like:

- launching EC2 virtual machines,
- creating NAT gateways,
- creating databases,
- using SageMaker, Bedrock, Redshift, OpenSearch, or similar costly services,
- buying Marketplace products,
- creating long-lived IAM access keys,
- working outside `us-east-1` for normal regional services.

It will apply only to the lab account, not your main account.

## Lab Platform Resources

I will deploy a reusable Ops Coach platform into the lab account:

- a candidate role with only the small set of permissions needed for the lab,
- a grader role that can inspect final state,
- a provisioner role for setup/reset,
- a cleanup function that removes expired lab resources,
- a nightly cleanup schedule.

The `$20` monthly budget alert will be created from the management account and filtered to the lab account.

The candidate role will use 3-hour temporary credentials.

## First Lab Scenario

I will deploy one small AWS practice scenario.

It will create intentionally flawed but cheap resources:

- one S3 bucket,
- one security group with one bad inbound rule,
- one launch template with weak settings,
- one CloudTrail trail with log validation off,
- one notification topic for an alarm,
- one IAM role with a broad policy for audit practice.

It will not launch servers, databases, NAT gateways, containers, or paid AI services.

## What the Candidate Will Do

The candidate will use the AWS CLI from the Ops Coach terminal.

They will inspect the lab resources, use provided sample JSON files where needed, make small fixes, and write findings.

They should not have to write large AWS JSON files from memory.

## Cleanup

Cleanup will run:

- before a session,
- after a session,
- nightly.

Resources will be tagged so cleanup can find them.

## What I Will Not Touch

- No changes to your main AWS account resources.
- No deployment outside `us-east-1`.
- No EC2 instances.
- No RDS databases.
- No NAT gateways.
- No SageMaker, Bedrock, Redshift, or OpenSearch.
- No Route 53 domains.
- No real candidate access until we test the role.

## Next Step

After you approve this plan, I will update the CDK code for the account-wide safety policy, then run the deploy commands against the lab account.
