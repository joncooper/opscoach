import * as cdk from "aws-cdk-lib";
import {
  aws_ec2 as ec2,
  aws_ecs as ecs,
  aws_elasticloadbalancingv2 as elbv2,
  aws_servicediscovery as servicediscovery,
} from "aws-cdk-lib";
import { Construct } from "constructs";

/** Props passed from mono-playground when Ops Coach stacks are wired into `platform.ts`. */
export interface PlatformRefs {
  readonly env: cdk.Environment;
  readonly vpc: ec2.IVpc;
  readonly cluster: ecs.ICluster;
  readonly alb: elbv2.IApplicationLoadBalancer;
  readonly httpsListener: elbv2.IApplicationListener;
  readonly zoneName: string;
  readonly cloudMapNamespace: servicediscovery.IPrivateDnsNamespace;
  readonly cloudMapNamespaceName: string;
}

export interface PlatformLookupConfig {
  readonly vpcId: string;
  readonly clusterName: string;
  readonly albArn: string;
  readonly albSecurityGroupId: string;
  readonly httpsListenerArn: string;
  readonly zoneName: string;
  readonly cloudMapNamespaceId: string;
  readonly cloudMapNamespaceArn: string;
  readonly cloudMapNamespaceName: string;
}

function requiredContext(scope: cdk.App, key: string): string {
  const value = scope.node.tryGetContext(key);
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required CDK context value: ${key}`);
  }
  return value.trim();
}

/** Read platform resource IDs after Dev-Network/Cluster/Edge deploy in mono-playground. */
export function loadPlatformLookup(app: cdk.App): PlatformLookupConfig {
  const envs = app.node.tryGetContext("envs") as { dev?: cdk.Environment } | undefined;
  if (!envs?.dev?.account || !envs?.dev?.region) {
    throw new Error(
      'Missing CDK context "envs.dev" with account and region (copy from mono-playground/infra/cdk.json)',
    );
  }

  return {
    vpcId: requiredContext(app, "platformVpcId"),
    clusterName: app.node.tryGetContext("platformClusterName") ?? "your-cluster",
    albArn: requiredContext(app, "platformAlbArn"),
    albSecurityGroupId: requiredContext(app, "platformAlbSecurityGroupId"),
    httpsListenerArn: requiredContext(app, "platformHttpsListenerArn"),
    zoneName: app.node.tryGetContext("dnsZoneName") ?? "ops.example.com",
    cloudMapNamespaceId: requiredContext(app, "platformCloudMapNamespaceId"),
    cloudMapNamespaceArn: requiredContext(app, "platformCloudMapNamespaceArn"),
    cloudMapNamespaceName:
      app.node.tryGetContext("platformCloudMapNamespaceName") ?? "ops.internal",
  };
}

/** Import an already-deployed platform by ID (standalone Ops Coach deploy). */
export function importPlatform(scope: Construct, lookup: PlatformLookupConfig): PlatformRefs {
  const envs = scope.node.tryGetContext("envs") as { dev: cdk.Environment };
  const env = envs.dev;

  const vpc = ec2.Vpc.fromLookup(scope, "PlatformVpc", { vpcId: lookup.vpcId });

  const defaultCloudMapNamespace = servicediscovery.PrivateDnsNamespace.fromPrivateDnsNamespaceAttributes(
    scope,
    "PlatformCloudMapNamespace",
    {
      namespaceId: lookup.cloudMapNamespaceId,
      namespaceArn: lookup.cloudMapNamespaceArn,
      namespaceName: lookup.cloudMapNamespaceName,
    },
  );

  const cluster = ecs.Cluster.fromClusterAttributes(scope, "PlatformCluster", {
    clusterName: lookup.clusterName,
    vpc,
    securityGroups: [],
    defaultCloudMapNamespace,
  });

  const alb = elbv2.ApplicationLoadBalancer.fromApplicationLoadBalancerAttributes(scope, "PlatformAlb", {
    loadBalancerArn: lookup.albArn,
    securityGroupId: lookup.albSecurityGroupId,
    // The shared ALB SG uses per-service egress allowlists (NOT allow-all). Tell CDK so
    // that allowTo(serviceSG) actually emits the ALB->task egress rule; without this CDK
    // assumes allow-all and drops the rule, so the ALB can't reach the task and ELB health
    // checks fail (ECS deployment circuit breaker then rolls the stack back).
    securityGroupAllowsAllOutbound: false,
  });

  const httpsListener = elbv2.ApplicationListener.fromApplicationListenerAttributes(scope, "PlatformHttpsListener", {
    listenerArn: lookup.httpsListenerArn,
    securityGroup: alb.connections.securityGroups[0],
  });

  return {
    env,
    vpc,
    cluster,
    alb,
    httpsListener,
    zoneName: lookup.zoneName,
    cloudMapNamespace: defaultCloudMapNamespace,
    cloudMapNamespaceName: lookup.cloudMapNamespaceName,
  };
}
