# App CDN cache policies: a single path-only key (Managed-CachingOptimized)
# is wrong for an app server — one slot per path gets shared by HTML docs,
# API/RSC variants, redirects, and errors, so a cacheable variant poisons
# every other viewer of that path. Each traffic class below gets its own
# key instead (BUG-82).
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# Default behavior key: query strings + cookies + router headers, so each
# page variant (search params, session, RSC/prefetch) caches independently
# and authenticated bytes never cross viewers. The header keys are harmless
# when absent — frameworks that never send them simply never vary on them.
resource "aws_cloudfront_cache_policy" "app_default" {
  name        = "${local.app_name}-app-default"
  comment     = "Per-variant app key: all query strings, cookies, and router headers"
  default_ttl = 60
  max_ttl     = 86400
  min_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "all"
    }
    headers_config {
      header_behavior = "whitelist"
      headers {
        items = ["RSC", "Next-Router-State-Tree", "Next-Router-Prefetch", "Next-Url"]
      }
    }
    query_strings_config {
      query_string_behavior = "all"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# Framework build assets are content-hashed: path-only key, immutable TTL.
resource "aws_cloudfront_cache_policy" "app_static" {
  name        = "${local.app_name}-app-static"
  comment     = "Content-hashed framework assets: immutable, long TTL"
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
    enable_accept_encoding_brotli = true
    enable_accept_encoding_gzip   = true
  }
}

# Fetch the AWS Managed Origin Request Policy (Passes query strings/cookies to your app)
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewerExceptHostHeader"
}

# Managed security headers (HSTS, frame/clickjacking guards, content-type
# sniffing) on every behavior (BUG-92).
data "aws_cloudfront_response_headers_policy" "security" {
  name = "Managed-SecurityHeadersPolicy"
}

# trivy:ignore:AVD-AWS-0011 - WAF is omitted by default to prevent unexpected monthly costs for users
resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${local.app_name}-cdn"
  price_class         = "PriceClass_100"
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

  ordered_cache_behavior {
    path_pattern     = "/api/*"
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "ApiGatewayOrigin"

    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern     = "/_next/static/*"
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "ApiGatewayOrigin"

    viewer_protocol_policy = "redirect-to-https"

    cache_policy_id            = aws_cloudfront_cache_policy.app_static.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  default_cache_behavior {
    # Allow all HTTP methods so API POST/PUT requests still work
    allowed_methods  = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "ApiGatewayOrigin"

    viewer_protocol_policy = "redirect-to-https"

    # Per-variant app key + full-variance origin forwarding
    cache_policy_id            = aws_cloudfront_cache_policy.app_default.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  # Error TTL caps: origin error bodies pass through untouched, but cache
  # briefly so a transient 404/5xx never sticks for hours.
  custom_error_response {
    error_code            = 400
    error_caching_min_ttl = 60
  }
  custom_error_response {
    error_code            = 403
    error_caching_min_ttl = 60
  }
  custom_error_response {
    error_code            = 404
    error_caching_min_ttl = 60
  }
  custom_error_response {
    error_code            = 500
    error_caching_min_ttl = 10
  }
  custom_error_response {
    error_code            = 502
    error_caching_min_ttl = 10
  }
  custom_error_response {
    error_code            = 503
    error_caching_min_ttl = 10
  }
  custom_error_response {
    error_code            = 504
    error_caching_min_ttl = 10
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
