packer {
  required_version = ">= 1.9.0"
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "instance_type" {
  type    = string
  default = "t4g.micro"
}

variable "ami_name" {
  type    = string
  default = "opscoach-lab-host-{{timestamp}}"
}

source "amazon-ebs" "al2023_arm" {
  ami_name      = var.ami_name
  instance_type = var.instance_type
  region        = var.region
  ssh_username  = "ec2-user"

  source_ami_filter {
    filters = {
      name                = "al2023-ami-*-kernel-*-arm64"
      root-device-type    = "ebs"
      virtualization-type = "hvm"
    }
    owners      = ["amazon"]
    most_recent = true
  }

  tags = {
    Name     = "opscoach-lab-host"
    OpsCoach = "true"
    BuiltBy  = "packer"
  }
}

build {
  name    = "opscoach-lab-host-al2023-arm64"
  sources = ["source.amazon-ebs.al2023_arm"]

  provisioner "shell" {
    script = "${path.root}/scripts/install-docker.sh"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/install-fail2ban.sh"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/ssh-hardening.sh"
  }
}
