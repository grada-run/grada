terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    # Declared unconditionally: the conditional injection left
    # pre-existing trees without the pin when the DB arrived via
    # `add database`. Unused on DB-less trees; init installs it anyway.
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  backend "s3" {
    bucket       = "{{STATE_BUCKET}}"
    key          = "state/terraform.tfstate"
    region       = "{{REGION}}"
    encrypt      = true
    use_lockfile = true
  }
}
