# Base image build.
variable "region" {
  type    = string
  default = "us-east-1"
}

source "amazon-ebs" "base" {
  region = var.region
}
