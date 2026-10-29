# --- VPC & Networking ---
resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${local.app_name}-vpc"
  }
}

# Fetch available zones in the current region
data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# Create 2 Public Subnets
# trivy:ignore:AVD-AWS-0164 - Public subnets are used to avoid the $30/mo cost of a NAT Gateway for outbound container traffic
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${local.app_name}-public-subnet-${count.index + 1}"
  }
}

# Route internet traffic through the Gateway
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Isolated Subnets (No Internet Gateway routing). Shared by every data-plane
# subnet group (RDS, ElastiCache) so caches never need public subnets. The
# historical db_isolated address is kept deliberately: renaming would force
# subnet replacement on existing trees.
resource "aws_subnet" "db_isolated" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name = "${local.app_name}-db-isolated-${count.index}"
  }
}

# --- Security Groups ---

# Origin-facing CloudFront edge IPs: the only callers the ALB accepts.
data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

# ALB SG: Allow HTTP from CloudFront edges only (no direct internet access)
resource "aws_security_group" "alb" {
  name        = "${local.app_name}-alb-sg"
  description = "Allow inbound HTTP to ALB from CloudFront only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port = 80
    to_port   = 80
    protocol  = "tcp"
    # CloudFront-only: the origin speaks plaintext HTTP, so direct browser
    # access would bypass the CDN (and TLS on domained trees). The origin
    # secret (random_password.origin_secret) proves WHICH distribution sent
    # a request — the listener 403s anything without it. Debugging via the
    # direct URL needs both a temporary personal-IP rule and the
    # X-Grada-Origin-Secret header value from the Terraform state.
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    # trivy:ignore:AVD-AWS-0104 - Allow ALB to route out to standard AWS services
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ECS SG: Allow traffic ONLY from the ALB on the app's specific port
resource "aws_security_group" "ecs_tasks" {
  name        = "${local.app_name}-ecs-sg"
  description = "Allow inbound access from the ALB only"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = {{PORT}}
    to_port         = {{PORT}}
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port = 0
    to_port   = 0
    protocol  = "-1"
    # trivy:ignore:AVD-AWS-0104 - Allow containers to pull images and hit external APIs
    cidr_blocks = ["0.0.0.0/0"]
  }
}

{{VERCEL_EDGE_ROUTING}}