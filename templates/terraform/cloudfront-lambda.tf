# Fetch the AWS Managed Cache Policy (Optimized for standard web traffic)
data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# Fetch the AWS Managed Origin Request Policy (Passes query strings/cookies to your app)
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerExceptHostHeader"
}

# trivy:ignore:AVD-AWS-0011 - WAF is omitted by default to prevent unexpected monthly costs for users
resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  is_ipv6_enabled     = true
  wait_for_deployment = false # Prevents Terraform from hanging for 10+ minutes

  origin {
    # Point the CDN at the API Gateway HTTP API provisioned in main.tf
    domain_name = replace(aws_apigatewayv2_api.main.api_endpoint, "https://", "")
    origin_id   = "ApiGatewayOrigin"

    custom_origin_config {
      http_port  = 80
      https_port = 443
      # API Gateway HTTP API endpoints are HTTPS-only
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    # Allow all HTTP methods so API POST/PUT requests still work
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "ApiGatewayOrigin"

    viewer_protocol_policy = "redirect-to-https"

    # Attach the Managed Policies
    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # Gives the user a free HTTPS *.cloudfront.net domain out of the box
    cloudfront_default_certificate = true
  }
}

output "cloudfront_url" {
  description = "Your globally cached, HTTPS-secured application URL"
  value       = "https://${aws_cloudfront_distribution.cdn.domain_name}"
}

output "z_NEXT_STEP_REQUIRED" {
  value = <<EOT

====================================================================
🚀 INFRASTRUCTURE PROVISIONED SUCCESSFULLY!
====================================================================

Your AWS environment is ready. However, your URLs listed above will
return an error until your application code is actually deployed.

TO DEPLOY YOUR APP:
1. git add .
2. git commit -m "ci: configure grada"
3. git push origin main

Once the GitHub Action completes, your site will be live at the
CloudFront URL!
====================================================================
EOT
}
