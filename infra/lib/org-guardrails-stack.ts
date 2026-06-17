import * as cdk from "aws-cdk-lib";
import { aws_budgets as budgets, aws_organizations as organizations } from "aws-cdk-lib";
import { Construct } from "constructs";
import { OpsCoachAwsConfig } from "./config";

export interface OpsCoachOrgGuardrailsStackProps extends cdk.StackProps {
  readonly config: OpsCoachAwsConfig;
}

export class OpsCoachOrgGuardrailsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpsCoachOrgGuardrailsStackProps) {
    super(scope, id, props);

    const { config } = props;
    const policyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "DenyRegionalCostRiskOutsideAllowedRegion",
          Effect: "Deny",
          Action: [
            "ec2:*",
            "rds:*",
            "eks:*",
            "ecs:*",
            "elasticloadbalancing:*",
            "elasticache:*",
            "es:*",
            "aoss:*",
            "redshift:*",
            "sagemaker:*",
            "bedrock:*",
            "lightsail:*",
          ],
          Resource: "*",
          Condition: {
            StringNotEquals: {
              "aws:RequestedRegion": config.allowedRegion,
            },
          },
        },
        {
          Sid: "DenyExpensiveComputeAndNetworking",
          Effect: "Deny",
          Action: [
            "ec2:RunInstances",
            "ec2:CreateNatGateway",
            "ec2:CreateClientVpnEndpoint",
            "ec2:CreateVpcEndpoint",
            "ec2:AllocateAddress",
            "ec2:CreateVolume",
            "ec2:CreateTransitGateway",
            "ec2:CreateTransitGatewayVpcAttachment",
            "elasticloadbalancing:*",
            "autoscaling:*",
            "ecs:*",
            "eks:*",
            "lightsail:*",
          ],
          Resource: "*",
        },
        {
          Sid: "DenyManagedDataAndAnalyticsServices",
          Effect: "Deny",
          Action: [
            "rds:*",
            "dynamodb:CreateTable",
            "dynamodb:UpdateTable",
            "elasticache:*",
            "redshift:*",
            "es:*",
            "aoss:*",
            "athena:StartQueryExecution",
            "glue:Create*",
            "glue:Start*",
          ],
          Resource: "*",
        },
        {
          Sid: "DenyAiAndMarketplaceSpend",
          Effect: "Deny",
          Action: [
            "bedrock:*",
            "sagemaker:*",
            "aws-marketplace:*",
            "aws-marketplace-management:*",
            "aws-marketplace:Subscribe",
          ],
          Resource: "*",
        },
        {
          Sid: "DenyLongLivedCredentialsAndDomains",
          Effect: "Deny",
          Action: [
            "iam:CreateAccessKey",
            "iam:UpdateAccessKey",
            "route53domains:*",
            "cloudfront:*",
          ],
          Resource: "*",
        },
      ],
    };

    const policy = new organizations.CfnPolicy(this, "CostControlScp", {
      name: "OpsCoachLabCostControl",
      description: `Cost and risk guardrails for Ops Coach lab account ${config.labAccountId}.`,
      type: "SERVICE_CONTROL_POLICY",
      content: policyDocument,
      targetIds: [config.labAccountId],
    });

    new cdk.CfnOutput(this, "CostControlPolicyId", { value: policy.ref });
    new cdk.CfnOutput(this, "GuardrailedLabAccountId", { value: config.labAccountId });
    new cdk.CfnOutput(this, "AllowedRegion", { value: config.allowedRegion });

    if (config.notificationEmail) {
      new budgets.CfnBudget(this, "LinkedAccountMonthlySafetyBudget", {
        budget: {
          budgetName: "OpsCoachLabMonthlySafetyBudget",
          budgetType: "COST",
          timeUnit: "MONTHLY",
          budgetLimit: {
            amount: config.budgetLimitUsd,
            unit: "USD",
          },
          costFilters: {
            LinkedAccount: [config.labAccountId],
          },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "ACTUAL",
              threshold: 80,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [
              {
                address: config.notificationEmail,
                subscriptionType: "EMAIL",
              },
            ],
          },
          {
            notification: {
              comparisonOperator: "GREATER_THAN",
              notificationType: "FORECASTED",
              threshold: 100,
              thresholdType: "PERCENTAGE",
            },
            subscribers: [
              {
                address: config.notificationEmail,
                subscriptionType: "EMAIL",
              },
            ],
          },
        ],
      });

      new cdk.CfnOutput(this, "BudgetName", { value: "OpsCoachLabMonthlySafetyBudget" });
    }
  }
}
