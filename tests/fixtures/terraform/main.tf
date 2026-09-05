# Storage stack for the service.
# Managed by platform team.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "5.31.0"
    }
  }
}

provider "aws" {
  region = var.region
}

# Where every artifact lands.
resource "aws_s3_bucket" "artifacts" {
  bucket = "artifacts-${var.env}"
  tags   = local.common_tags
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.readonly.json

  depends_on = [aws_s3_bucket.artifacts]
}

data "aws_iam_policy_document" "readonly" {
  statement {
    actions   = ["s3:GetObject"]
    resources = [aws_s3_bucket.artifacts.arn]
  }
}

module "vpc" {
  source = "./modules/vpc"

  name        = var.env
  bucket_name = aws_s3_bucket.artifacts.bucket
}

variable "env" {
  description = "Deployment environment."
  type        = string
  default     = "dev"
}

variable "region" {
  type = string
}

locals {
  common_tags = {
    env = var.env
  }
  bucket_arn = aws_s3_bucket.artifacts.arn
}

# The public bucket name.
output "bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "vpc_id" {
  value = module.vpc.id
}
