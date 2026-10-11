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

# --- Security Groups ---
# ALB SG: Allow public internet access on HTTP
resource "aws_security_group" "alb" {
  name        = "${local.app_name}-alb-sg"
  description = "Allow inbound HTTP to ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
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