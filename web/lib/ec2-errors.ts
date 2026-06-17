export function formatEc2Error(error: unknown): string {
  if (!error || typeof error !== "object") {
    return error instanceof Error ? error.message : String(error);
  }
  const record = error as {
    name?: string;
    message?: string;
    Code?: string;
    Error?: { Code?: string; Message?: string };
  };
  const code = record.name || record.Code || record.Error?.Code;
  const message = record.message || record.Error?.Message;
  if (code && message) {
    return `${code}: ${message}`;
  }
  if (message) {
    return message;
  }
  return error instanceof Error ? error.message : "Unknown EC2 error";
}

export function validateLabEc2Environment(): void {
  const launchTemplateId = process.env.EC2_LAUNCH_TEMPLATE_ID?.trim();
  if (!launchTemplateId) {
    throw new Error(
      "Lab EC2 is not configured: EC2_LAUNCH_TEMPLATE_ID is missing on the web service. Redeploy Dev-OpsCoach."
    );
  }
  const publicSubnetId = process.env.EC2_PUBLIC_SUBNET_ID?.trim();
  if (!publicSubnetId) {
    throw new Error(
      "Lab EC2 is not configured: EC2_PUBLIC_SUBNET_ID is missing on the web service. Redeploy Dev-OpsCoach with a public subnet."
    );
  }
  const region = process.env.AWS_REGION ?? process.env.OPSCOACH_REGION;
  if (!region) {
    throw new Error(
      "Lab EC2 region is not configured: set AWS_REGION or OPSCOACH_REGION on the web service."
    );
  }
}

export function labEc2Diagnostics(): {
  mockEc2: boolean;
  launchTemplateConfigured: boolean;
  publicSubnetConfigured: boolean;
  region: string;
} {
  return {
    mockEc2: !process.env.EC2_LAUNCH_TEMPLATE_ID?.trim(),
    launchTemplateConfigured: Boolean(process.env.EC2_LAUNCH_TEMPLATE_ID?.trim()),
    publicSubnetConfigured: Boolean(process.env.EC2_PUBLIC_SUBNET_ID?.trim()),
    region: process.env.AWS_REGION ?? process.env.OPSCOACH_REGION ?? "us-east-1",
  };
}
